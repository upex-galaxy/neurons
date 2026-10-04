// Heuristic classifier for Bash tool commands. It never executes anything:
// it tokenizes the command like a (small) POSIX shell and looks at argv.

import path from 'node:path';

export interface BashClassification {
  kind: 'search' | 'delete' | 'move' | 'other';
  /** Non-flag arguments of the segments of the dominant kind, prefixed with any leading `cd`. */
  pathArgs: string[];
  /** Search pattern (grep-like pattern, or find -name glob). */
  pattern?: string;
  /** Directory set by a `cd`/`pushd` in effect for the first relevant segment (relative to the Bash cwd, or absolute). */
  cdDir?: string;
  /** For `move`: each mv / git mv as sources and destination (prefixed like pathArgs). */
  moves?: BashMove[];
  /** For `delete`: pathArgs that are search roots (`find <root> -delete`), not deleted themselves. */
  bases?: string[];
}

export interface BashMove {
  sources: string[];
  dest: string;
  /** True when `dest` is certainly a directory the sources go into (-t, trailing slash, several sources). */
  intoDir: boolean;
}

type Kind = BashClassification['kind'];

type Token = { t: 'word'; v: string } | { t: 'op'; v: string } | { t: 'redir'; v: string };

const RANK: Record<Kind, number> = { other: 0, search: 1, move: 2, delete: 3 };

// ---------------------------------------------------------------- tokenizer

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r';
}

/** Reads a balanced `$( ... )` or `` `...` `` starting at `i`; returns the end index (exclusive). */
function skipSubst(s: string, i: number): number {
  if (s[i] === '`') {
    let j = i + 1;
    while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, s.length);
  }
  // s[i] === '$' && s[i+1] === '('
  let depth = 0;
  let j = i + 1;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
    } else if (c === "'") {
      const k = s.indexOf("'", j + 1);
      j = k === -1 ? s.length : k;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return s.length;
}

export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let word = '';
  let inWord = false;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let awaitingHeredocDelim: boolean | null = null; // strip-tabs flag while waiting for the delimiter word

  const flush = (): void => {
    if (!inWord) return;
    if (awaitingHeredocDelim !== null) {
      heredocs.push({ delim: word, strip: awaitingHeredocDelim });
      awaitingHeredocDelim = null;
    }
    out.push({ t: 'word', v: word });
    word = '';
    inWord = false;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    const next = s[i + 1];

    if (c === '\n') {
      flush();
      out.push({ t: 'op', v: ';' });
      i++;
      // Skip heredoc bodies: their lines are data, not commands.
      while (heredocs.length > 0) {
        const doc = heredocs.shift() as { delim: string; strip: boolean };
        while (i < s.length) {
          const end = s.indexOf('\n', i);
          const line = s.slice(i, end === -1 ? s.length : end);
          i = end === -1 ? s.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break;
        }
      }
      continue;
    }
    if (isSpace(c)) {
      flush();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      if (next !== undefined) word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      word += s.slice(i + 1, end === -1 ? s.length : end);
      inWord = true;
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1] as string)) {
          if (s[j + 1] !== '\n') word += s[j + 1];
          j += 2;
        } else if ((s[j] === '$' && s[j + 1] === '(') || s[j] === '`') {
          const end = skipSubst(s, j);
          word += s.slice(j, end);
          j = end;
        } else {
          word += s[j];
          j++;
        }
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if ((c === '$' && next === '(') || c === '`') {
      const end = skipSubst(s, i);
      word += s.slice(i, end);
      inWord = true;
      i = end;
      continue;
    }
    // Redirections: [n]>, [n]>>, >&, &>, <, <<, <<-, <<<, <>, >|
    const digitsWord = inWord && /^\d+$/.test(word);
    if (c === '>' || c === '<' || (c === '&' && next === '>')) {
      if (inWord && !digitsWord) flush();
      let op = digitsWord ? word : '';
      word = '';
      inWord = false;
      const m = /^(&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)/.exec(s.slice(i));
      const sym = m ? (m[1] as string) : c;
      op += sym;
      i += sym.length;
      out.push({ t: 'redir', v: op });
      if (sym === '<<' || sym === '<<-') awaitingHeredocDelim = sym === '<<-';
      continue;
    }
    if (c === '&' || c === '|' || c === ';') {
      flush();
      const two = c + (next ?? '');
      if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
        out.push({ t: 'op', v: two });
        i += 2;
      } else {
        out.push({ t: 'op', v: c });
        i++;
      }
      continue;
    }
    if (c === '(' || c === ')') {
      flush();
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  flush();
  return out;
}

