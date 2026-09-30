// Development stand-in for the real server: serves dist/web and speaks the WS protocol,
// replaying a scripted loop of VizEvents over the tree of a real directory.
//
//   npm run build:web
//   npx tsx scripts/dev/fake-server.ts [dir] [--port 7788] [--interval 700] [--replay] [--quiet]
//
// GET /api/log serves a generated LogLine[] (for the replay UI). --replay makes hello say
// mode "replay"; --quiet sends no live events.
//
// It never reads file contents, only names. It does not import src/server on purpose.
import { randomUUID } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  Action,
  LogLine,
  Phase,
  ServerMessage,
  SessionInfo,
  TreeEntry,
  TreeSnapshot,
  VizEvent,
} from '../../src/shared/types.ts';

const SKIP = new Set(['node_modules', '.git', 'dist', '.repo-synapse']);
const FILE_CAP = 5000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
};

interface Args {
  dir: string;
  port: number;
  interval: number;
  /** Send hello with mode "replay" (like `repo-synapse replay`). */
  replay: boolean;
  /** Do not send live events (useful for fps measurements). */
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: process.cwd(), port: 7788, interval: 700, replay: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--replay') args.replay = true;
    else if (a === '--quiet') args.quiet = true;
    else args.dir = resolve(a);
  }
  return args;
}

function scan(root: string): TreeSnapshot {
  const entries: TreeEntry[] = [];
  let truncated = false;
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      if (entries.length >= FILE_CAP) {
        truncated = true;
        return;
      }
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      entries.push({ path: childRel, kind: isDir ? 'dir' : 'file' });
      if (isDir) walk(childAbs, childRel);
    }
  };
  walk(root, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, name: basename(root), entries, truncated };
}

// ---------- scripted session ----------

const SESSION_ID = 'a1b2c3d4-fake-session-0001';
const SESSION_2 = 'f9e8d7c6-fake-session-0002';
const AGENT_ID = 'fake-agent-01';
const AGENT_TYPE = 'Explore';
const AGENT_2 = 'fake-agent-02';
const AGENT_2_TYPE = 'general-purpose';

type Step = () => ServerMessage[];

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function ev(action: Action, phase: Phase, paths: string[], extra: Partial<VizEvent> = {}): ServerMessage {
  const event: VizEvent = {
    id: randomUUID(),
    ts: Date.now(),
    sessionId: SESSION_ID,
    phase,
    action,
    paths,
    source: 'hook',
    ...extra,
  };
  return { type: 'event', event };
}

class Scenario {
  private readonly files: string[];
  private readonly dirs: string[];
  private readonly live: Map<string, TreeEntry>;
  private loop = 0;
  private cursor = 0;
  private readonly steps: Step[];
  private readonly tree: TreeSnapshot;

  constructor(tree: TreeSnapshot) {
    this.tree = tree;
    this.live = new Map(tree.entries.map((e) => [e.path, e]));
    this.files = tree.entries.filter((e) => e.kind === 'file').map((e) => e.path);
    this.dirs = tree.entries.filter((e) => e.kind === 'dir').map((e) => e.path);
    if (this.files.length === 0) this.files.push('README.md');
    if (this.dirs.length === 0) this.dirs.push('');
    this.steps = this.buildSteps();
  }

