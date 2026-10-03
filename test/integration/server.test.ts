import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { readLog } from '../../src/server/eventlog.ts';
import { Normalizer, parseHookPayload, type HookPayload } from '../../src/server/normalize.ts';
import { createPathResolver } from '../../src/server/paths.ts';
import { allowedOriginSet, startNeuronsServer, type NeuronsServer, type NeuronsServerOptions } from '../../src/server/server.ts';
import { TreeIndex, scanTree } from '../../src/server/tree.ts';
import type { LogLine, ServerMessage, TreeSnapshot, VizEvent } from '../../src/shared/types.ts';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/payloads');
const FAKE_HOME = '/Users/fake-home';
const RUN1_SESSION = '2c67fea2-a55c-499b-96ca-337317f82b0d';
const RUN3_SESSION = 'eff3b026-4261-493b-a7f6-15f2cf782d85';

/** Files of the phase 0 probe repo (docs/PAYLOADS.md). */
const PROBE_FILES: Record<string, string> = {
  'CLAUDE.md': '# Probe\n',
  'src/CLAUDE.md': '# src rules\n',
  '.claude/rules/api.md': '---\npaths: src/api/**/*.ts\n---\n',
  'src/api/user.ts': "export function getUser(id: string) {\n  // TODO: validate id\n  return { id, name: 'Ada' };\n}\n",
  'src/api/order.ts': 'export function getOrder(id: string) {\n  return { id, total: 42 };\n}\n',
  'src/utils/format.ts': 'export function formatMoney(n: number) {\n  // TODO: locale\n  return `$${n.toFixed(2)}`;\n}\n',
  'src/utils/legacy.ts': 'legacy\n',
  'docs/old.md': 'old notes\n',
};

const tmpDirs: string[] = [];
const servers: NeuronsServer[] = [];
const sockets: WebSocket[] = [];
let webDir: string;

beforeAll(() => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-'));
  tmpDirs.push(cfg);
  process.env.CLAUDE_CONFIG_DIR = cfg;
  webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-web-'));
  tmpDirs.push(webDir);
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Neurons</title>');
  fs.mkdirSync(path.join(webDir, 'assets'));
  fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(webDir, 'assets', 'app.css'), 'body{}');
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) await s.close();
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/** Temp git repo with the probe files. Returns the non-realpath spelling (/var/... on macOS). */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-srv-'));
  tmpDirs.push(repo);
  for (const [rel, content] of Object.entries(PROBE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  return repo;
}

function fixtureLines(name: string, repo: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.replaceAll('__REPO__', repo).replaceAll('__HOME__', FAKE_HOME));
}

