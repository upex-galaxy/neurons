// Runs the built CLI (dist/cli.mjs) as a child process.
// `npm test` builds first; when run alone, beforeAll rebuilds dist/cli.mjs with
// tsdown if it is missing or older than any file under src/.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, hookUrl, isLegacyHook, isOwnHook, mergeHooks } from '../../src/install/settings.ts';
import { rerootPayloadLine } from '../helpers/payloads.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'payloads', 'run1.jsonl');

/**
 * Windows: a child process gets no catchable signal (ChildProcess.kill and process.kill are
 * TerminateProcess there), so a viewer is closed with `neu stop`, which terminates it and
 * does its cleanup in its place (docs/DECISIONS.md, W2).
 */
const WIN = process.platform === 'win32';

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
let xdgDir: string;
/** NEURONS_HOME of every run that does not pass its own: never the real ~/.neurons. */
let neuronsHome: string;

function tmp(prefix: string): string {
  // Native realpath, like the CLI: on Windows it also expands 8.3 short names (RUNNER~1).
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function newestMtime(dir: string): number {
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    max = Math.max(max, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return max;
}

beforeAll(() => {
  const built = fs.statSync(CLI, { throwIfNoEntry: false });
  if (!built || built.mtimeMs < newestMtime(path.join(ROOT, 'src'))) {
    execFileSync(path.join(ROOT, 'node_modules', '.bin', WIN ? 'tsdown.cmd' : 'tsdown'), [], { cwd: ROOT, stdio: 'ignore', shell: WIN });
  }
  xdgDir = tmp('rs-cli-xdg-');
  neuronsHome = tmp('rs-cli-nhome-');
}, 120_000);

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function gitRepo(): string {
  const repo = tmp('rs-cli-repo-');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface Run {
  child: ChildProcess;
  output(): string;
  waitFor(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** `script`: the CLI path as given to node (default: the absolute dist/cli.mjs). */
function run(args: string[], cfgDir: string, o: { cwd?: string; env?: NodeJS.ProcessEnv; script?: string } = {}): Run {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  // Windows ignores the case of variable names: an override replaces the inherited spelling
  // (ComSpec vs COMSPEC), or the child could keep the inherited value.
  if (WIN) {
    const overrides = new Set(Object.keys(o.env ?? {}).map((k) => k.toUpperCase()));
    for (const k of Object.keys(inherited)) if (overrides.has(k.toUpperCase())) delete inherited[k];
  }
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    CLAUDE_CONFIG_DIR: cfgDir,
    NEURONS_HOME: neuronsHome,
    GIT_CONFIG_GLOBAL: '/dev/null',
    XDG_CONFIG_HOME: xdgDir,
    // The messages asserted in this file are the Spanish ones.
    NEURONS_LANG: 'es',
    ...o.env,
  };
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const child = spawn(process.execPath, [o.script ?? CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], ...(o.cwd ? { cwd: o.cwd } : {}) });
  children.push(child);
  let buf = '';
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    for (const l of listeners) l();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const l of listeners) l();
      resolve({ code, signal });
    });
  });
  return {
    child,
    output: () => buf,
    exited,
    waitFor(re, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = buf.match(re);
          if (m) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(m);
          } else if (child.exitCode !== null) {
            listeners.delete(check);
            clearTimeout(timer);
            reject(new Error(`process exited before ${re}; output:\n${buf}`));
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timeout waiting for ${re}; output:\n${buf}`));
        }, ms);
        listeners.add(check);
        check();
      });
    },
  };
}

/**
 * Closes a running viewer the way its user would. macOS and Linux: the signal; the viewer
 * cleans up itself and exits 0. Windows: `neu stop <repo>` (see WIN).
 */
async function closeViewer(r: Run, repo: string, cfg: string, o: { signal?: NodeJS.Signals; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  if (!WIN) {
    r.child.kill(o.signal ?? 'SIGINT');
    expect((await r.exited).code).toBe(0);
    return;
  }
  const stop = run(['stop', repo], cfg, o.env ? { env: o.env } : {});
  const { code } = await stop.exited;
  expect(stop.output()).toContain(stoppedMessage(r.child.pid));
  expect(code).toBe(0);
  await r.exited;
}

/** What `neu stop` prints for a viewer it closed: on Windows it terminated it and cleaned up. */
function stoppedMessage(pid: number | undefined): string {
  return WIN ? `(PID ${pid}) terminado` : `(PID ${pid}) cerrado.`;
}

/** The exit of a viewer closed by `neu stop`: 0 from its own cleanup, except on Windows (terminated). */
function expectStoppedExit(exit: { code: number | null }): void {
  if (!WIN) expect(exit.code).toBe(0);
}

/**
 * A repo as `ls` and `open` list it: under the home directory as `~/...`. The temp dir is
 * under the home on Windows (AppData\Local\Temp), not on macOS or Linux.
 */
function shown(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function firstFixture(repo: string): string {
  const line = fs.readFileSync(FIXTURE, 'utf8').split('\n').find((l) => l.trim() !== '');
  return rerootPayloadLine(line ?? '{}', repo, '/Users/fake-home');
}

function ownUrls(file: string): Array<{ event: string; url: string }> {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks: unknown[] }>> };
  const out: Array<{ event: string; url: string }> = [];
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks) if (isOwnHook(h)) out.push({ event, url: (h as { url: string }).url });
  }
  return out;
}

function legacyCount(file: string): number {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks: unknown[] }>> };
  return Object.values(s.hooks ?? {}).reduce((n, groups) => n + groups.reduce((m, g) => m + g.hooks.filter(isLegacyHook).length, 0), 0);
}

/** Leaves `repo` as an install by a repo-synapse version (hooks, backup, manifest) would. */
function writeLegacyInstall(repo: string, original: string, port: number): void {
  const dir = path.join(repo, '.repo-synapse');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.local.json.bak'), original);
  fs.writeFileSync(
    path.join(dir, 'install.json'),
    JSON.stringify({ version: 1, createdFile: false, createdClaudeDir: false, backedUpAt: '2026-09-30T12:00:00.000Z', port }),
  );
  const merged = JSON.stringify(mergeHooks(JSON.parse(original) as object, port), null, 2).replaceAll('?src=neurons', '?src=repo-synapse');
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), merged + '\n');
}

const READY = /escuchando en http:\/\/127\.0\.0\.1:(\d+)/;

describe('Neurons CLI (dist/cli.mjs)', () => {
  it('has a shebang and prints --version / --help', () => {
    expect(fs.readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
    const es = { ...process.env, NEURONS_LANG: 'es' };
    expect(execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: es })).toContain('Uso:');
    expect(execFileSync(process.execPath, [CLI, '--help', '--lang', 'en'], { encoding: 'utf8', env: es })).toContain('Usage:');
    const en = { ...process.env, NEURONS_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'en_US.UTF-8' };
    expect(execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', env: en })).toContain('Usage:');
    expect(execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', env: { ...en, LANG: 'es_AR.UTF-8' } })).toContain('Uso:');
  });

  it('start installs hooks with the real port, answers 204 and cleans up on SIGINT', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const port = await freePort();
    const r = run(['start', repo, '--no-open', '--port', String(port), '--no-bash-diff'], cfg);
    const m = await r.waitFor(READY);
    const actual = Number(m[1]);
    expect(actual).toBe(port);

    const settings = path.join(repo, '.claude', 'settings.local.json');
    const own = ownUrls(settings);
    expect(own.map((o) => o.event).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(own.every((o) => o.url === hookUrl(actual))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.neurons', 'lock'))).toBe(true);
    expect(fs.existsSync(path.join(cfg, 'settings.json'))).toBe(false);

    const res = await fetch(hookUrl(actual), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: firstFixture(repo),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    await closeViewer(r, repo, cfg);
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.neurons', 'lock'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.neurons/');
  });

  it('start with bash diff toggles the user setting and restores both files byte for byte', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const userFile = path.join(cfg, 'settings.json');
    const userOriginal = '{\n\t"theme": "light",\n\t"model": "opus"\n}';
    fs.writeFileSync(userFile, userOriginal);
    const localFile = path.join(repo, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(localFile));
    const localOriginal = '{ "permissions": { "allow": [ "Bash(ls:*)" ] } }';
    fs.writeFileSync(localFile, localOriginal);

    const r = run(['start', repo, '--no-open', '--port', '0'], cfg);
    const m = await r.waitFor(READY);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf8'))).toEqual({ theme: 'light', model: 'opus', bashEditDiffEnabled: true });
    expect(ownUrls(localFile).every((o) => o.url === hookUrl(Number(m[1])))).toBe(true);

    await closeViewer(r, repo, cfg, { signal: 'SIGTERM' });
    expect(fs.readFileSync(userFile, 'utf8')).toBe(userOriginal);
    expect(fs.readFileSync(localFile, 'utf8')).toBe(localOriginal);
  });

  it('start --no-install keeps .neurons/ out of git', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-install'], cfg);
    await r.waitFor(READY);
    // Nothing was installed, so the footer promises no cleanup.
    await r.waitFor(/Ctrl\+C para salir/);
    expect(r.output()).toContain('Ctrl+C para salir.');
    expect(r.output()).not.toContain('los hooks se quitan al cerrar');
    expect(fs.existsSync(path.join(repo, '.neurons', 'events.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.neurons/');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status).not.toContain('.neurons');
    await closeViewer(r, repo, cfg);
  });

  it('a read-only .git/info/exclude does not abort start nor leave hooks behind', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    fs.chmodSync(exclude, 0o444);
    try {
      const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
      await r.waitFor(READY);
      expect(r.output()).toContain('.git/info/exclude');
      expect(ownUrls(path.join(repo, '.claude', 'settings.local.json'))).toHaveLength(HOOK_EVENTS.length);
      await closeViewer(r, repo, cfg);
      expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
    } finally {
      fs.chmodSync(exclude, 0o644);
    }
  });

  // chmod 0o555 does not make a folder read-only on Windows (docs/DECISIONS.md, W3).
  it.skipIf(WIN)('an install that throws after writing the manifest is undone on exit', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const claudeDir = path.join(repo, '.claude');
    fs.mkdirSync(claudeDir);
    const localFile = path.join(claudeDir, 'settings.local.json');
    fs.writeFileSync(localFile, '{"a":1}');
    fs.chmodSync(claudeDir, 0o555); // the atomic write of settings.local.json fails
    try {
      const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
      const { code } = await r.exited;
      expect(code).toBe(1);
      expect(r.output()).toContain('No se pudo arrancar');
    } finally {
      fs.chmodSync(claudeDir, 0o755);
    }
    expect(fs.readFileSync(localFile, 'utf8')).toBe('{"a":1}');
    expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.neurons', 'lock'))).toBe(false);
  });

  it.skipIf(WIN)('an unwritable user config dir skips bash diff instead of aborting start', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const userFile = path.join(cfg, 'settings.json');
    fs.writeFileSync(userFile, '{"a":1}');
    fs.chmodSync(cfg, 0o555);
    try {
      const r = run(['start', repo, '--no-open', '--port', '0'], cfg);
      await r.waitFor(READY);
      expect(r.output()).toContain('No se pudo activar bashEditDiffEnabled');
      r.child.kill('SIGTERM');
      expect((await r.exited).code).toBe(0);
    } finally {
      fs.chmodSync(cfg, 0o755);
    }
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(cfg)).toEqual(['settings.json']);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'user-settings.bak'))).toBe(false);
  });

  it('two viewers on different repos share bashEditDiffEnabled until the last one exits', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const userFile = path.join(cfg, 'settings.json');
    fs.writeFileSync(userFile, '{"a":1}');
    const ra = run(['start', a, '--no-open', '--port', '0'], cfg);
    await ra.waitFor(READY);
    const rb = run(['start', b, '--no-open', '--port', '0'], cfg);
    await rb.waitFor(READY);
    expect(rb.output()).toContain('otro visor');
    await closeViewer(ra, a, cfg);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf8'))).toEqual({ a: 1, bashEditDiffEnabled: true });
    await closeViewer(rb, b, cfg);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(cfg)).toEqual(['settings.json']);
  });

  it('refuses a second start on the same repo and takes over a stale lock', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const first = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    await first.waitFor(READY);
    const second = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const res = await second.exited;
    expect(res.code).toBe(1);
    expect(second.output()).toContain('Ya hay un visor de Neurons corriendo');
    await closeViewer(first, repo, cfg);

    // Stale lock + leftovers of a crashed run.
    fs.writeFileSync(path.join(repo, '.neurons', 'lock'), JSON.stringify({ pid: 2 ** 22 + 4321 }));
    execFileSync(process.execPath, [CLI, 'install', repo, '--port', '7'], {
      env: { ...process.env, NEURONS_LANG: 'es', CLAUDE_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: xdgDir },
    });
    const third = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const m = await third.waitFor(READY);
    expect(third.output()).toContain('lock viejo');
    const own = ownUrls(path.join(repo, '.claude', 'settings.local.json'));
    expect(own).toHaveLength(HOOK_EVENTS.length);
    expect(own.every((o) => o.url === hookUrl(Number(m[1])))).toBe(true);
    await closeViewer(third, repo, cfg);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('a lock whose PID was reused by an unrelated process is stale for start and doctor (F7)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    // A live process that started long after the lock was written cannot be its owner.
    const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(squatter);
    fs.mkdirSync(path.join(repo, '.neurons'));
    const lockFile = path.join(repo, '.neurons', 'lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: squatter.pid, startedAt: '2001-01-01T00:00:00.000Z' }) + '\n');

    const doctor = run(['doctor', repo], cfg);
    expect((await doctor.exited).code).toBe(0);
    expect(doctor.output()).toContain('lock viejo');
    expect(doctor.output()).not.toContain('está corriendo sobre este repo');

    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    await r.waitFor(READY);
    expect(r.output()).toContain('lock viejo');
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(r.child.pid);
    await closeViewer(r, repo, cfg);
    expect(fs.readdirSync(path.join(repo, '.neurons')).filter((f) => f.startsWith('lock'))).toEqual([]);
  });

  it('the refusal of a live lock says how to recover (F7)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const first = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    await first.waitFor(READY);
    const second = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    expect((await second.exited).code).toBe(1);
    expect(second.output()).toContain('Ya hay un visor de Neurons corriendo');
    expect(second.output()).toContain(`borrá ${path.join(repo, '.neurons', 'lock')}`);
    await closeViewer(first, repo, cfg);
  });

  it('several starts racing on a stale lock: exactly one takes it over (F8)', async () => {
    for (let round = 0; round < 3; round++) {
      const repo = gitRepo();
      const cfg = tmp('rs-cli-cfg-');
      fs.mkdirSync(path.join(repo, '.neurons'));
      const lockFile = path.join(repo, '.neurons', 'lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 4321, startedAt: '2001-01-01T00:00:00.000Z' }));
      const racers = [0, 1, 2, 3, 4].map(() => run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg));
      const settled = await Promise.all(
        racers.map((r) =>
          r.waitFor(READY, 15_000).then(
            () => 'ready' as const,
            () => 'exited' as const,
          ),
        ),
      );
      const winners = racers.filter((_, i) => settled[i] === 'ready');
      const losers = racers.filter((_, i) => settled[i] === 'exited');
      expect(winners).toHaveLength(1);
      for (const l of losers) {
        expect((await l.exited).code).toBe(1);
        expect(l.output()).toMatch(/Ya hay un visor de Neurons corriendo|otro visor de Neurons está arrancando/);
      }
      const winner = winners[0]!;
      expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(winner.child.pid);
      const port = Number(winner.output().match(READY)![1]);
      expect(ownUrls(path.join(repo, '.claude', 'settings.local.json')).every((o) => o.url === hookUrl(port))).toBe(true);
      await closeViewer(winner, repo, cfg);
      expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
      expect(fs.readdirSync(path.join(repo, '.neurons')).filter((f) => f.startsWith('lock'))).toEqual([]);
    }
  }, 60_000);

  it('install refuses while a start is live and leaves its hooks alone (F9)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const port = Number((await r.waitFor(READY))[1]);
    const settings = path.join(repo, '.claude', 'settings.local.json');
    const before = fs.readFileSync(settings, 'utf8');
    const manifest = path.join(repo, '.neurons', 'install.json');
    const manifestBefore = fs.readFileSync(manifest, 'utf8');

    const inst = run(['install', repo, '--port', '7'], cfg);
    expect((await inst.exited).code).toBe(1);
    expect(inst.output()).toContain('Neurons está corriendo');
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(manifestBefore);
    expect(ownUrls(settings).every((o) => o.url === hookUrl(port))).toBe(true);

    await closeViewer(r, repo, cfg);
  });

  // Regression (F9 follow-up): with a live `start --no-install`, install refused and claimed
  // that hooks were installed when there were none.
  it('install works while a start --no-install is live (it installed nothing)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    await r.waitFor(READY);
    const inst = run(['install', repo, '--port', '7'], cfg);
    expect((await inst.exited).code).toBe(0);
    const settings = path.join(repo, '.claude', 'settings.local.json');
    expect(ownUrls(settings).length).toBeGreaterThan(0);
    expect(ownUrls(settings).every((o) => o.url === hookUrl(7))).toBe(true);
    await closeViewer(r, repo, cfg);
    // The hooks were installed by hand, so they outlive the viewer.
    expect(ownUrls(settings).every((o) => o.url === hookUrl(7))).toBe(true);
    const un = run(['uninstall', repo], cfg);
    expect((await un.exited).code).toBe(0);
  });

  it('install and uninstall work as manual commands', () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const env = { ...process.env, NEURONS_LANG: 'es', CLAUDE_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: xdgDir };
    execFileSync(process.execPath, [CLI, 'install', repo, '--port', '7801'], { env });
    expect(ownUrls(path.join(repo, '.claude', 'settings.local.json')).every((o) => o.url === hookUrl(7801))).toBe(true);
    const out = execFileSync(process.execPath, [CLI, 'uninstall', repo], { env, encoding: 'utf8' });
    expect(out).toContain('Hooks quitados');
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('start undoes an install left by repo-synapse, keeps its log, and restores the original bytes on exit', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    fs.mkdirSync(path.join(repo, '.claude'));
    const original = '{\n\t"permissions": { "allow": ["Bash(ls:*)"] }\n}';
    writeLegacyInstall(repo, original, 7777);
    const legacyLog = path.join(repo, '.repo-synapse', 'events.jsonl');
    fs.writeFileSync(legacyLog, '{"kind":"tree"}\n');
    const settings = path.join(repo, '.claude', 'settings.local.json');

    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const port = Number((await r.waitFor(READY))[1]);
    expect(legacyCount(settings)).toBe(0);
    expect(ownUrls(settings).every((o) => o.url === hookUrl(port))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'install.json'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.neurons', 'settings.local.json.bak'), 'utf8')).toBe(original);
    await closeViewer(r, repo, cfg);
    expect(fs.readFileSync(settings, 'utf8')).toBe(original);
    expect(fs.readFileSync(legacyLog, 'utf8')).toBe('{"kind":"tree"}\n');
  });

  it('uninstall removes the hooks and the install of repo-synapse', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    fs.mkdirSync(path.join(repo, '.claude'));
    const original = '{"model":"opus"}';
    writeLegacyInstall(repo, original, 7777);
    const un = run(['uninstall', repo], cfg);
    expect((await un.exited).code).toBe(0);
    expect(un.output()).toContain('Hooks quitados');
    expect(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.repo-synapse'))).toBe(false);
  });

  it('start refuses while a repo-synapse viewer is running on the repo', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(old);
    fs.mkdirSync(path.join(repo, '.repo-synapse'));
    const legacyLock = path.join(repo, '.repo-synapse', 'lock');
    fs.writeFileSync(legacyLock, JSON.stringify({ pid: old.pid, startedAt: new Date().toISOString() }) + '\n');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    expect((await r.exited).code).toBe(1);
    expect(r.output()).toContain('La versión anterior (repo-synapse) está corriendo');
    expect(r.output()).toContain(`borrá ${legacyLock}`);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('replay of a repo prefers .neurons/events.jsonl and falls back to .repo-synapse/', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const rec = run(['start', repo, '--no-open', '--port', '0', '--no-install', '--no-bash-diff'], cfg);
    await rec.waitFor(READY);
    await closeViewer(rec, repo, cfg);
    const log = fs.readFileSync(path.join(repo, '.neurons', 'events.jsonl'));

    const replay = async (expected: string) => {
      const r = run(['replay', repo, '--no-open', '--port', '0'], cfg);
      await r.waitFor(READY);
      expect((await r.waitFor(/Registro: (.+)\n/))[1]).toBe(expected);
      r.child.kill('SIGINT');
      await r.exited;
    };
    fs.mkdirSync(path.join(repo, '.repo-synapse'));
    fs.writeFileSync(path.join(repo, '.repo-synapse', 'events.jsonl'), log);
    await replay(path.join(repo, '.neurons', 'events.jsonl'));
    fs.rmSync(path.join(repo, '.neurons'), { recursive: true });
    await replay(path.join(repo, '.repo-synapse', 'events.jsonl'));
    fs.rmSync(path.join(repo, '.repo-synapse'), { recursive: true });
    const none = run(['replay', repo, '--no-open', '--port', '0'], cfg);
    expect((await none.exited).code).toBe(1);
    expect(none.output()).toContain(`${path.join(repo, '.neurons', 'events.jsonl')} no existe`);
  });

  it('doctor runs and exits 0', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['doctor', repo], cfg);
    const { code } = await r.exited;
    expect(code).toBe(0);
    expect(r.output()).toContain('diagnóstico');
    expect(r.output()).toContain('Node');
    // The settings scope column is translated and aligned to the widest label.
    expect(r.output()).toMatch(/^ {2}usuario {7}\S/m);
    expect(r.output()).not.toMatch(/^ {2}user /m);
  });

  it('fails with a Spanish message for a missing repo', async () => {
    const r = run(['start', path.join(os.tmpdir(), 'rs-does-not-exist-xyz'), '--no-open'], tmp('rs-cli-cfg-'));
    const { code } = await r.exited;
    expect(code).toBe(1);
    expect(r.output()).toContain('No existe el directorio');
  });
});

describe('Neurons CLI: routing, repo root, sessions and the viewer registry', () => {
  /** Env for a run with its own NEURONS_HOME. */
  function homeEnv(): { NEURONS_HOME: string } {
    return { NEURONS_HOME: tmp('rs-cli-nh-') };
  }

  function registryFiles(home: string): string[] {
    try {
      return fs.readdirSync(path.join(home, 'viewers'));
    } catch {
      return [];
    }
  }

  async function finished(r: Run): Promise<{ code: number | null; out: string }> {
    const { code } = await r.exited;
    return { code, out: r.output() };
  }

  it('no command starts on the git root of the cwd; ls lists it; stop from a subdir restores the settings', async () => {
    const repo = gitRepo();
    const sub = path.join(repo, 'src');
    const cfg = tmp('rs-cli-cfg-');
    const env = homeEnv();
    const localFile = path.join(repo, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(localFile));
    const localOriginal = '{ "permissions": { "allow": [ "Bash(ls:*)" ] } }';
    fs.writeFileSync(localFile, localOriginal);

    const r = run(['--no-open', '--no-bash-diff', '--port', '0'], cfg, { cwd: sub, env });
    const port = Number((await r.waitFor(READY))[1]);
    await r.waitFor(/Ctrl\+C para salir/);
    expect(r.output()).toContain(`Usando la raíz del repositorio: ${repo}`);
    expect(r.output()).toContain(`Repositorio: ${repo}`);
    expect(r.output()).not.toContain('No es un repositorio git');
    expect(ownUrls(localFile).every((o) => o.url === hookUrl(port))).toBe(true);

    const entryFile = path.join(env.NEURONS_HOME, 'viewers', `${r.child.pid}.json`);
    const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8')) as Record<string, unknown>;
    expect(entry).toMatchObject({ pid: r.child.pid, repo, port, url: `http://127.0.0.1:${port}`, cmd: CLI });
    expect(Number.isNaN(Date.parse(String(entry.startedAt)))).toBe(false);

    const ls = await finished(run(['ls'], cfg, { env }));
    expect(ls.code).toBe(0);
    const [header, row] = ls.out.trim().split('\n');
    expect(header).toMatch(/^Repositorio\s+Puerto\s+URL\s+PID\s+Desde$/);
    expect(row).toContain(shown(repo));
    expect(row).toContain(`http://127.0.0.1:${port}`);
    expect(row).toMatch(new RegExp(`\\s${port}\\s.*\\s${r.child.pid}\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`));

    const stop = await finished(run(['stop'], cfg, { cwd: sub, env }));
    expect(stop.code).toBe(0);
    expect(stop.out).toContain(`Usando la raíz del repositorio: ${repo}`);
    expect(stop.out).toContain(stoppedMessage(r.child.pid));
    expectStoppedExit(await r.exited);
    expect(fs.readFileSync(localFile, 'utf8')).toBe(localOriginal);
    expect(fs.existsSync(path.join(repo, '.neurons', 'lock'))).toBe(false);
    expect(registryFiles(env.NEURONS_HOME)).toEqual([]);

    const again = await finished(run(['ls'], cfg, { env }));
    expect(again.out.trim()).toBe('No hay visores corriendo.');
    const none = await finished(run(['stop', repo], cfg, { env }));
    expect(none.code).toBe(1);
    expect(none.out).toContain(`No hay un visor de Neurons corriendo sobre ${repo}.`);
  });

  it('`neu <dir>` starts on that dir and says when it is not a git repo', async () => {
    const dir = tmp('rs-cli-plain-');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    const cfg = tmp('rs-cli-cfg-');
    const env = homeEnv();
    const r = run([dir, '--no-open', '--no-install', '--port', '0'], cfg, { env });
    await r.waitFor(/Ctrl\+C para salir/);
    expect(r.output()).toContain('No es un repositorio git: el árbol se arma recorriendo la carpeta');
    expect(r.output()).toContain(`Repositorio: ${dir}`);
    expect(r.output()).not.toContain('Usando la raíz');
    const stop = await finished(run(['stop', dir], cfg, { env }));
    expect(stop.code).toBe(0);
    expectStoppedExit(await r.exited);
  });

  it('help, an unknown command and an unknown directory', async () => {
    const cfg = tmp('rs-cli-cfg-');
    for (const args of [['help'], ['-h'], ['--help']]) {
      const h = await finished(run(args, cfg));
      expect(h.code).toBe(0);
      for (const s of ['neu stop --all', 'neu open [repo]', 'neu ls', 'Ejemplos:', '--no-open', '--no-install', '--no-bash-diff', '--port N', '--strict-port']) {
        expect(h.out).toContain(s);
      }
      expect(h.out).not.toMatch(/[\u2013\u2014]/);
    }
    const unknown = await finished(run(['sotp'], cfg, { cwd: tmp('rs-cli-cwd-') }));
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('Comando desconocido: "sotp".');
    expect(unknown.out).toContain('¿Quisiste decir "neu stop"?');
    const missing = await finished(run(['./no-existe-xyz'], cfg));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('no existe');
    // An existing file is not "a folder that does not exist"; a .jsonl points to replay.
    const cwd = tmp('rs-cli-cwd-');
    fs.writeFileSync(path.join(cwd, 'README.md'), '# x\n');
    fs.writeFileSync(path.join(cwd, 'events.jsonl'), '');
    const file = await finished(run(['README.md'], cfg, { cwd }));
    expect(file.code).toBe(1);
    expect(file.out).toContain(`${path.join(cwd, 'README.md')} es un archivo, no una carpeta.`);
    expect(file.out).not.toContain('no existe');
    const log = await finished(run(['events.jsonl'], cfg, { cwd }));
    expect(log.out).toContain('neu replay events.jsonl');
  });

  it('messages follow --lang, then NEURONS_LANG', async () => {
    const cfg = tmp('rs-cli-cfg-');
    const repo = gitRepo();
    const doctorEn = await finished(run(['doctor', repo, '--lang', 'en'], cfg));
    expect(doctorEn.code).toBe(0);
    expect(doctorEn.out).toContain(`Neurons `);
    expect(doctorEn.out).toContain(`: checking ${repo}`);
    expect(doctorEn.out).toContain('Settings files:');
    expect(doctorEn.out).toMatch(/^ {2}user {5}\S/m);
    expect(doctorEn.out).not.toContain('diagnóstico');
    const unknownEn = await finished(run(['sotp'], cfg, { cwd: tmp('rs-cli-cwd-'), env: { NEURONS_LANG: 'en' } }));
    expect(unknownEn.out).toContain('Unknown command: "sotp".');
    expect(unknownEn.out).toContain('Did you mean "neu stop"?');
    const badLang = await finished(run(['ls', '--lang', 'fr'], cfg));
    expect(badLang.code).toBe(1);
    expect(badLang.out).toContain('Idioma inválido: "fr"');
  });

  it('open picks the viewer, lists several, and stop --all closes every one', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    // A fake opener first in PATH records the URL instead of opening a browser.
    const bin = tmp('rs-cli-bin-');
    const log = path.join(bin, 'opened.log');
    let env: NodeJS.ProcessEnv & { NEURONS_HOME: string };
    if (WIN) {
      // Windows opens it with `%ComSpec% /d /s /c start "" "<url>"` (verbatim arguments). In
      // its place node.exe, whose preload records the last argument (the URL) and exits
      // before node looks for a script called "/d". Other node processes ignore the preload.
      const preload = path.join(bin, 'fake-start.mjs');
      fs.writeFileSync(
        preload,
        `import fs from 'node:fs';\nconst a = process.argv.slice(2);\nif (a[0] === '/s' && a[1] === '/c') {\n  fs.appendFileSync(${JSON.stringify(log)}, a.at(-1) + '\\n');\n  process.exit(0);\n}\n`,
      );
      env = { ...homeEnv(), ComSpec: process.execPath, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    } else {
      for (const name of ['open', 'xdg-open']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
      }
      env = { ...homeEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    }
    const localFile = path.join(a, '.claude', 'settings.local.json');

    const ra = run([a, '--no-open', '--no-bash-diff', '--port', '0'], cfg, { env });
    const pa = Number((await ra.waitFor(READY))[1]);
    const one = await finished(run(['open'], cfg, { env }));
    expect(one.code).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe(`http://127.0.0.1:${pa}`);

    const rb = run([b, '--no-open', '--no-install', '--port', '0'], cfg, { env });
    const pb = Number((await rb.waitFor(READY))[1]);
    const several = await finished(run(['open'], cfg, { env }));
    expect(several.code).toBe(1);
    expect(several.out).toContain('Hay varios visores corriendo:');
    expect(several.out).toContain(shown(a));
    expect(several.out).toContain(shown(b));
    expect(several.out).toContain('neu open <repo>');

    // Without a repo, the viewer of the repo you are in wins (like `stop`).
    const here = await finished(run(['open'], cfg, { cwd: path.join(a, 'src'), env }));
    expect(here.code).toBe(0);
    const pickB = await finished(run(['open', path.join(b, 'src')], cfg, { env }));
    expect(pickB.code).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([`http://127.0.0.1:${pa}`, `http://127.0.0.1:${pa}`, `http://127.0.0.1:${pb}`]);

    const noViewer = await finished(run(['open', gitRepo()], cfg, { env }));
    expect(noViewer.code).toBe(1);
    expect(noViewer.out).toContain('No hay un visor de Neurons corriendo sobre');

    expect(fs.existsSync(localFile)).toBe(true);
    const all = await finished(run(['stop', '--all'], cfg, { env }));
    expect(all.code).toBe(0);
    expect(all.out).toContain('Cerrando 2 visores...');
    expectStoppedExit(await ra.exited);
    expectStoppedExit(await rb.exited);
    expect(fs.existsSync(localFile)).toBe(false);
    expect(registryFiles(env.NEURONS_HOME)).toEqual([]);
    expect((await finished(run(['stop', '--all'], cfg, { env }))).out.trim()).toBe('No hay visores corriendo.');
    const none = await finished(run(['open'], cfg, { env }));
    expect(none.code).toBe(1);
    expect(none.out).toContain('No hay visores corriendo.');
  });

  it('stop never signals a registered PID whose process is not a viewer', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const env = homeEnv();
    const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(k);
    const viewers = path.join(env.NEURONS_HOME, 'viewers');
    fs.mkdirSync(viewers, { recursive: true });
    // startedAt after the process started: the PID is "the same process", but its command
    // line does not run the recorded script.
    const entry = { pid: k.pid, repo, port: 1, url: 'http://127.0.0.1:1', startedAt: new Date(Date.now() + 60_000).toISOString(), cmd: '/nowhere/dist/cli.mjs' };
    fs.writeFileSync(path.join(viewers, `${k.pid}.json`), JSON.stringify(entry));
    for (const args of [['stop', repo], ['stop', repo, '--force'], ['stop', '--all']]) {
      const s = await finished(run(args, cfg, { env }));
      expect(s.code).toBe(1);
      expect(s.out).toContain(`El PID ${k.pid} anotado para`);
      expect(s.out).toContain('no se le envió ninguna señal');
    }
    expect(k.exitCode).toBeNull();
    expect(k.signalCode).toBeNull();
  });

  it('stop closes a viewer launched with a relative script path', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const env = homeEnv();
    // `ps` shows "node dist/cli.mjs ...", while argv[1] (the recorded cmd) is absolute.
    const r = run(['start', repo, '--no-open', '--no-install', '--no-bash-diff', '--port', '0'], cfg, { env, cwd: ROOT, script: path.relative(ROOT, CLI) });
    await r.waitFor(/Ctrl\+C para salir/);
    const entry = JSON.parse(fs.readFileSync(path.join(env.NEURONS_HOME, 'viewers', `${r.child.pid}.json`), 'utf8')) as Record<string, unknown>;
    expect(entry.cmd).toBe(CLI);
    expect(String(entry.command)).toContain(` ${path.relative(ROOT, CLI)} start `);
    const stop = await finished(run(['stop', repo], cfg, { env }));
    expect(stop.out).toContain(stoppedMessage(r.child.pid));
    expect(stop.code).toBe(0);
    expectStoppedExit(await r.exited);
  });

  it('stop never signals the viewer of another repo through a stale lock whose PID it reused (F2)', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const env = homeEnv();
    const rb = run(['start', b, '--no-open', '--no-install', '--no-bash-diff', '--port', '0'], cfg, { env });
    await rb.waitFor(/Ctrl\+C para salir/);
    // A's viewer crashed long ago; its lock names the PID B now runs under, and B's script.
    fs.mkdirSync(path.join(a, '.neurons'), { recursive: true });
    fs.writeFileSync(path.join(a, '.neurons', 'lock'), JSON.stringify({ pid: rb.child.pid, startedAt: '2020-01-01T00:00:00.000Z', cmd: CLI }) + '\n');
    for (const args of [['stop', a], ['stop', a, '--force']]) {
      const s = await finished(run(args, cfg, { env }));
      expect(s.code).toBe(1);
      expect(s.out).toContain(`No hay un visor de Neurons corriendo sobre ${a}.`);
    }
    expect(rb.child.exitCode).toBeNull();
    expect(rb.child.signalCode).toBeNull();
    const stopB = await finished(run(['stop', b], cfg, { env }));
    expect(stopB.code).toBe(0);
    expectStoppedExit(await rb.exited);
  });

  // A hung viewer is a stopped process (SIGSTOP), which Windows does not have; there `neu stop`
  // always terminates (TerminateProcess cannot be ignored) and the cleanup it then does is
  // what every closeViewer above checks (docs/DECISIONS.md, W3).
  it.skipIf(WIN)('stop reports a viewer that does not exit; --force kills it and restores both settings files', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const env = homeEnv();
    const userFile = path.join(cfg, 'settings.json');
    const userOriginal = '{\n  "theme": "dark"\n}\n';
    fs.writeFileSync(userFile, userOriginal);
    const localFile = path.join(repo, '.claude', 'settings.local.json');

    const r = run(['start', repo, '--no-open', '--port', '0'], cfg, { env });
    await r.waitFor(READY);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf8'))).toEqual({ theme: 'dark', bashEditDiffEnabled: true });
    expect(fs.existsSync(localFile)).toBe(true);
    // A stopped process cannot run its SIGTERM handler: it stands for a hung viewer.
    r.child.kill('SIGSTOP');

    const soft = await finished(run(['stop', repo], cfg, { env }));
    expect(soft.code).toBe(1);
    expect(soft.out).toContain('no se cerró en 8 s');
    // The hint names the repo: without it, `neu stop --force` acts on the cwd's repo.
    expect(soft.out).toContain(`neu stop --force ${repo}`);
    expect(fs.existsSync(localFile)).toBe(true);

    const hard = await finished(run(['stop', repo, '--force'], cfg, { env }));
    expect(hard.code).toBe(0);
    expect(hard.out).toContain('terminado con SIGKILL');
    expect(hard.out).toContain('Hooks quitados.');
    expect((await r.exited).signal).toBe('SIGKILL');
    expect(fs.existsSync(localFile)).toBe(false);
    expect(fs.readFileSync(userFile, 'utf8')).toBe(userOriginal);
    expect(fs.existsSync(path.join(repo, '.neurons', 'lock'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
    expect(registryFiles(env.NEURONS_HOME)).toEqual([]);
  }, 40_000);

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'start warns about Claude Code sessions already open in the repo',
    async () => {
      const repo = gitRepo();
      const cfg = tmp('rs-cli-cfg-');
      const env = homeEnv();
      // A process whose argv[0] is ".../claude", with its cwd inside the repo.
      const bin = tmp('rs-cli-fakeclaude-');
      fs.symlinkSync(fs.existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep', path.join(bin, 'claude'));
      const fake = spawn(path.join(bin, 'claude'), ['60'], { cwd: path.join(repo, 'src'), stdio: 'ignore' });
      children.push(fake);
      // One outside the repo is ignored.
      const other = spawn(path.join(bin, 'claude'), ['60'], { cwd: bin, stdio: 'ignore' });
      children.push(other);

      const r = run(['start', repo, '--no-open', '--no-bash-diff', '--port', '0'], cfg, { env });
      await r.waitFor(/Ctrl\+C para salir/);
      expect(r.output()).toContain(`Hay 1 sesión de Claude Code abierta en este repositorio (PID ${fake.pid}).`);
      expect(r.output()).toContain('Toma los hooks en vivo, sin reiniciar (verificado con Claude Code 2.1.288 en macOS).');
      expect(r.output()).toContain('Si no muestra eventos, corré /reload-plugins en esa sesión; si no alcanza, /exit y después claude --continue.');
      expect(r.output()).not.toContain(String(other.pid));
      r.child.kill('SIGTERM');
      expect((await r.exited).code).toBe(0);
      expect(fake.exitCode).toBeNull();
      expect(fake.signalCode).toBeNull();

      // Without sessions it just says to open Claude Code.
      fake.kill('SIGKILL');
      await new Promise((res) => fake.once('exit', res));
      const r2 = run(['start', repo, '--no-open', '--no-bash-diff', '--port', '0'], cfg, { env });
      await r2.waitFor(/Ctrl\+C para salir/);
      expect(r2.output()).toContain('Abrí Claude Code en este repositorio.');
      expect(r2.output()).not.toContain('sesión de Claude Code abierta');
      r2.child.kill('SIGTERM');
      await r2.exited;
    },
    20_000,
  );
});