  snapshot(): TreeSnapshot {
    const entries = [...this.live.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { ...this.tree, entries };
  }

  private pick(list: string[], salt: number): string {
    return list[(this.loop * 7 + salt * 13) % list.length]!;
  }

  private deepFile(salt: number): string {
    const deep = this.files.filter((f) => f.includes('/'));
    return this.pick(deep.length ? deep : this.files, salt);
  }

  private filesIn(dir: string): string[] {
    const prefix = dir ? `${dir}/` : '';
    return this.files.filter((f) => f.startsWith(prefix)).slice(0, 8);
  }

  private newPath(stem: string): { dir: string; path: string } {
    const dir = this.pick(this.dirs, 3);
    const name = `${stem}-${this.loop}.ts`;
    return { dir, path: dir ? `${dir}/${name}` : name };
  }

  private add(path: string): ServerMessage {
    const entry: TreeEntry = { path, kind: 'file' };
    this.live.set(path, entry);
    return { type: 'tree', added: [entry], removed: [] };
  }

  private remove(path: string): ServerMessage {
    this.live.delete(path);
    return { type: 'tree', added: [], removed: [path] };
  }

  private buildSteps(): Step[] {
    let created = '';
    let moved = '';
    const claudeMd = this.files.find((f) => basename(f) === 'CLAUDE.md') ?? this.files.find((f) => f.endsWith('.md'));
    return [
      () => [ev('turn_start', 'info', [], { detail: 'Revisá el módulo y agregá un endpoint', promptId: `p-${this.loop}` })],
      () => {
        const dir = this.pick(this.dirs, 1);
        return [
          ev('search', 'post', [dir], {
            toolName: 'Bash',
            detail: `grep -rn "TODO" ${dir || '.'}`,
            secondary: this.filesIn(dir),
          }),
        ];
      },
      () => {
        const f = this.deepFile(2);
        return [ev('read', 'pre', [f], { toolName: 'Read' }), ev('read', 'post', [f], { toolName: 'Read' })];
      },
      () => (claudeMd ? [ev('context_load', 'info', [claudeMd], { detail: 'nested_traversal' })] : []),
      () => {
        const f = this.deepFile(4);
        return [ev('edit', 'pre', [f], { toolName: 'Edit' }), ev('edit', 'post', [f], { toolName: 'Edit' })];
      },
      () => {
        created = this.newPath('fake-new').path;
        return [ev('create', 'pre', [created], { toolName: 'Write' }), this.add(created), ev('create', 'post', [created], { toolName: 'Write' })];
      },
      () => [ev('subagent_start', 'info', [], { agentId: AGENT_ID, agentType: AGENT_TYPE })],
      () => {
        const f = this.deepFile(5);
        return [ev('read', 'post', [f], { toolName: 'Read', agentId: AGENT_ID, agentType: AGENT_TYPE })];
      },
      () => {
        const f = this.deepFile(6);
        return [ev('read', 'post', [f], { toolName: 'Read', agentId: AGENT_ID, agentType: AGENT_TYPE })];
      },
      () => [ev('subagent_stop', 'info', [], { agentId: AGENT_ID, agentType: AGENT_TYPE })],
      () => {
        const f = this.deepFile(8);
        return [
          ev('bash', 'pre', [f], { toolName: 'Bash', detail: `cat ${f}.missing` }),
          ev('bash', 'fail', [f], { toolName: 'Bash', detail: `cat ${f}.missing` }),
        ];
      },
      () => {
        const f = this.deepFile(9);
        return [ev('edit', 'info', [f], { source: 'watcher', external: true })];
      },
      () => {
        if (!created) return [];
        moved = created.replace(/\.ts$/, '-renamed.ts');
        const from = created;
        created = '';
        this.live.delete(from);
        this.live.set(moved, { path: moved, kind: 'file' });
        return [
          ev('move', 'post', [moved], { toolName: 'Bash', fromPaths: [from], detail: `git mv ${from} ${moved}` }),
          { type: 'tree', added: [{ path: moved, kind: 'file' }], removed: [from] },
        ];
      },
      () => {
        if (!moved) return [];
        const target = moved;
        moved = '';
        return [ev('delete', 'post', [target], { toolName: 'Bash', detail: `rm ${target}` }), this.remove(target)];
      },
      () => [
        ev('context_load', 'info', [], {
          outsideRepo: [join(process.env.HOME ?? '/home/user', '.claude', 'skills', 'demo', 'SKILL.md')],
          detail: 'skill',
        }),
      ],
      () => [
        ev('read', 'post', [], { toolName: 'Read', outsideRepo: [`/tmp/repo-synapse-demo/out-${this.loop % 3}.log`] }),
        ev('bash', 'post', [], { toolName: 'Bash', outsideRepo: ['/private/tmp/build/cache.json'], detail: 'ls /private/tmp/build' }),
      ],
      () => [ev('subagent_start', 'info', [], { agentId: AGENT_2, agentType: AGENT_2_TYPE })],
      () => {
        const f = this.deepFile(13);
        const g = this.deepFile(14);
        return [
          ev('search', 'post', [parentOf(f)], { toolName: 'Bash', agentId: AGENT_2, agentType: AGENT_2_TYPE, secondary: [f, g], detail: 'rg TODO' }),
          ev('edit', 'post', [g], { toolName: 'Edit', agentId: AGENT_2, agentType: AGENT_2_TYPE }),
        ];
      },
      () => [ev('subagent_stop', 'info', [], { agentId: AGENT_2, agentType: AGENT_2_TYPE })],
      () => [ev('read', 'post', [this.deepFile(15)], { toolName: 'Read', sessionId: SESSION_2 })],
      () => {
        const files = [this.deepFile(10), this.deepFile(11), this.deepFile(12)];
        return files.map((f) => ev('read', 'post', [f], { toolName: 'Read' }));
      },
      () => [ev('turn_end', 'info', [])],
    ];
  }

  next(): ServerMessage[] {
    const step = this.steps[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.steps.length;
    if (this.cursor === 0) this.loop++;
    return step();
  }

  /** A few past events for hello.recent (not animated by the client). */
  history(): VizEvent[] {
    const now = Date.now();
    return this.files.slice(0, 6).map((f, i) => ({
      id: randomUUID(),
      ts: now - 60_000 + i * 1000,
      sessionId: SESSION_ID,
      phase: 'post' as const,
      action: i % 2 ? ('edit' as const) : ('read' as const),
      paths: [f],
      source: 'hook' as const,
    }));
  }
}

// ---------- sample log for /api/log ----------

/**
 * Plays a separate copy of the scenario on a synthetic clock and records it as LogLine[]:
 * a tree line, events and tree deltas, two long pauses (compressed by the client) and a
 * second tree line (a restart, so the client offers two segments).
 */
function sampleLog(tree: TreeSnapshot, steps = 60): LogLine[] {
  const sim = new Scenario(tree);
  let clock = Date.now() - 30 * 60_000;
  const lines: LogLine[] = [{ kind: 'tree', ts: clock, tree: sim.snapshot() }];
  for (let i = 0; i < steps; i++) {
    clock += 450 + ((i * 97) % 500);
    if (i === 18) clock += 12_000;
    if (i === 37) clock += 95_000;
    if (i === 44) lines.push({ kind: 'tree', ts: clock, tree: sim.snapshot() });
    let k = 0;
    for (const msg of sim.next()) {
      const ts = clock + k++ * 15;
      if (msg.type === 'event') lines.push({ kind: 'event', event: { ...msg.event, ts } });
      else if (msg.type === 'tree') lines.push({ kind: 'treeDelta', ts, added: msg.added, removed: msg.removed });
    }
  }
  return lines;
}

// ---------- server ----------

const { dir, port, interval, replay, quiet } = parseArgs(process.argv.slice(2));
const webRoot = fileURLToPath(new URL('../../dist/web/', import.meta.url));
const initialTree = scan(dir);
const scenario = new Scenario(initialTree);
const startedAt = Date.now();
const logBody = JSON.stringify(sampleLog(initialTree));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/log') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(logBody);
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = resolve(webRoot, `.${rel}`);
  if (!abs.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(abs).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado. ¿Corriste npm run build:web?');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(abs)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(abs).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function sessions(): SessionInfo[] {
  return [
    {
      sessionId: SESSION_ID,
      firstSeen: startedAt,
      lastSeen: Date.now(),
      ended: false,
      agents: { [AGENT_ID]: AGENT_TYPE, [AGENT_2]: AGENT_2_TYPE },
    },
    { sessionId: SESSION_2, firstSeen: startedAt + 1000, lastSeen: Date.now(), ended: false, agents: {} },
  ];
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  if (replay) {
    send(ws, { type: 'hello', mode: 'replay', tree: initialTree, recent: [], sessions: [] });
    return;
  }
  send(ws, { type: 'hello', mode: 'live', tree: scenario.snapshot(), recent: scenario.history(), sessions: sessions() });
});

let ticks = 0;
setInterval(() => {
  if (replay || quiet) return;
  if (++ticks % 10 === 0) for (const client of wss.clients) send(client, { type: 'sessions', sessions: sessions() });
  for (const msg of scenario.next()) {
    // Refresh ts at send time so latency readings are meaningful.
    if (msg.type === 'event') msg.event.ts = Date.now();
    for (const client of wss.clients) send(client, msg);
  }
}, interval);

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-server: http://127.0.0.1:${port}/  (árbol: ${dir}, ${scenario.snapshot().entries.length} entradas)`);
});