function fixture(name: string, repo: string): HookPayload[] {
  return fixtureLines(name, repo).map((l) => {
    const p = parseHookPayload(l);
    if (!p) throw new Error(`bad fixture line in ${name}`);
    return p;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeout = 3000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Env {
  repo: string;
  server: NeuronsServer;
  logFile: string;
}

async function start(opts: Partial<NeuronsServerOptions> = {}): Promise<Env> {
  const repo = opts.root ?? makeRepo();
  const server = await startNeuronsServer({ root: repo, port: 0, mode: 'live', webDir, ...opts });
  servers.push(server);
  // Let FSEvents open its stream before the tests touch the disk.
  if (opts.mode !== 'replay' && opts.watch !== false) await sleep(150);
  return { repo, server, logFile: path.join(fs.realpathSync(repo), '.neurons', 'events.jsonl') };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  /** Receipt time of each message, index-aligned. */
  times: number[];
  events(): VizEvent[];
}

async function connect(url: string, origin?: string): Promise<Client> {
  const ws = new WebSocket(url.replace('http://', 'ws://') + '/ws', origin ? { origin } : {});
  sockets.push(ws);
  const client: Client = {
    ws,
    messages: [],
    times: [],
    events() {
      return this.messages.flatMap((m) => (m.type === 'event' ? [m.event] : []));
    },
  };
  ws.on('message', (data) => {
    client.times.push(performance.now());
    client.messages.push(JSON.parse(String(data)) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await waitFor(() => client.messages.length > 0, 2000, 'hello');
  return client;
}

async function post(url: string, body: string | object): Promise<{ status: number; text: string; length: string | null }> {
  const res = await fetch(url + '/hook?src=neurons', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, length: res.headers.get('content-length') };
}

function byTool(payloads: HookPayload[], event: string, tool: string, command?: string): HookPayload {
  const p = payloads.find(
    (x) =>
      x.hook_event_name === event &&
      x.tool_name === tool &&
      (command === undefined || (x.tool_input as { command?: string }).command === command),
  );
  if (!p) throw new Error(`no ${event} ${tool} in fixture`);
  return structuredClone(p);
}

function withoutEditDiff(p: HookPayload): HookPayload {
  const q = structuredClone(p);
  delete (q.tool_response as Record<string, unknown>).bashEditDiff;
  return q;
}

const FILE_CHANGE = new Set(['create', 'delete', 'move', 'edit']);

const key = (e: VizEvent) => `${e.action}|${e.phase}|${e.toolUseId ?? ''}|${e.paths.join(',')}`;

/** Every string in the fixture that is file content or tool output, never allowed in the log. */
function sensitiveStrings(payloads: HookPayload[]): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    for (const line of v.split('\n')) {
      const t = line.trim();
      // Long enough to be distinctive and not a bare path or a word that shows up in a command.
      if (t.length >= 10 && /\s/.test(t)) out.add(t);
    }
  };
  const walk = (v: unknown, k = ''): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, k);
    } else if (typeof v === 'object' && v !== null) {
      for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    } else if (['content', 'old_string', 'new_string', 'oldString', 'newString', 'originalFile', 'stdout', 'lines', 'last_assistant_message'].includes(k)) {
      add(v);
    }
  };
  for (const p of payloads) {
    walk(p.tool_input);
    walk(p.tool_response);
    walk(p.tool_calls);
    add(p.last_assistant_message);
  }
  return [...out];
}

// ---------------------------------------------------------------- tests

describe('POST /hook', () => {
  it('answers 204 with an empty body for every fixture payload and broadcasts events in order', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const hello = client.messages[0];
    expect(hello?.type).toBe('hello');
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.mode).toBe('live');
    expect(hello.recent).toEqual([]);
    expect(hello.tree.entries.map((e) => e.path)).toContain('src/api/user.ts');

    // Expected stream: an independent normalizer over an identical repo.
    const expectedNormalizer = new Normalizer({
      resolver: createPathResolver(repo),
      index: new TreeIndex(await scanTree(repo)),
    });
    const expected: string[] = [];
    for (const line of fixtureLines('run1.jsonl', repo)) {
      const r = await post(server.url, line);
      expect(r.status).toBe(204);
      expect(r.text).toBe('');
      expect(r.length === null || r.length === '0').toBe(true);
      const p = parseHookPayload(line);
      if (p) expected.push(...expectedNormalizer.normalize(p).map(key));
    }
    await waitFor(() => client.events().length >= expected.length, 3000, 'all events');
    await sleep(100);
    const hookEvents = client.events().filter((e) => e.source === 'hook');
    expect(hookEvents.map(key)).toEqual(expected);
    expect(client.events().every((e) => e.source === 'hook')).toBe(true);
    expect(hookEvents.every((e) => e.sessionId === RUN1_SESSION)).toBe(true);

    // Sessions: announced on the first hook and when the subagent appeared.
    const sessionMsgs = client.messages.filter((m) => m.type === 'sessions');
    expect(sessionMsgs.length).toBeGreaterThanOrEqual(2);
    const last = sessionMsgs.at(-1);
    if (last?.type !== 'sessions') throw new Error('no sessions');
    expect(last.sessions[0]).toMatchObject({ sessionId: RUN1_SESSION, ended: true, agents: { aa2b318dfea4c1d08: expect.any(String) } });

    // Exact changes from the hooks (Write create, bashEditDiff rm and git mv) update the tree.
    const deltas = client.messages.flatMap((m) => (m.type === 'tree' ? [m] : []));
    expect(deltas.flatMap((d) => d.added.map((a) => a.path))).toEqual(expect.arrayContaining(['src/api/health.ts', 'docs/notes.md']));
    expect(deltas.flatMap((d) => d.removed)).toEqual(expect.arrayContaining(['src/utils/legacy.ts', 'docs/old.md']));
    const tree = (await (await fetch(server.url + '/tree')).json()) as TreeSnapshot;
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain('src/api/health.ts');
    expect(paths).not.toContain('src/utils/legacy.ts');
  });

  it('ignores unparseable and oversized-looking bodies but still answers 204', async () => {
    const { server } = await start({ watch: false });
    const client = await connect(server.url);
    for (const body of ['not json', '', '[1,2]', '{"hook_event_name":"Stop"}', '{"session_id":"x"}']) {
      const r = await post(server.url, body);
      expect(r.status).toBe(204);
      expect(r.text).toBe('');
    }
    const big = { hook_event_name: 'UserPromptSubmit', session_id: 'big', prompt: 'hi', padding: 'x'.repeat(5 * 1024 * 1024) };
    expect((await post(server.url, big)).status).toBe(204);
    await waitFor(() => client.events().some((e) => e.action === 'turn_start'), 3000, 'big payload event');
    expect(client.events().map((e) => e.sessionId)).toEqual(['big', 'big']);
  });

  it('ignores hook posts from a browser page on a foreign origin', async () => {
    const { server } = await start({ watch: false });
    const client = await connect(server.url);
    // Another site, and a page served by another local dev server (other port).
    for (const origin of ['http://evil.example', 'http://localhost:3000', 'http://127.0.0.1:8888']) {
      const res = await fetch(server.url + '/hook', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin },
        body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'evil', prompt: 'x' }),
      });
      expect(res.status).toBe(204);
    }
    await sleep(100);
    expect(client.events()).toEqual([]);
  });

  it('delivers a hook event over WebSocket within 100 ms of the POST', async () => {
    const { server } = await start({ watch: false });
    const client = await connect(server.url);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const n = client.messages.length;
      const t0 = performance.now();
      await post(server.url, { hook_event_name: 'UserPromptSubmit', session_id: 'lat', prompt: `p${i}` });
      await waitFor(() => client.messages.slice(n).some((m) => m.type === 'event' && m.event.detail === `p${i}`), 1000, 'event');
      const idx = client.messages.findIndex((m, j) => j >= n && m.type === 'event' && m.event.detail === `p${i}`);
      samples.push((client.times[idx] as number) - t0);
    }
    expect(Math.max(...samples)).toBeLessThan(100);
  });
});

