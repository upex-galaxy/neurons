// HTTP + WebSocket server: receives Claude Code HTTP hooks, merges them with
// disk changes from the watcher, logs everything to JSONL and broadcasts it.
//
//   POST /hook       hook payloads (204, empty body, sent before processing)
//   GET  /health     "ok"
//   GET  /tree       current TreeSnapshot
//   GET  /api/sessions, /api/log
//   GET  /ws         WebSocket upgrade (loopback Origin only)
//   GET  /*          static web UI with SPA fallback

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  LogLine,
  ServerMessage,
  SessionInfo,
  TreeEntry,
  TreeSnapshot,
  VizEvent,
} from '../shared/types.ts';
import { Attributor, type Attribution, type DiskChange, type Owner } from './attribution.ts';
import { EventLog, readLog } from './eventlog.ts';
import { Normalizer, parseHookPayload, type HookPayload } from './normalize.ts';
import { createPathResolver } from './paths.ts';
import { isGitIgnored, scanTree, TreeIndex } from './tree.ts';
import { startWatcher, type WatcherHandle } from './watcher.ts';

export interface SynapseServerOptions {
  root: string;
  port: number;
  host?: string;
  /** false: when the port is taken, try the next ones (up to +20). */
  portStrict?: boolean;
  mode: 'live' | 'replay';
  /** Static web UI dir. Default: dist/web resolved from this module. */
  webDir?: string;
  /** Live mode log. Default: <root>/.repo-synapse/events.jsonl. */
  logFile?: string;
  /** Watch the disk (live mode only). Default true. */
  watch?: boolean;
  /** Replay mode source. Default: <root>/.repo-synapse/events.jsonl. */
  replayFile?: string;
  now?: () => number;
  /** Watcher coalescing window (ms). */
  coalesceMs?: number;
  /** Called with errors that are swallowed to keep the server alive. */
  onError?: (err: unknown) => void;
  /**
   * Extra browser origins allowed on /ws and /hook besides the server's own
   * (http://127.0.0.1:<port> and http://localhost:<port>), e.g. the Vite dev server.
   * Also read from REPO_SYNAPSE_ALLOWED_ORIGINS (comma separated).
   */
  allowedOrigins?: string[];
}

export interface SynapseServer {
  port: number;
  url: string;
  close(): Promise<void>;
  broadcast(m: ServerMessage): void;
}

const RING_SIZE = 500;
const MAX_BODY = 64 * 1024 * 1024;
const PORT_TRIES = 20;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const FILE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// ---------------------------------------------------------------- helpers

function defaultWebDir(): string | undefined {
  const candidates = [
    fileURLToPath(new URL('./web', import.meta.url)), // bundled: dist/cli.mjs -> dist/web
    fileURLToPath(new URL('../../dist/web', import.meta.url)), // source: src/server -> dist/web
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
}

/** Serialized origin ("http://localhost:5173") or undefined when it does not parse. */
function normalizeOrigin(origin: string): string | undefined {
  try {
    const o = new URL(origin).origin;
    return o === 'null' ? undefined : o;
  } catch {
    return undefined;
  }
}

/** The server's own origins plus the extra ones from options and REPO_SYNAPSE_ALLOWED_ORIGINS. */
export function allowedOriginSet(port: number, extra: readonly string[] = []): Set<string> {
  const fromEnv = (process.env.REPO_SYNAPSE_ALLOWED_ORIGINS ?? '').split(',');
  const set = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  for (const o of [...extra, ...fromEnv]) {
    const n = o.trim() === '' ? undefined : normalizeOrigin(o.trim());
    if (n) set.add(n);
  }
  return set;
}

/**
 * Browser origin check for /ws and /hook: no Origin (Claude Code, non-browser clients)
 * or exactly one of `allowed`. Other local ports are rejected: a page served by some
 * other dev server must not read the stream or inject hooks.
 */
export function isAllowedOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined || origin === '') return true;
  const n = normalizeOrigin(origin);
  return n !== undefined && allowed.has(n);
}

/** Host header must name a loopback host (blocks DNS rebinding). Missing Host is allowed. */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name !== undefined && LOOPBACK_HOSTS.has(name.toLowerCase());
}