/** Splits tokens into simple commands (argv lists), dropping redirections and their targets. */
function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as Token;
    if (tok.t === 'op') {
      if (cur.length > 0) segments.push(cur);
      cur = [];
    } else if (tok.t === 'redir') {
      if (tokens[i + 1]?.t === 'word') i++;
    } else {
      cur.push(tok.v);
    }
  }
  if (cur.length > 0) segments.push(cur);
  return segments;
}

// ---------------------------------------------------------------- argv parsing

interface ParsedArgs {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(args: string[], valueFlags: ReadonlySet<string>, stopFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const res: ParsedArgs = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      res.positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      if (stopFlags.has(a)) break;
      const eq = a.indexOf('=');
      const name = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
      if (a.startsWith('--') && eq !== -1) {
        const list = res.values.get(name) ?? [];
        list.push(a.slice(eq + 1));
        res.values.set(name, list);
      } else if (valueFlags.has(a) && i + 1 < args.length) {
        const list = res.values.get(a) ?? [];
        list.push(args[i + 1] as string);
        res.values.set(a, list);
        i++;
      } else {
        res.flags.add(name);
      }
      continue;
    }
    if (a !== '-') res.positional.push(a);
  }
  return res;
}

const GREP_VALUE_FLAGS = new Set([
  '-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D', '-g', '-t', '-T', '-j', '-M', '-E', '-r', '-G', '-O', '-K',
  '--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--include',
  '--exclude', '--exclude-dir', '--label', '--binary-files', '--devices', '--directories', '--glob',
  '--iglob', '--type', '--type-not', '--threads', '--max-columns', '--encoding', '--replace', '--max-depth',
  '--max-filesize', '--sort', '--sortr', '--type-add', '--pre', '--ignore-dir', '--ignore-file',
]);
// Short flags that take a value in rg/ag but are booleans elsewhere (grep -r, -E, -G, -T).
const GREP_BOOLEANS: Record<string, readonly string[]> = {
  grep: ['-r', '-E', '-G', '-T'],
  egrep: ['-r', '-E', '-G', '-T'],
  fgrep: ['-r', '-E', '-G', '-T'],
  'git-grep': ['-r', '-E', '-G', '-T'],
  ugrep: ['-r', '-E', '-G', '-T'],
  ug: ['-r', '-E', '-G', '-T'],
  ag: ['-r', '-E', '-T'],
  ack: ['-r', '-E', '-T'],
};

const FIND_PATTERN_FLAGS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']);

const FD_VALUE_FLAGS = new Set([
  '-e', '-t', '-E', '-d', '-c', '-j', '-S', '--extension', '--type', '--exclude', '--max-depth', '--min-depth',
  '--exact-depth', '--color', '--threads', '--size', '--owner', '--changed-within', '--changed-before',
  '--base-directory', '--search-path', '--ignore-file', '--path-separator', '--max-results',
]);
const FD_STOP_FLAGS = new Set(['-x', '-X', '--exec', '--exec-batch']);

const LS_VALUE_FLAGS = new Set(['-I', '-w', '-T', '--ignore', '--hide', '--width', '--tabsize']);
const TREE_VALUE_FLAGS = new Set(['-L', '-P', '-I', '-o', '-H', '--charset', '--filelimit', '--timefmt']);
const MV_VALUE_FLAGS = new Set(['-t', '-S', '--target-directory', '--suffix']);
const GIT_LS_FILES_VALUE_FLAGS = new Set(['-x', '-X', '--exclude', '--exclude-from', '--with-tree']);

// ---------------------------------------------------------------- segment analysis