describe('privacy', () => {
  it('events.jsonl and the WS stream carry no file contents or tool output from the fixtures', async () => {
    const { repo, server, logFile } = await start({ watch: false });
    const client = await connect(server.url);
    const payloads = [...fixture('run1.jsonl', repo), ...fixture('run3.jsonl', repo)];
    for (const p of payloads) expect((await post(server.url, p)).status).toBe(204);
    await waitFor(() => client.messages.some((m) => m.type === 'event' && m.event.sessionId === RUN3_SESSION && m.event.action === 'session_end'), 3000, 'run3 end');

    const apiLog = (await (await fetch(server.url + '/api/log')).json()) as LogLine[];
    expect(apiLog[0]?.kind).toBe('tree');
    expect(apiLog.filter((l) => l.kind === 'event').length).toBe(client.events().length);

    const logText = fs.readFileSync(logFile, 'utf8');
    const wsText = JSON.stringify(client.messages);
    const secrets = sensitiveStrings(payloads);
    expect(secrets.length).toBeGreaterThan(5);
    for (const s of secrets) {
      expect(logText.includes(s), `log leaks: ${s}`).toBe(false);
      expect(wsText.includes(s), `ws leaks: ${s}`).toBe(false);
    }
    for (const field of ['"content"', '"old_string"', '"new_string"', '"stdout"', '"hunks"', '"structuredPatch"', '"originalFile"']) {
      expect(logText).not.toContain(field);
    }
    expect(readLog(logFile).length).toBe(apiLog.length);
  });
});