function hasBashEditDiff(p: HookPayload): boolean {
  const res = p.tool_response;
  if (typeof res !== 'object' || res === null) return false;
  const diff = (res as Record<string, unknown>).bashEditDiff;
  if (typeof diff !== 'object' || diff === null) return false;
  const files = (diff as Record<string, unknown>).files;
  return Array.isArray(files) && files.length > 0;
}

/** Hook events whose paths are exact file changes (not a guess from a Bash command line). */
function isExactFileChange(p: HookPayload, ev: VizEvent): boolean {
  if (ev.source !== 'hook' || ev.phase !== 'post') return false;
  if (ev.action !== 'create' && ev.action !== 'delete' && ev.action !== 'move' && ev.action !== 'edit') return false;
  if (ev.toolName === 'Bash') return hasBashEditDiff(p);
  return ev.toolName !== undefined && FILE_CHANGE_TOOLS.has(ev.toolName);
}

/** Sessions rebuilt from logged events (replay mode). */
function sessionsFromLog(lines: LogLine[]): SessionInfo[] {
  const map = new Map<string, SessionInfo>();
  for (const line of lines) {
    if (line.kind !== 'event' || line.event.source !== 'hook') continue;
    const e = line.event;
    let s = map.get(e.sessionId);
    if (!s) {
      s = { sessionId: e.sessionId, firstSeen: e.ts, lastSeen: e.ts, ended: false, agents: {} };
      map.set(e.sessionId, s);
    }
    s.lastSeen = Math.max(s.lastSeen, e.ts);
    if (e.action === 'session_end') s.ended = true;
    else if (e.action === 'session_start') s.ended = false;
    if (e.agentId) s.agents[e.agentId] = e.agentType ?? s.agents[e.agentId] ?? '';
  }
  return [...map.values()];
}