interface SegmentResult {
  kind: Kind;
  args: string[];
  pattern?: string;
  /** Directory prefix the args are relative to (git -C). */
  dir?: string;
  moves?: BashMove[];
  bases?: string[];
}

/** Sources and destination of one mv / git mv argv. */
function mvMoves(parsed: ParsedArgs): BashMove[] {
  const target = parsed.values.get('-t')?.at(-1) ?? parsed.values.get('--target-directory')?.at(-1);
  if (target !== undefined) {
    return parsed.positional.length > 0 ? [{ sources: parsed.positional, dest: target, intoDir: true }] : [];
  }
  if (parsed.positional.length < 2) return [];
  const sources = parsed.positional.slice(0, -1);
  const dest = parsed.positional[parsed.positional.length - 1] as string;
  const noTargetDir = parsed.flags.has('-T') || parsed.flags.has('--no-target-directory');
  return [{ sources, dest, intoDir: !noTargetDir && (sources.length > 1 || dest.endsWith('/')) }];
}

function commandName(w: string): string {
  return path.posix.basename(w);
}

/** Skips env assignments and wrapper commands (sudo, command, time, xargs, ...). Returns argv of the real command. */
function unwrap(words: string[]): string[] {
  let i = 0;
  const skipFlags = (valueFlags: ReadonlySet<string> = new Set()): void => {
    while (i < words.length) {
      const w = words[i] as string;
      if (w === '--') {
        i++;
        return;
      }
      if (!w.startsWith('-') || w === '-') return;
      i += valueFlags.has(w) ? 2 : 1;
    }
  };
  while (i < words.length) {
    const w = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    const name = commandName(w);
    if (name === 'sudo' || name === 'doas') {
      i++;
      skipFlags(new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']));
    } else if (name === 'command' || name === 'builtin' || name === 'exec' || name === 'nohup' || name === 'time') {
      i++;
      skipFlags();
    } else if (name === 'nice') {
      i++;
      skipFlags(new Set(['-n']));
    } else if (name === 'env') {
      i++;
      skipFlags(new Set(['-u', '-C', '-S']));
    } else if (name === 'timeout') {
      i++;
      skipFlags(new Set(['-s', '-k', '--signal', '--kill-after']));
      i++; // duration
    } else if (name === 'xargs') {
      i++;
      skipFlags(new Set(['-n', '-I', '-L', '-P', '-d', '-s', '-E', '-a', '-J', '-R', '-S']));
    } else {
      break;
    }
  }
  return words.slice(i);
}

function grepLike(tool: string, args: string[]): SegmentResult {
  const flags = new Set(GREP_VALUE_FLAGS);
  for (const f of GREP_BOOLEANS[tool] ?? []) flags.delete(f);
  const parsed = parseArgs(args, flags);
  const explicit = [...(parsed.values.get('-e') ?? []), ...(parsed.values.get('--regexp') ?? [])];
  const fromFile = parsed.values.has('-f') || parsed.values.has('--file');
  if (explicit.length > 0 || fromFile) {
    return { kind: 'search', args: parsed.positional, pattern: explicit[0] };
  }
  const [pattern, ...paths] = parsed.positional;
  return { kind: 'search', args: paths, pattern };
}

function findLike(args: string[]): SegmentResult {
  let i = 0;
  // Leading options: -H -L -P -O3 -D debugopts (find), -j4 -S bfs (bfs).
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '-H' || a === '-L' || a === '-P' || a === '-E' || a === '-X' || a === '-s' || a === '-x' || /^-O\d*$/.test(a) || /^-j\d+$/.test(a)) {
      i++;
    } else if (a === '-D' || a === '-S' || a === '-f') {
      i += 2;
    } else {
      break;
    }
  }
  const paths: string[] = [];
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith('-') || a === '(' || a === '!' || a === ')' || a === ',') break;
    paths.push(a);
  }
  let pattern: string | undefined;
  let del = false;
  for (let j = i; j < args.length; j++) {
    const a = args[j] as string;
    if (pattern === undefined && FIND_PATTERN_FLAGS.has(a) && j + 1 < args.length) pattern = args[j + 1];
    if (a === '-delete') del = true;
  }
  // `find <root> -delete` removes what matches under the roots, not the roots themselves.
  return del ? { kind: 'delete', args: paths, bases: paths, pattern } : { kind: 'search', args: paths, pattern };
}