describe('watcher attribution', () => {
  it('attributes an rm inside a Bash window to that session (no bashEditDiff)', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const run3 = fixture('run3.jsonl', repo);
    const pre = byTool(run3, 'PreToolUse', 'Bash', 'rm src/utils/legacy.ts');
    const postNoDiff = withoutEditDiff(byTool(run3, 'PostToolUse', 'Bash', 'rm src/utils/legacy.ts'));

    await post(server.url, pre);
    fs.rmSync(path.join(repo, 'src/utils/legacy.ts'));
    const isWatcherDelete = (e: VizEvent) => e.source === 'watcher' && e.action === 'delete' && e.paths[0] === 'src/utils/legacy.ts';
    await waitFor(() => client.events().some(isWatcherDelete), 3000, 'watcher delete');
    await post(server.url, postNoDiff);
    await sleep(100);

    const ev = client.events().find(isWatcherDelete);
    expect(ev).toMatchObject({ sessionId: RUN3_SESSION, toolUseId: pre.tool_use_id, phase: 'post' });
    expect(ev?.external).toBeUndefined();
    const removed = client.messages.flatMap((m) => (m.type === 'tree' ? m.removed : []));
    expect(removed).toEqual(['src/utils/legacy.ts']);
  });

  it('marks an rm with no open window as external', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    fs.rmSync(path.join(repo, 'src/utils/format.ts'));
    await waitFor(() => client.events().length > 0, 3000, 'external delete');
    await sleep(100);
    expect(client.events()).toHaveLength(1);
    expect(client.events()[0]).toMatchObject({
      source: 'watcher',
      action: 'delete',
      paths: ['src/utils/format.ts'],
      sessionId: 'external',
      external: true,
    });
    const deltas = client.messages.flatMap((m) => (m.type === 'tree' ? [m] : []));
    expect(deltas).toEqual([{ type: 'tree', added: [], removed: ['src/utils/format.ts'] }]);
    // The event goes out before the node is removed, so the viewer can flash it.
    const evIdx = client.messages.findIndex((m) => m.type === 'event');
    const treeIdx = client.messages.findIndex((m) => m.type === 'tree');
    expect(evIdx).toBeLessThan(treeIdx);
  });

  it('broadcasts an external create with a tree delta before the event', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    fs.mkdirSync(path.join(repo, 'src/fresh'));
    fs.writeFileSync(path.join(repo, 'src/fresh/new.ts'), 'export {};\n');
    await waitFor(() => client.events().some((e) => e.paths[0] === 'src/fresh/new.ts'), 3000, 'external create');
    const added = client.messages.flatMap((m) => (m.type === 'tree' ? m.added : []));
    expect(added).toEqual([
      { path: 'src/fresh', kind: 'dir' },
      { path: 'src/fresh/new.ts', kind: 'file' },
    ]);
    const firstTree = client.messages.findIndex((m) => m.type === 'tree');
    const firstEvent = client.messages.findIndex((m) => m.type === 'event');
    expect(firstTree).toBeLessThan(firstEvent);
    expect(client.events().every((e) => e.external === true && e.action === 'create')).toBe(true);
  });

  it('bashEditDiff delete + watcher unlink of the same path: exactly one delete (hook first)', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const run3 = fixture('run3.jsonl', repo);
    await post(server.url, byTool(run3, 'PreToolUse', 'Bash', 'rm src/utils/legacy.ts'));
    fs.rmSync(path.join(repo, 'src/utils/legacy.ts'));
    await post(server.url, byTool(run3, 'PostToolUse', 'Bash', 'rm src/utils/legacy.ts'));
    await sleep(400);
    const deletes = client.events().filter((e) => e.action === 'delete' && e.phase === 'post' && e.paths.includes('src/utils/legacy.ts'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.sessionId).toBe(RUN3_SESSION);
    const removed = client.messages.flatMap((m) => (m.type === 'tree' ? m.removed : []));
    expect(removed).toEqual(['src/utils/legacy.ts']);
  });

  it('bashEditDiff delete + watcher unlink of the same path: exactly one delete (watcher first)', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const run3 = fixture('run3.jsonl', repo);
    await post(server.url, byTool(run3, 'PreToolUse', 'Bash', 'rm src/utils/legacy.ts'));
    fs.rmSync(path.join(repo, 'src/utils/legacy.ts'));
    await waitFor(() => client.events().some((e) => e.source === 'watcher'), 3000, 'watcher delete');
    await post(server.url, byTool(run3, 'PostToolUse', 'Bash', 'rm src/utils/legacy.ts'));
    await sleep(300);
    const deletes = client.events().filter((e) => e.action === 'delete' && e.phase === 'post' && e.paths.includes('src/utils/legacy.ts'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ source: 'watcher', sessionId: RUN3_SESSION });
  });

  it('Write on a new file: one hook create, no duplicate watcher event', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const run1 = fixture('run1.jsonl', repo);
    const pre = byTool(run1, 'PreToolUse', 'Write');
    await post(server.url, pre);
    fs.writeFileSync(path.join(repo, 'src/api/health.ts'), 'export function health() {}\n');
    await sleep(300); // the watcher sees the add while the Write is in flight
    await post(server.url, byTool(run1, 'PostToolUse', 'Write'));
    fs.appendFileSync(path.join(repo, 'src/api/health.ts'), '// late flush\n');
    await sleep(400);

    const onPath = client.events().filter((e) => e.paths.includes('src/api/health.ts'));
    expect(onPath.filter((e) => e.source === 'watcher')).toEqual([]);
    const creates = onPath.filter((e) => e.action === 'create' && e.phase === 'post');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ source: 'hook', sessionId: RUN1_SESSION, toolUseId: pre.tool_use_id });
    const added = client.messages.flatMap((m) => (m.type === 'tree' ? m.added : []));
    expect(added).toEqual([{ path: 'src/api/health.ts', kind: 'file' }]);
  });

  it('an external edit of a tracked file is an external edit event without a tree delta', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    fs.appendFileSync(path.join(repo, 'CLAUDE.md'), 'more\n');
    await waitFor(() => client.events().length > 0, 3000, 'external edit');
    expect(client.events()[0]).toMatchObject({ action: 'edit', paths: ['CLAUDE.md'], external: true, source: 'watcher' });
    expect(client.messages.some((m) => m.type === 'tree')).toBe(false);
  });
});