function sessionsSignature(sessions: SessionInfo[]): string {
  return JSON.stringify(
    sessions.map((s) => [s.sessionId, s.ended, Object.entries(s.agents).sort()]),
  );
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// ---------------------------------------------------------------- server

export async function startSynapseServer(o: SynapseServerOptions): Promise<SynapseServer> {
  const host = o.host ?? '127.0.0.1';
  const now = o.now ?? Date.now;
  const onError = o.onError ?? (() => {});
  const live = o.mode === 'live';
  const defaultLog = path.join(path.resolve(o.root), '.repo-synapse', 'events.jsonl');
  const webDir = o.webDir ?? defaultWebDir();

  // --- state
  const ring: VizEvent[] = [];
  const clients = new Set<WebSocket>();
  let index: TreeIndex;
  let normalizer: Normalizer | undefined;
  let attributor: Attributor | undefined;
  let log: EventLog | undefined;
  let watcher: WatcherHandle | undefined;
  let replayTree: TreeSnapshot | undefined;
  let replayLines: LogLine[] = [];
  let replayFile: string | undefined;
  let lastSessionsSig = '[]';
  /** Filled once the port is known; no request arrives before that. */
  let allowedOrigins: Set<string> = new Set();

  if (live) {
    const snapshot = await scanTree(o.root);
    index = new TreeIndex(snapshot);
    const resolver = createPathResolver(snapshot.root);
    normalizer = new Normalizer({ resolver, index, now });
    attributor = new Attributor({ now, resolver });
    log = new EventLog(o.logFile ?? path.join(snapshot.root, '.repo-synapse', 'events.jsonl'), { now });
    log.writeTree(snapshot);
  } else {
    replayFile = o.replayFile ?? defaultLog;
    replayLines = readLog(replayFile);
    const first = replayLines.find((l) => l.kind === 'tree');
    replayTree = first?.kind === 'tree' ? first.tree : await scanTree(o.root);
    index = new TreeIndex(replayTree);
  }

  function currentSessions(): SessionInfo[] {
    return live ? (normalizer?.sessions() ?? []) : sessionsFromLog(replayLines);
  }

  function broadcast(m: ServerMessage): void {
    if (clients.size === 0) return;
    const data = JSON.stringify(m);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function emitEvent(ev: VizEvent): void {
    ring.push(ev);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    log?.writeEvent(ev);
    broadcast({ type: 'event', event: ev });
  }

  function emitDelta(added: TreeEntry[], removed: string[]): void {
    if (added.length === 0 && removed.length === 0) return;
    log?.writeDelta(added, removed);
    broadcast({ type: 'tree', added, removed });
  }

  function maybeBroadcastSessions(): void {
    const sessions = currentSessions();
    const sig = sessionsSignature(sessions);
    if (sig === lastSessionsSig) return;
    lastSessionsSig = sig;
    broadcast({ type: 'sessions', sessions });
  }

  // --- hooks

  function processHook(raw: string): void {
    if (!live || !normalizer || !attributor) return;
    const p = parseHookPayload(raw);
    if (!p) return;
    attributor.onHook(p);
    const events = normalizer.normalize(p);
    for (const ev of events) {
      if (!isExactFileChange(p, ev)) {
        emitEvent(ev);
        continue;
      }
      const owner: Owner = { sessionId: ev.sessionId };
      if (ev.agentId) owner.agentId = ev.agentId;
      if (ev.toolUseId) owner.toolUseId = ev.toolUseId;
      if (ev.promptId) owner.promptId = ev.promptId;
      attributor.noteReported([...ev.paths, ...(ev.fromPaths ?? [])], owner);

      const added: TreeEntry[] = [];
      const removed: string[] = [];
      if (ev.action === 'create' || ev.action === 'move') {
        for (const rel of ev.paths) added.push(...index.add(rel, 'file'));
      }
      if (ev.action === 'delete') for (const rel of ev.paths) removed.push(...index.remove(rel));
      if (ev.action === 'move') for (const rel of ev.fromPaths ?? []) removed.push(...index.remove(rel));

      // The watcher may have beaten a Bash post to it: do not light the same change twice.
      let out: VizEvent | undefined = ev;
      if (ev.toolName === 'Bash' && ev.action !== 'move') {
        const paths = ev.paths.filter((rel) => !attributor?.wasEmitted(rel, ev.action));
        out = paths.length === 0 && ev.paths.length > 0 ? undefined : { ...ev, paths };
      }

      emitDelta(added, []);
      if (out) emitEvent(out);
      emitDelta([], removed);
    }
    maybeBroadcastSessions();
  }

  // --- watcher

  function watcherEvent(c: DiskChange, a: Attribution): VizEvent {
    const action = c.type === 'add' || c.type === 'addDir' ? 'create' : c.type === 'change' ? 'edit' : 'delete';
    const ev: VizEvent = {
      id: randomUUID(),
      ts: now(),
      sessionId: a.attributed && a.sessionId ? a.sessionId : 'external',
      phase: 'post',
      action,
      paths: [c.path],
      source: 'watcher',
    };
    if (a.attributed) {
      if (a.promptId) ev.promptId = a.promptId;
      if (a.agentId) ev.agentId = a.agentId;
      if (a.toolUseId) ev.toolUseId = a.toolUseId;
    } else {
      ev.external = true;
    }
    return ev;
  }

  function onDiskChange(c: DiskChange): void {
    if (!attributor) return;
    try {
      const added: TreeEntry[] = [];
      const removed: string[] = [];
      if (c.type === 'add') added.push(...index.add(c.path, 'file'));
      else if (c.type === 'addDir') added.push(...index.add(c.path, 'dir'));
      else if (c.type === 'unlink' || c.type === 'unlinkDir') removed.push(...index.remove(c.path));

      const a = attributor.classify(c);
      emitDelta(added, []);
      if (!a.suppressed) {
        const ev = watcherEvent(c, a);
        attributor.noteEmitted(c.path, ev.action);
        emitEvent(ev);
      }
      emitDelta([], removed);
    } catch (err) {
      onError(err);
    }
  }

  if (live && o.watch !== false) {
    const root = index.root;
    const isGit = fs.existsSync(path.join(root, '.git'));
    const watchOpts: Parameters<typeof startWatcher>[0] = {
      root,
      index,
      onChange: onDiskChange,
      excludeDefaults: !isGit,
      onError,
    };
    if (o.coalesceMs !== undefined) watchOpts.coalesceMs = o.coalesceMs;
    if (isGit) watchOpts.isIgnored = (rels) => isGitIgnored(root, rels);
    watcher = startWatcher(watchOpts);
  }

  // --- http

  async function handleLog(res: http.ServerResponse): Promise<void> {
    if (live && log) {
      await log.flush();
      sendJson(res, 200, readLog(log.file));
    } else {
      sendJson(res, 200, replayFile ? readLog(replayFile) : []);
    }
  }

  function serveStatic(pathname: string, res: http.ServerResponse, headOnly: boolean): void {
    if (!webDir) {
      sendText(res, 404, 'La interfaz no está compilada. Ejecutá npm run build:web.');
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      sendText(res, 400, 'Ruta inválida.');
      return;
    }
    const base = path.resolve(webDir);
    let file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    if (file !== base && !file.startsWith(base + path.sep)) {
      sendText(res, 404, 'No encontrado.');
      return;
    }
    let st = fs.statSync(file, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.statSync(file, { throwIfNoEntry: false });
    }
    if (!st?.isFile()) {
      // SPA fallback.
      file = path.join(base, 'index.html');
      st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st?.isFile()) {
        sendText(res, 404, 'No encontrado.');
        return;
      }
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const isHtml = type.startsWith('text/html');
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    if (headOnly) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  function handleHook(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Claude Code never sends an Origin; a browser page posting here does.
    const foreign = !isAllowedOrigin(req.headers.origin, allowedOrigins);
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let answered = false;
    const answer = () => {
      if (answered) return;
      answered = true;
      res.writeHead(204);
      res.end();
    };
    req.on('data', (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', answer);
    req.on('end', () => {
      answer();
      if (overflow || foreign || chunks.length === 0) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      setImmediate(() => {
        try {
          processHook(raw);
        } catch (err) {
          onError(err);
        }
      });
    });
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? 'GET';
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendText(res, 400, 'Solicitud inválida.');
      return;
    }

    if (pathname === '/hook') {
      if (method !== 'POST') {
        sendText(res, 405, 'Método no permitido.');
        return;
      }
      handleHook(req, res);
      return;
    }

    if (!isLoopbackHost(req.headers.host)) {
      sendText(res, 403, 'Host no permitido.');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Método no permitido.');
      return;
    }
    switch (pathname) {
      case '/health':
        sendText(res, 200, 'ok');
        return;
      case '/tree':
        sendJson(res, 200, live ? index.snapshot() : replayTree);
        return;
      case '/api/sessions':
        sendJson(res, 200, currentSessions());
        return;
      case '/api/log':
        handleLog(res).catch((err) => {
          onError(err);
          if (!res.headersSent) sendText(res, 500, 'Error al leer el registro.');
        });
        return;
      default:
        serveStatic(pathname, res, method === 'HEAD');
    }
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      onError(err);
      if (!res.headersSent) sendText(res, 500, 'Error interno.');
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 65_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    // The protocol is server -> client only; client messages are ignored.
    const hello: ServerMessage = {
      type: 'hello',
      mode: live ? 'live' : 'replay',
      tree: live ? index.snapshot() : (replayTree as TreeSnapshot),
      recent: live ? [...ring] : [],
      sessions: currentSessions(),
    };
    ws.send(JSON.stringify(hello));
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, allowedOrigins) || !isLoopbackHost(req.headers.host)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // --- listen

  let port = o.port;
  const tries = o.portStrict || o.port === 0 ? 1 : PORT_TRIES + 1;
  for (let i = 0; i < tries; i++) {
    try {
      await listen(server, port, host);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || i === tries - 1) {
        await watcher?.close();
        await log?.close();
        throw err;
      }
      port++;
    }
  }
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  allowedOrigins = allowedOriginSet(actualPort, o.allowedOrigins);
  const urlHost = host.includes(':') ? `[${host}]` : host;

  let closing: Promise<void> | undefined;
  return {
    port: actualPort,
    url: `http://${urlHost}:${actualPort}`,
    broadcast,
    close(): Promise<void> {
      closing ??= (async () => {
        await watcher?.close();
        for (const ws of clients) ws.terminate();
        clients.clear();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await log?.close();
      })();
      return closing;
    },
  };
}