function analyzeGit(args: string[]): SegmentResult {
  let i = 0;
  let dir: string | undefined;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '-C') {
      const d = args[i + 1];
      if (d !== undefined) dir = dir && !isAbsoluteish(d) ? path.posix.join(dir, d) : d;
      i += 2;
    } else if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      i += 2;
    } else if (a.startsWith('-')) {
      i++;
    } else {
      break;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  let res: SegmentResult;
  switch (sub) {
    case 'grep':
      res = grepLike('git-grep', rest);
      break;
    case 'ls-files':
      res = { kind: 'search', args: parseArgs(rest, GIT_LS_FILES_VALUE_FLAGS).positional };
      break;
    case 'rm':
      res = { kind: 'delete', args: parseArgs(rest, new Set()).positional };
      break;
    case 'mv': {
      const parsed = parseArgs(rest, new Set());
      res = { kind: 'move', args: parsed.positional, moves: mvMoves(parsed) };
      break;
    }
    default:
      res = { kind: 'other', args: [] };
  }
  if (dir !== undefined) res.dir = dir;
  return res;
}

function analyzeSegment(argv: string[]): SegmentResult {
  const [cmdWord, ...args] = argv;
  if (cmdWord === undefined) return { kind: 'other', args: [] };
  const cmd = commandName(cmdWord);
  switch (cmd) {
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
    case 'ugrep':
    case 'ug':
    case 'ag':
    case 'ack':
      return grepLike(cmd, args);
    case 'find':
    case 'bfs':
      return findLike(args);
    case 'fd':
    case 'fdfind': {
      const parsed = parseArgs(args, FD_VALUE_FLAGS, FD_STOP_FLAGS);
      const [pattern, ...paths] = parsed.positional;
      return { kind: 'search', args: [...paths, ...(parsed.values.get('--search-path') ?? [])], pattern };
    }
    case 'ls':
    case 'exa':
    case 'eza':
      return { kind: 'search', args: parseArgs(args, LS_VALUE_FLAGS).positional };
    case 'tree':
      return { kind: 'search', args: parseArgs(args, TREE_VALUE_FLAGS).positional };
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'trash':
    case 'trash-put':
      return { kind: 'delete', args: parseArgs(args, new Set()).positional };
    case 'mv': {
      const parsed = parseArgs(args, MV_VALUE_FLAGS);
      return { kind: 'move', args: parsed.positional, moves: mvMoves(parsed) };
    }
    case 'git':
      return analyzeGit(args);
    default:
      return { kind: 'other', args: [] };
  }
}

function isAbsoluteish(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p);
}

function withPrefix(arg: string, prefix: string | undefined): string {
  if (!prefix || isAbsoluteish(arg)) return arg;
  return path.posix.join(prefix, arg);
}