describe('one event per real file change (hook vs watcher)', () => {
  const SID = 'sess-dedupe';

  function bash(repo: string, event: string, id: string, command: string, extra: Record<string, unknown> = {}): HookPayload {
    return { hook_event_name: event, session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...extra };
  }

  function withDiff(files: Record<string, unknown>[]): Record<string, unknown> {
    return { tool_response: { stdout: '', stderr: '', bashEditDiff: { files, moreFiles: 0 } } };
  }

  /** Non-pre events that light `rel` (what the panel counts). */
  const counted = (client: Client, rel: string) =>
    client.events().filter((e) => e.phase !== 'pre' && (e.paths.includes(rel) || (e.fromPaths ?? []).includes(rel)));

  function makePlainRepo(files: Record<string, string>): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-plain-'));
    tmpDirs.push(repo);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), content);
    }
    return repo;
  }

  /** A rename keeps the birth time; the watcher uses it to tell a rename from a new file. */
  function age(repo: string, ...rels: string[]): void {
    const old = new Date(Date.now() - 60_000);
    for (const rel of rels) fs.utimesSync(path.join(repo, rel), old, old);
  }

  // Regression (F1 case 1): `echo hi > new.txt && sleep 3` with bashEditDiff lit new.txt twice,
  // because the watcher record expired 2 s before the Post arrived.
  it('bashEditDiff create arriving long after the watcher saw it: one create', async () => {
    let skew = 0;
    const { repo, server } = await start({ now: () => Date.now() + skew });
    const client = await connect(server.url);
    const abs = path.join(fs.realpathSync(repo), 'new.txt');
    await post(server.url, bash(repo, 'PreToolUse', 'b1', 'echo hi > new.txt && sleep 3'));
    fs.writeFileSync(abs, 'hi\n');
    await waitFor(() => counted(client, 'new.txt').length > 0, 3000, 'watcher create');
    skew = 3000; // the command keeps running
    await post(server.url, bash(repo, 'PostToolUse', 'b1', 'echo hi > new.txt && sleep 3', withDiff([{ filePath: abs, created: true, hunks: [] }])));
    await sleep(300);
    expect(counted(client, 'new.txt')).toHaveLength(1);
    expect(counted(client, 'new.txt')[0]).toMatchObject({ source: 'watcher', action: 'create', toolUseId: 'b1', sessionId: SID });
  });

  // Regression (F1 case 2): git mv with the watcher first gave delete + create + move.
  it('git mv with the watcher first: one move', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    age(repo, 'docs/old.md');
    const real = fs.realpathSync(repo);
    const cmd = 'git mv docs/old.md docs/notes.md && npm test';
    await post(server.url, bash(repo, 'PreToolUse', 'm1', cmd));
    fs.renameSync(path.join(repo, 'docs/old.md'), path.join(repo, 'docs/notes.md'));
    await waitFor(() => client.events().some((e) => e.source === 'watcher'), 3000, 'watcher move');
    await post(
      server.url,
      bash(repo, 'PostToolUse', 'm1', cmd, withDiff([
        { filePath: path.join(real, 'docs/notes.md'), created: true, hunks: [] },
        { filePath: path.join(real, 'docs/old.md'), deleted: true, hunks: [] },
      ])),
    );
    await sleep(300);
    const lit = client.events().filter((e) => e.phase !== 'pre' && FILE_CHANGE.has(e.action));
    expect(lit.map((e) => `${e.source}:${e.action}:${e.paths.join()}<${(e.fromPaths ?? []).join()}`)).toEqual(['watcher:move:docs/notes.md<docs/old.md']);
    const tree = (await (await fetch(server.url + '/tree')).json()) as TreeSnapshot;
    expect(tree.entries.map((e) => e.path)).toContain('docs/notes.md');
    expect(tree.entries.map((e) => e.path)).not.toContain('docs/old.md');
  });

  // Regression (F1 case 3): rm -r dir with the watcher first gave delete dir + one delete per file.
  it('rm -r dir with the watcher first: one delete for the dir', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const real = fs.realpathSync(repo);
    await post(server.url, bash(repo, 'PreToolUse', 'r1', 'rm -r src/utils'));
    fs.rmSync(path.join(repo, 'src/utils'), { recursive: true });
    await waitFor(() => client.events().some((e) => e.source === 'watcher'), 3000, 'watcher delete');
    await post(
      server.url,
      bash(repo, 'PostToolUse', 'r1', 'rm -r src/utils', withDiff([
        { filePath: path.join(real, 'src/utils/format.ts'), deleted: true, hunks: [] },
        { filePath: path.join(real, 'src/utils/legacy.ts'), deleted: true, hunks: [] },
      ])),
    );
    await sleep(300);
    const lit = client.events().filter((e) => e.phase !== 'pre' && FILE_CHANGE.has(e.action));
    expect(lit.map((e) => `${e.source}:${e.action}:${e.paths.join()}`)).toEqual(['watcher:delete:src/utils']);
  });

  // Regression (F2): without bashEditDiff, rm gave a hook post delete and a watcher delete.
  it('rm without bashEditDiff, watcher first: the hook guess is not counted again', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    await post(server.url, bash(repo, 'PreToolUse', 'g1', 'rm src/utils/legacy.ts'));
    fs.rmSync(path.join(repo, 'src/utils/legacy.ts'));
    await waitFor(() => counted(client, 'src/utils/legacy.ts').length > 0, 3000, 'watcher delete');
    await post(server.url, bash(repo, 'PostToolUse', 'g1', 'rm src/utils/legacy.ts', { tool_response: { stdout: '' } }));
    await sleep(300);
    expect(counted(client, 'src/utils/legacy.ts')).toHaveLength(1);
    expect(counted(client, 'src/utils/legacy.ts')[0]).toMatchObject({ source: 'watcher', action: 'delete', toolUseId: 'g1' });
  });

  it('rm without bashEditDiff, hook first: one delete, and the tree still loses the file', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    await post(server.url, bash(repo, 'PreToolUse', 'g2', 'rm src/utils/legacy.ts'));
    fs.rmSync(path.join(repo, 'src/utils/legacy.ts'));
    await post(server.url, bash(repo, 'PostToolUse', 'g2', 'rm src/utils/legacy.ts', { tool_response: { stdout: '' } }));
    await sleep(600);
    expect(counted(client, 'src/utils/legacy.ts')).toHaveLength(1);
    const removed = client.messages.flatMap((m) => (m.type === 'tree' ? m.removed : []));
    expect(removed).toEqual(['src/utils/legacy.ts']);
  });

  it('mv without bashEditDiff: one move whatever the order', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    age(repo, 'src/api/order.ts');
    await post(server.url, bash(repo, 'PreToolUse', 'v1', 'mv src/api/order.ts src/api/orders.ts'));
    fs.renameSync(path.join(repo, 'src/api/order.ts'), path.join(repo, 'src/api/orders.ts'));
    await post(server.url, bash(repo, 'PostToolUse', 'v1', 'mv src/api/order.ts src/api/orders.ts', { tool_response: { stdout: '' } }));
    await sleep(600);
    const lit = client.events().filter((e) => e.phase !== 'pre' && FILE_CHANGE.has(e.action));
    expect(lit).toHaveLength(1);
    expect(lit[0]).toMatchObject({ action: 'move', paths: ['src/api/orders.ts'], fromPaths: ['src/api/order.ts'] });
  });

  // Regression (F5): an external rename showed as a delete plus creates.
  it('an external dir rename is one external move', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    age(repo, 'src/api', 'src/api/user.ts', 'src/api/order.ts');
    fs.renameSync(path.join(repo, 'src/api'), path.join(repo, 'src/routes'));
    await waitFor(() => client.events().length > 0, 3000, 'external move');
    await sleep(400);
    expect(client.events()).toHaveLength(1);
    expect(client.events()[0]).toMatchObject({ action: 'move', paths: ['src/routes'], fromPaths: ['src/api'], external: true });
    const tree = (await (await fetch(server.url + '/tree')).json()) as TreeSnapshot;
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['src/routes', 'src/routes/user.ts', 'src/routes/order.ts']));
    expect(paths.some((p) => p.startsWith('src/api'))).toBe(false);
  });

  // Regression (dedupe by path only): the watcher lit tmp.txt as created, and the Bash guess
  // `rm tmp.txt` was dropped as "already shown" while it suppressed the watcher's unlink.
  it('a file created and then removed by one Bash (no bashEditDiff): one create and one delete', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    await post(server.url, bash(repo, 'PreToolUse', 't1', 'echo x > tmp.txt && sleep 1 && rm tmp.txt'));
    fs.writeFileSync(path.join(repo, 'tmp.txt'), 'x');
    await waitFor(() => counted(client, 'tmp.txt').length > 0, 3000, 'watcher create');
    fs.rmSync(path.join(repo, 'tmp.txt'));
    await post(server.url, bash(repo, 'PostToolUse', 't1', 'echo x > tmp.txt && sleep 1 && rm tmp.txt', { tool_response: { stdout: '' } }));
    await sleep(600);
    expect(counted(client, 'tmp.txt').map((e) => e.action)).toEqual(['create', 'delete']);
    const tree = (await (await fetch(server.url + '/tree')).json()) as TreeSnapshot;
    expect(tree.entries.map((e) => e.path)).not.toContain('tmp.txt');
  });

  it('a file edited and then deleted by one Bash with bashEditDiff: the delete is still shown', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const real = fs.realpathSync(repo);
    const cmd = "sed -i '' s/a/b/ src/utils/legacy.ts && sleep 1 && rm src/utils/legacy.ts";
    await post(server.url, bash(repo, 'PreToolUse', 'e1', cmd));
    fs.writeFileSync(path.join(repo, 'src/utils/legacy.ts'), 'changed\n');
    await waitFor(() => counted(client, 'src/utils/legacy.ts').length > 0, 3000, 'watcher edit');
    fs.rmSync(path.join(repo, 'src/utils/legacy.ts'));
    await post(server.url, bash(repo, 'PostToolUse', 'e1', cmd, withDiff([{ filePath: path.join(real, 'src/utils/legacy.ts'), deleted: true, hunks: [] }])));
    await sleep(600);
    expect(counted(client, 'src/utils/legacy.ts').map((e) => e.action)).toEqual(['edit', 'delete']);
  });

  it('a file created late in a dir the same Bash created: its create is still shown', async () => {
    const { repo, server } = await start();
    const client = await connect(server.url);
    const real = fs.realpathSync(repo);
    const cmd = 'mkdir out && echo > out/a && sleep 1 && echo > out/b';
    await post(server.url, bash(repo, 'PreToolUse', 'n1', cmd));
    fs.mkdirSync(path.join(repo, 'out'));
    fs.writeFileSync(path.join(repo, 'out/a'), 'a');
    await waitFor(() => counted(client, 'out/a').length > 0, 3000, 'watcher create');
    fs.writeFileSync(path.join(repo, 'out/b'), 'b');
    await post(
      server.url,
      bash(repo, 'PostToolUse', 'n1', cmd, withDiff([
        { filePath: path.join(real, 'out/a'), created: true, hunks: [] },
        { filePath: path.join(real, 'out/b'), created: true, hunks: [] },
      ])),
    );
    await sleep(600);
    expect(counted(client, 'out/a')).toHaveLength(1);
    expect(counted(client, 'out/b')).toHaveLength(1);
  });

  // Regression (F4): outside git, a hook create under build/ entered the tree and never left it.
  it('outside git, a hook create under a default exclude does not enter the tree', async () => {
    const repo = makePlainRepo({ 'a.txt': 'a' });
    const { server } = await start({ root: repo });
    const real = fs.realpathSync(repo);
    const input = { file_path: path.join(real, 'build/out.js'), content: 'x' };
    const write = { session_id: SID, cwd: repo, tool_name: 'Write', tool_use_id: 'w1', tool_input: input };
    await post(server.url, { ...write, hook_event_name: 'PreToolUse' });
    fs.mkdirSync(path.join(repo, 'build'));
    fs.writeFileSync(path.join(repo, 'build/out.js'), 'x');
    await post(server.url, { ...write, hook_event_name: 'PostToolUse', tool_response: { type: 'create' } });
    await sleep(200);
    fs.rmSync(path.join(repo, 'build'), { recursive: true });
    await sleep(400);
    const tree = (await (await fetch(server.url + '/tree')).json()) as TreeSnapshot;
    expect(tree.entries.map((e) => e.path)).toEqual(['a.txt']);
  });

  // Regression (F8): `neu start` installing its hooks showed up as an external create.
  it('its own settings.local.json write right after startup is not an event (the tree still shows it)', async () => {
    const repo = makePlainRepo({ 'a.txt': 'a' });
    const { server } = await start({ root: repo });
    const client = await connect(server.url);
    // Same shape as src/install/settings.ts: temp file in the same dir, then rename.
    fs.mkdirSync(path.join(repo, '.claude'));
    const tmp = path.join(repo, '.claude', `.settings.local.json.${process.pid}.a1b2c3d4.tmp`);
    fs.writeFileSync(tmp, '{"hooks":{}}\n');
    fs.renameSync(tmp, path.join(repo, '.claude/settings.local.json'));
    await waitFor(() => client.messages.some((m) => m.type === 'tree'), 3000, 'tree delta');
    await sleep(400);
    expect(client.events()).toEqual([]);
    const tree = (await (await fetch(server.url + '/tree')).json()) as TreeSnapshot;
    expect(tree.entries.map((e) => e.path)).toEqual(['.claude', '.claude/settings.local.json', 'a.txt']);
  });
});

