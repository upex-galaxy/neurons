// Finds Claude Code sessions already running in a repo, so `start` can warn that they
// may not pick up the hooks it just installed. Read-only: these processes are never
// signaled. Every failure (no ps, no lsof, no /proc) means "unknown", never an error.
//
// macOS: `ps -axo pid=,ppid=,args=` picks the candidates and
// `lsof -nP -a -p <pids> -d cwd -Fpn` gives their cwd. `lsof -c claude` alone is not
// enough: the native build runs from ~/.local/share/claude/versions/<version>, so the
// kernel's process name (what -c matches) is the version number, while argv[0] is
// "claude". Linux: /proc/<pid>/{stat,cmdline,comm,cwd}.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** argv as far as it is known (argv[0] at least). */
  argv: string[];
}

export interface SessionProc {
  pid: number;
  cwd: string;
}

/** True when argv looks like Claude Code: a `claude*` binary, or node/bun running a `claude` script. */
export function isClaudeArgv(argv: string[]): boolean {
  const a0 = path.basename(argv[0] ?? '');
  if (a0.startsWith('claude')) return true;
  if (/^(node|bun|nodejs)(\.exe)?$/.test(a0)) {
    const a1 = argv[1] ?? '';
    return path.basename(a1) === 'claude' || a1.includes('@anthropic-ai/claude-code/');
  }
  return false;
}

/**
 * Parses `ps -axo pid=,ppid=,args=`. args is split on spaces: a path with spaces in argv[0]
 * comes out cut, which only matters for apps whose name is not `claude*` anyway.
 */
export function parsePsOutput(text: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const argv = (m[3] ?? '').trim().split(/\s+/).filter((s) => s !== '');
    if (argv.length === 0) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), argv });
  }
  return procs;
}

/**
 * lsof prints each byte it does not take as printable as `\xNN`, which with a non-UTF-8
 * locale is every byte of a non-ASCII path (`c\xc3\xb3digo`). Runs of escapes of bytes
 * >= 0x80 are decoded back as UTF-8; anything else is left as printed.
 */
export function decodeLsofName(value: string): string {
  return value.replace(/(?:\\x[89a-fA-F][0-9a-fA-F])+/g, (run) => {
    const bytes = Buffer.from(run.split('\\x').slice(1).map((h) => Number.parseInt(h, 16)));
    const text = bytes.toString('utf8');
    return text.includes('\uFFFD') ? run : text;
  });
}

/**
 * Parses `lsof -F` output restricted to the cwd fd (`-d cwd -Fpn`): records `p<pid>`, then
 * `f<fd>` (optional) and `n<path>`. Returns pid -> cwd.
 */
export function parseLsofCwd(text: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | undefined;
  let fd: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = /^\d+$/.test(value) ? Number(value) : undefined;
      fd = undefined;
    } else if (tag === 'f') {
      fd = value;
    } else if (tag === 'n' && pid !== undefined && (fd === undefined || fd === 'cwd') && !result.has(pid)) {
      result.set(pid, decodeLsofName(value));
    }
  }
  return result;
}

/** `pid`, its ancestors and its descendants, from a process table. */
export function processTree(procs: ProcInfo[], pid: number): Set<number> {
  const parentOf = new Map(procs.map((p) => [p.pid, p.ppid]));
  const tree = new Set<number>([pid]);
  // Ancestors.
  for (let cur = parentOf.get(pid); cur !== undefined && cur > 0 && !tree.has(cur); cur = parentOf.get(cur)) tree.add(cur);
  // Descendants (the table is not ordered: repeat until stable).
  const ancestors = new Set(tree);
  ancestors.delete(pid);
  const desc = new Set<number>([pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of procs) {
      if (desc.has(p.ppid) && !desc.has(p.pid) && !ancestors.has(p.pid)) {
        desc.add(p.pid);
        changed = true;
      }
    }
  }
  for (const d of desc) tree.add(d);
  return tree;
}