export function classifyBash(command: string): BashClassification {
  if (typeof command !== 'string' || command.trim() === '') return { kind: 'other', pathArgs: [] };
  let segments: string[][];
  try {
    segments = splitSegments(tokenize(command));
  } catch {
    return { kind: 'other', pathArgs: [] };
  }

  let cdDir: string | undefined;
  const results: { res: SegmentResult; cdDir: string | undefined }[] = [];
  for (const seg of segments) {
    const argv = unwrap(seg);
    const name = argv[0] === undefined ? '' : commandName(argv[0]);
    if (name === 'cd' || name === 'pushd') {
      const target = argv.slice(1).find((a) => !a.startsWith('-'));
      if (target !== undefined) cdDir = withPrefix(target, cdDir);
      continue;
    }
    results.push({ res: analyzeSegment(argv), cdDir });
  }

  let kind: Kind = 'other';
  for (const { res } of results) if (RANK[res.kind] > RANK[kind]) kind = res.kind;
  if (kind === 'other') return { kind, pathArgs: [] };

  const pathArgs: string[] = [];
  const seen = new Set<string>();
  const moves: BashMove[] = [];
  const bases: string[] = [];
  let pattern: string | undefined;
  let firstCd: string | undefined;
  let first = true;
  for (const { res, cdDir: dir } of results) {
    if (res.kind !== kind) continue;
    if (first) {
      firstCd = dir;
      first = false;
    }
    if (pattern === undefined && res.pattern !== undefined) pattern = res.pattern;
    const prefix = res.dir !== undefined ? withPrefix(res.dir, dir) : dir;
    for (const a of res.args) {
      const p = withPrefix(a, prefix);
      if (!seen.has(p)) {
        seen.add(p);
        pathArgs.push(p);
      }
    }
    for (const m of res.moves ?? []) {
      moves.push({ sources: m.sources.map((a) => withPrefix(a, prefix)), dest: withPrefix(m.dest, prefix), intoDir: m.intoDir });
    }
    for (const b of res.bases ?? []) bases.push(withPrefix(b, prefix));
  }
  const out: BashClassification = { kind, pathArgs };
  if (pattern !== undefined) out.pattern = pattern;
  if (firstCd !== undefined) out.cdDir = firstCd;
  if (kind === 'move') out.moves = moves;
  if (kind === 'delete' && bases.length > 0) out.bases = bases;
  return out;
}

// ---------------------------------------------------------------- programs

/** Shell words that open or close a compound command: never the program name. */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', '[[', ']]', 'esac', 'in']);
/** Segments that are not a command run (loop headers, case labels). */
const NON_COMMAND = new Set(['for', 'select', 'case', 'function']);
/** Builtins that only change the shell's state: not worth naming as a program. */
const STATE_BUILTINS = new Set(['[', 'test', 'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'shopt', 'true', 'false', ':', 'local', 'declare', 'readonly']);
export const PROGRAMS_MAX = 8;

/**
 * Distinct program names a Bash command runs, in order of first appearance: the first word
 * of each simple command after env assignments and wrappers (sudo, time, xargs...), as a
 * basename. Heredoc bodies are skipped by the tokenizer; dynamic names ($CMD) are dropped.
 */
export function bashPrograms(command: string, max = PROGRAMS_MAX): string[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  let segments: string[][];
  try {
    segments = splitSegments(tokenize(command));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const seg of segments) {
    let words = seg;
    while (words.length > 0 && SHELL_KEYWORDS.has(words[0] as string)) words = words.slice(1);
    if (words.length === 0 || NON_COMMAND.has(words[0] as string)) continue;
    const argv = unwrap(words);
    const first = argv[0];
    if (first === undefined || first === '' || isDynamicWord(first) || first.endsWith('()')) continue;
    const name = commandName(first.replace(/\\/g, '/')).replace(/\.exe$/i, '');
    if (name === '' || SHELL_KEYWORDS.has(name) || STATE_BUILTINS.has(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function isDynamicWord(w: string): boolean {
  return w.includes('$') || w.includes('`') || w.includes('=');
}

// ---------------------------------------------------------------- output parsing

const GREP_LINE = /^(.+?):(\d+)(?::|-|$)/;
const PLAIN_PATH = /^[^\s:*?"<>|]+$/;

/**
 * Candidate paths from search output: plain path lines ("./src/a.ts", "src/a.ts")
 * and grep-style "path:line:" prefixes. Never returns the matched text.
 * Results are not validated; the caller checks them against the tree index.
 */
export function extractPathsFromOutput(stdout: string, limit = 200): string[] {
  if (typeof stdout !== 'string' || stdout === '' || limit <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '' || line.length > 4096) continue;
    let candidate: string | undefined;
    const m = GREP_LINE.exec(line);
    if (m && !/^[A-Za-z]$/.test(m[1] as string)) {
      candidate = m[1];
    } else if (PLAIN_PATH.test(line)) {
      candidate = line;
    }
    if (candidate === undefined) continue;
    candidate = candidate.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (candidate === '' || candidate === '.' || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out;
}