describe('WebSocket', () => {
  it('rejects an upgrade from a foreign Origin', async () => {
    const { server } = await start({ watch: false });
    const url = server.url.replace('http://', 'ws://') + '/ws';
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { origin: 'http://evil.example' });
      sockets.push(ws);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('foreign origin was accepted')));
      ws.on('error', () => {});
    });
    expect(status).toBe(403);
  });

  it('rejects an upgrade from a page on another local port', async () => {
    const { server } = await start({ watch: false });
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8888', `https://127.0.0.1:${server.port}`]) {
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(server.url.replace('http://', 'ws://') + '/ws', { origin });
        sockets.push(ws);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => reject(new Error(`${origin} was accepted`)));
        ws.on('error', () => {});
      });
      expect(status, origin).toBe(403);
    }
  });

  it('accepts its own origins and explicit extra ones, and rejects other paths', async () => {
    const { server } = await start({ watch: false, allowedOrigins: ['http://localhost:5173/'] });
    const port = server.port;
    await connect(server.url, `http://localhost:${port}`);
    await connect(server.url, `http://127.0.0.1:${port}`);
    await connect(server.url, 'http://localhost:5173');
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      sockets.push(ws);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => {});
    });
    expect(status).toBe(404);
  });

  it('reads extra origins from NEURONS_ALLOWED_ORIGINS and the legacy REPO_SYNAPSE_ALLOWED_ORIGINS', () => {
    const saved = [process.env.NEURONS_ALLOWED_ORIGINS, process.env.REPO_SYNAPSE_ALLOWED_ORIGINS];
    try {
      process.env.NEURONS_ALLOWED_ORIGINS = 'http://localhost:5173, bad origin';
      process.env.REPO_SYNAPSE_ALLOWED_ORIGINS = 'http://localhost:4000/';
      expect([...allowedOriginSet(7777)].sort()).toEqual(
        ['http://127.0.0.1:7777', 'http://localhost:4000', 'http://localhost:5173', 'http://localhost:7777'].sort(),
      );
    } finally {
      for (const [k, v] of [['NEURONS_ALLOWED_ORIGINS', saved[0]], ['REPO_SYNAPSE_ALLOWED_ORIGINS', saved[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('sends recent events in hello to late clients', async () => {
    const { server } = await start({ watch: false });
    await post(server.url, { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hola' });
    await sleep(50);
    const client = await connect(server.url);
    const hello = client.messages[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.recent.map((e) => e.action)).toEqual(['session_start', 'turn_start']);
    expect(hello.sessions.map((s) => s.sessionId)).toEqual(['s']);
  });
});

describe('HTTP routes', () => {
  it('serves health, tree, sessions, log and static files with SPA fallback', async () => {
    const { server } = await start({ watch: false });
    const get = (p: string) => fetch(server.url + p);

    const health = await get('/health');
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    const tree = (await (await get('/tree')).json()) as TreeSnapshot;
    expect(tree.entries.some((e) => e.path === 'docs/old.md')).toBe(true);

    expect(await (await get('/api/sessions')).json()).toEqual([]);
    const log = (await (await get('/api/log')).json()) as LogLine[];
    expect(log.map((l) => l.kind)).toEqual(['tree']);

    const index = await get('/');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<title>Neurons</title>');
    const js = await get('/assets/app.js');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    const css = await get('/assets/app.css');
    expect(css.headers.get('content-type')).toContain('text/css');
    const spa = await get('/some/client/route');
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('Neurons');

    const traversal = await get('/..%2f..%2fetc%2fpasswd');
    expect(await traversal.text()).not.toContain('root:');

    const wrongMethod = await fetch(server.url + '/hook', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.redirected).toBe(false);
  });

  it('rejects requests whose Host is not loopback (DNS rebinding)', async () => {
    const { server } = await start({ watch: false });
    const status = await new Promise<number>((resolve, reject) => {
      const req = net.connect(server.port, '127.0.0.1', () => {
        req.write('GET /api/log HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      req.on('data', (d) => (buf += String(d)));
      req.on('end', () => resolve(Number(buf.split(' ')[1])));
      req.on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('falls back to the next free port unless portStrict', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      const repo = makeRepo();
      const { server } = await start({ root: repo, port: busy, watch: false });
      expect(server.port).toBeGreaterThan(busy);
      expect(server.port).toBeLessThanOrEqual(busy + 20);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      await expect(startNeuronsServer({ root: repo, port: busy, portStrict: true, mode: 'live', watch: false, logFile: path.join(repo, 'x.jsonl') })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe('replay mode', () => {
  it('serves the log, says hello with mode replay and the first tree, and ignores hooks', async () => {
    const live = await start({ watch: false });
    await post(live.server.url, { hook_event_name: 'UserPromptSubmit', session_id: 'r1', prompt: 'uno' });
    await sleep(50);
    await live.server.close();
    servers.splice(servers.indexOf(live.server), 1);
    // A truncated tail must not break the reader.
    fs.appendFileSync(live.logFile, '{"kind":"event","event":{"id"');

    const { server } = await start({ root: live.repo, mode: 'replay', replayFile: live.logFile });
    const client = await connect(server.url);
    const hello = client.messages[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    expect(hello.mode).toBe('replay');
    expect(hello.recent).toEqual([]);
    expect(hello.tree.entries.some((e) => e.path === 'src/api/user.ts')).toBe(true);
    expect(hello.sessions.map((s) => s.sessionId)).toEqual(['r1']);

    const log = (await (await fetch(server.url + '/api/log')).json()) as LogLine[];
    expect(log.map((l) => l.kind)).toEqual(['tree', 'event', 'event']);

    expect((await post(server.url, { hook_event_name: 'UserPromptSubmit', session_id: 'r2', prompt: 'dos' })).status).toBe(204);
    await sleep(100);
    expect(client.events()).toEqual([]);
    const after = (await (await fetch(server.url + '/api/log')).json()) as LogLine[];
    expect(after).toHaveLength(3);
  });

  // Regression: a session open when a run closed stayed active for the rest of the log.
  it('a new server run in the log ends the sessions the previous one left open', async () => {
    const first = await start({ watch: false });
    await post(first.server.url, { hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: 'uno' });
    await sleep(50);
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const second = await start({ root: first.repo, watch: false });
    await post(second.server.url, { hook_event_name: 'UserPromptSubmit', session_id: 'b', prompt: 'dos' });
    await sleep(50);
    await second.server.close();
    servers.splice(servers.indexOf(second.server), 1);

    const { server } = await start({ root: first.repo, mode: 'replay', replayFile: first.logFile });
    const client = await connect(server.url);
    const hello = client.messages[0];
    if (hello?.type !== 'hello') throw new Error('no hello');
    const byId = Object.fromEntries(hello.sessions.map((s) => [s.sessionId, s.ended]));
    expect(byId).toEqual({ a: true, b: false });
  });
});