function realpathOr(p: string, realpath: (p: string) => string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/** True when `dir` is `root` or inside it. Both are compared by real path (/tmp vs /private/tmp). */
export function isInside(dir: string, root: string, realpath: (p: string) => string = fs.realpathSync): boolean {
  const d = realpathOr(dir, realpath);
  const r = realpathOr(root, realpath);
  if (d === r) return true;
  const rel = path.relative(r, d);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The Claude Code sessions whose cwd is inside `repoRoot`, leaving out `exclude` (our own
 * process tree). `cwds` maps pid -> cwd; `procs` says which pids are Claude Code.
 */
export function sessionsInRepo(
  procs: ProcInfo[],
  cwds: Map<number, string>,
  repoRoot: string,
  exclude: Set<number>,
  realpath: (p: string) => string = fs.realpathSync,
): SessionProc[] {
  const found: SessionProc[] = [];
  for (const p of procs) {
    if (exclude.has(p.pid) || !isClaudeArgv(p.argv)) continue;
    const cwd = cwds.get(p.pid);
    if (cwd !== undefined && isInside(cwd, repoRoot, realpath)) found.push({ pid: p.pid, cwd });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

// ---------------------------------------------------------------- runners

/** Runs a command without a shell; resolves stdout (also on a non-zero exit), undefined when it cannot run. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string | undefined>;

export const runCommand: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    try {
      // A UTF-8 locale makes lsof print non-ASCII paths as they are (see decodeLsofName).
      const env = { ...process.env, LC_ALL: 'en_US.UTF-8' };
      execFile(cmd, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env }, (e, stdout) => {
        // lsof exits 1 when some of the requested pids are gone: its output is still good.
        if (e && (typeof stdout !== 'string' || stdout === '')) resolve(undefined);
        else resolve(stdout);
      });
    } catch {
      resolve(undefined);
    }
  });

async function scanDarwin(repoRoot: string, selfPid: number, run: CommandRunner, realpath: (p: string) => string): Promise<SessionProc[] | undefined> {
  const ps = await run('ps', ['-axo', 'pid=,ppid=,args=']);
  if (ps === undefined) return undefined;
  const procs = parsePsOutput(ps);
  const exclude = processTree(procs, selfPid);
  const candidates = procs.filter((p) => !exclude.has(p.pid) && isClaudeArgv(p.argv));
  if (candidates.length === 0) return [];
  const lsof = await run('lsof', ['-nP', '-a', '-p', candidates.map((p) => p.pid).join(','), '-d', 'cwd', '-Fpn']);
  if (lsof === undefined) return undefined;
  return sessionsInRepo(candidates, parseLsofCwd(lsof), repoRoot, exclude, realpath);
}

function scanLinux(repoRoot: string, selfPid: number, procDir = '/proc'): SessionProc[] | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(procDir).filter((e) => /^\d+$/.test(e));
  } catch {
    return undefined;
  }
  const procs: ProcInfo[] = [];
  const cwds = new Map<number, string>();
  for (const e of entries) {
    const pid = Number(e);
    try {
      const stat = fs.readFileSync(path.join(procDir, e, 'stat'), 'utf8');
      // "pid (comm) state ppid ...": comm may hold spaces and parens, so split after the last ")".
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const argv = fs.readFileSync(path.join(procDir, e, 'cmdline'), 'utf8').split('\0').filter((s) => s !== '');
      if (argv.length === 0) argv.push(fs.readFileSync(path.join(procDir, e, 'comm'), 'utf8').trim());
      procs.push({ pid, ppid: Number.isInteger(ppid) ? ppid : 0, argv });
      if (isClaudeArgv(argv)) cwds.set(pid, fs.readlinkSync(path.join(procDir, e, 'cwd')));
    } catch {
      /* gone, or another user's process */
    }
  }
  return sessionsInRepo(procs, cwds, repoRoot, processTree(procs, selfPid));
}

/**
 * Claude Code sessions open in `repoRoot`, outside our own process tree.
 * undefined when it cannot be known on this system.
 */
export async function findClaudeSessions(
  repoRoot: string,
  o: { run?: CommandRunner; platform?: NodeJS.Platform; selfPid?: number; procDir?: string; realpath?: (p: string) => string } = {},
): Promise<SessionProc[] | undefined> {
  const platform = o.platform ?? process.platform;
  const selfPid = o.selfPid ?? process.pid;
  try {
    if (platform === 'darwin') return await scanDarwin(repoRoot, selfPid, o.run ?? runCommand, o.realpath ?? fs.realpathSync);
    if (platform === 'linux') return scanLinux(repoRoot, selfPid, o.procDir);
  } catch {
    /* silent by design */
  }
  return undefined;
}

/** Spanish lines for `start` about the sessions found (empty when there are none). */
export function sessionWarning(sessions: SessionProc[]): string[] {
  const n = sessions.length;
  if (n === 0) return [];
  const head =
    n === 1
      ? 'Hay 1 sesión de Claude Code abierta en este repositorio (PID ' + sessions[0]?.pid + ').'
      : `Hay ${n} sesiones de Claude Code abiertas en este repositorio (PID ${sessions.map((s) => s.pid).join(', ')}).`;
  return [
    head,
    n === 1
      ? 'Puede que no lea los hooks recién instalados: si no ves eventos de esa sesión, reiniciala (/exit y después claude --continue).'
      : 'Puede que no lean los hooks recién instalados: si no ves eventos de alguna, reiniciala (/exit y después claude --continue).',
  ];
}
