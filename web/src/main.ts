// Entry point: wires the WebSocket, the tree model, the renderer (3D or 2D), the side
// panel, replay and window.__viz / window.__vizState.
import './style.css';
import { ACTION_COLORS, type ServerMessage, type SessionInfo, type TreeEntry, type TreeSnapshot, type VizEvent } from '../../src/shared/types.ts';
import { agentColor, rememberAgent } from './agents.ts';
import { eventTargets, playEvent, waitsForDelta, type EffectsContext } from './effects.ts';
import { FADE_OUT_MS } from './glow.ts';
import { createGraph2D } from './graph2d.ts';
import { DAG_LEVEL_DISTANCE, createGraph3D } from './graph3d.ts';
import { STATUS_LABELS } from './labels.ts';
import { LabelOverlay, MAX_OVERLAY_LABELS, type OverlayItem } from './overlay.ts';
import { Panel, type SessionRow } from './panel.ts';
import { escapeHtml, type Renderer, type RendererKind, type RendererOptions } from './renderer.ts';
import { ReplayController } from './replay.ts';
import { FEED_LIMIT, pushBounded, resetState, startFpsMeter, vizState, type Filters } from './state.ts';
import { EventStore, accumulate, emptyAggregate, heatIntensity, passes, type Aggregate } from './store.ts';
import { OUTSIDE_HUB_ID, ROOT_ID, TreeModel, pinOutside, type VizNode } from './treeModel.ts';
import { connect, defaultWsUrl, type ConnectionStatus } from './ws.ts';

const params = new URLSearchParams(location.search);
const TREE_DEBOUNCE_MS = 150;
/** Structural changes caused by an event (reveal, satellites) flush almost at once. */
const REVEAL_DEBOUNCE_MS = 16;
/** Let the library bind new link endpoints before particles run on them. */
const PLAY_AFTER_FLUSH_MS = 34;
const SEED_JITTER = 4;
const HEAT_INTERVAL_MS = 100;
const BUDGET = Number(params.get('budget')) > 0 ? Number(params.get('budget')) : 1500;
const SOCKET_ENABLED = params.get('ws') !== '0';
const VIEW_KEY = 'repo-synapse:view';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

type Hello = Extract<ServerMessage, { type: 'hello' }>;

const model = new TreeModel();
const store = new EventStore();
let agg: Aggregate = emptyAggregate();
const sessions = new Map<string, SessionRow>();
let lastHello: Hello | null = null;

// ---------- renderer ----------

const graphEl = el('graph');

function nodeLabel(n: VizNode): string {
  if (n.id === ROOT_ID) return escapeHtml(`${n.name} (raíz)`);
  if (n.id === OUTSIDE_HUB_ID) return 'fuera del repo';
  if (n.outside) return escapeHtml(n.kind === 'dir' ? `${n.name} · fuera del repo` : n.id);
  if (n.collapsed) {
    const count = model.descendantCount(n.id).toLocaleString('es');
    return escapeHtml(`${n.id}/ · ${count} elementos ocultos (clic para abrir)`);
  }
  return escapeHtml(n.kind === 'dir' ? `${n.id}/` : n.id);
}

const rendererOptions: RendererOptions = {
  label: nodeLabel,
  onNodeClick: (n) => toggleCollapse(n.id),
};

function makeRenderer(kind: RendererKind): Renderer {
  if (kind === '3d') {
    try {
      return createGraph3D(graphEl, rendererOptions);
    } catch (err) {
      // No WebGL: fall back to the canvas view.
      console.warn('[repo-synapse] 3D no disponible, uso 2D', err);
      graphEl.replaceChildren();
    }
  }
  return createGraph2D(graphEl, rendererOptions);
}

function initialKind(): RendererKind {
  const q = params.get('view');
  if (q === '2d' || q === '3d') return q;
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === '2d' || saved === '3d') return saved;
  } catch {
    // Storage blocked: default view.
  }
  return '3d';
}

let view: Renderer = makeRenderer(initialKind());
vizState.renderer = view.kind;

const overlay = new LabelOverlay(el('stage'), () => view);

const ctx: EffectsContext = {
  model,
  view: () => view,
  agentColor,
  onFirstEmit(event) {
    if (!vizState.replay.active) vizState.lastEventLatencyMs = Date.now() - event.ts;
  },
  generation: () => generation,
};

// ---------- rendering the model ----------

function seedPositions(nodes: VizNode[]): void {
  // data() lists parents before children, so a parent is always seeded first.
  const jitter = (): number => (Math.random() - 0.5) * 2 * SEED_JITTER;
  for (const node of nodes) {
    if (node.x !== undefined) continue;
    const parent = node.parentId !== null ? model.get(node.parentId) : undefined;
    node.x = (parent?.x ?? 0) + jitter();
    node.y = (parent?.y ?? 0) + jitter();
    node.z = (parent?.z ?? 0) + jitter();
  }
}

function render(initial: boolean): void {
  const data = model.data();
  seedPositions(data.nodes);
  const live = view.setData(data, initial);
  model.syncLive(live);
  if (initial) view.onFirstLayout(() => (vizState.ready = true));
  let collapsed = 0;
  let satellites = 0;
  for (const n of data.nodes) {
    if (n.collapsed) collapsed++;
    if (n.outside && n.kind === 'file') satellites++;
  }
  vizState.collapsedCount = collapsed;
  vizState.satelliteCount = satellites;
  syncCounts();
  refreshOverlay();
  heatDirty = true;
}

function syncCounts(): void {
  vizState.nodeCount = model.nodeCount;
  vizState.linkCount = model.linkCount;
  vizState.visibleNodeCount = model.visibleCount;
  el('node-count').textContent =
    vizState.visibleNodeCount < vizState.nodeCount
      ? `${vizState.visibleNodeCount.toLocaleString('es')} de ${vizState.nodeCount.toLocaleString('es')} nodos`
      : `${vizState.nodeCount.toLocaleString('es')} nodos`;
}

function refreshOverlay(): void {
  const items: OverlayItem[] = [];
  const root = model.get(ROOT_ID);
  if (root) items.push({ node: root, text: root.name, kind: 'root' });
  const hub = model.get(OUTSIDE_HUB_ID);
  if (hub) items.push({ node: hub, text: 'fuera del repo', kind: 'hub' });
  const room = MAX_OVERLAY_LABELS - items.length;
  let tops = model
    .childrenOf(ROOT_ID)
    .map((id) => model.get(id))
    .filter((n): n is VizNode => !!n && n.kind === 'dir' && !n.removing);
  const counts = new Map<string, number>();
  const countOf = (id: string): number => {
    let c = counts.get(id);
    if (c === undefined) {
      c = model.descendantCount(id);
      counts.set(id, c);
    }
    return c;
  };
  // Biggest first: they win when labels overlap (see LabelOverlay.declutter).
  tops = tops.sort((a, b) => countOf(b.id) - countOf(a.id)).slice(0, room);
  for (const n of tops) {
    items.push({ node: n, text: n.collapsed ? `${n.name} (+${countOf(n.id).toLocaleString('es')})` : n.name, kind: 'dir' });
  }
  overlay.set(items);
}

function hubRadius(): number {
  return (Math.min(model.maxDepth(), 12) + 2.5) * DAG_LEVEL_DISTANCE;
}

// ---------- structural updates, batched ----------

let pendingAdded: TreeEntry[] = [];
let pendingRemoved: string[] = [];
let purgeQueue: string[] = [];
let queuedPlays: VizEvent[] = [];
let structureDirty = false;
let outsideDirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDue = 0;
/** The camera was re-framed to include the outside hub. */
let hubFramed = false;
/** Bumped on every reset so stale purge and effect timers from a previous tree do nothing. */
let generation = 0;
/**
 * Id -> the fade that marked it `removing`. A purge timer only purges the ids whose mark is
 * still its own: a path revived and removed again waits for its new fade to finish.
 */
const fadeMarks = new Map<string, number>();
let fadeSeq = 0;

function scheduleFlush(delay: number): void {
  const due = performance.now() + delay;
  if (flushTimer !== null && flushDue <= due) return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushDue = due;
  flushTimer = setTimeout(flushGraph, delay);
}

function flushGraph(): void {
  flushTimer = null;
  const now = Date.now();
  let changed = structureDirty;
  structureDirty = false;
  const created: string[] = [];

  if (pendingAdded.length || pendingRemoved.length) {
    const result = model.applyDelta(pendingAdded, pendingRemoved);
    pendingAdded = [];
    pendingRemoved = [];
    for (const node of result.added) {
      pushBounded(vizState.created, node.id);
      created.push(node.id);
    }
    if (result.added.length) changed = true;
    // Back before its purge (rm then re-create): stop the fade, it counts as created.
    for (const id of result.revived) {
      fadeMarks.delete(id);
      view.cancelFade(id);
      pushBounded(vizState.created, id);
      created.push(id);
    }
    if (result.removing.length) {
      const seq = ++fadeSeq;
      for (const id of result.removing) {
        fadeMarks.set(id, seq);
        view.fadeOut(id);
        pushBounded(vizState.removed, id);
      }
      const ids = result.removing;
      const gen = generation;
      setTimeout(() => {
        if (gen !== generation) return;
        for (const id of ids) {
          if (fadeMarks.get(id) !== seq) continue;
          fadeMarks.delete(id);
          purgeQueue.push(id);
        }
        scheduleFlush(0);
      }, FADE_OUT_MS);
    }
  }

  // Events that waited for this delta: their new targets exist now and may sit in a collapsed dir.
  for (const e of queuedPlays) if (revealTargets(e, now)) changed = true;

  if (purgeQueue.length) {
    const gone = model.purge(purgeQueue);
    purgeQueue = [];
    if (gone.length) {
      view.forget(gone);
      changed = true;
    }
  }

  if (outsideDirty) {
    outsideDirty = false;
    pinOutside(model, hubRadius());
    changed = true;
    if (!hubFramed) {
      // The hub sits outside the framed tree: re-frame once when it first appears.
      hubFramed = true;
      setTimeout(() => view.zoomToFit(800), 400);
    }
  }

  if (model.visibleCount > BUDGET * 1.3) {
    for (const id of model.recollapse(BUDGET, now)) {
      const n = model.get(id);
      if (n) view.refreshNode(n);
      changed = true;
    }
  }

  if (changed) render(false);

  // Green flash where a new node appears (it was seeded next to its parent).
  for (const id of created) if (model.isVisible(id)) view.pulse(id, ACTION_COLORS.create, { intensity: 1 });

  const plays = queuedPlays;
  queuedPlays = [];
  if (plays.length) {
    const gen = generation;
    setTimeout(() => {
      if (gen !== generation) return;
      for (const e of plays) playEvent(ctx, e);
    }, PLAY_AFTER_FLUSH_MS);
  }
}

// ---------- events ----------

let heatDirty = false;
let countersDirty = false;
let sessionsDirty = false;
let agentsDirty = false;

/** Expands the collapsed dirs hiding the event's targets. True when one was expanded. */
function revealTargets(event: VizEvent, now: number): boolean {
  let changed = false;
  for (const p of eventTargets(event)) {
    for (const id of model.reveal(p, now)) {
      const n = model.get(id);
      if (n) view.refreshNode(n);
      changed = true;
    }
    model.touch(p, now);
  }
  return changed;
}

/** Makes the event's targets visible (auto-expand) and plays it, after a flush if needed. */
function stage(event: VizEvent): void {
  const changed = revealTargets(event, Date.now());
  // A create's tree delta arrives just before it and is still buffered: flush it first so
  // the light reaches the new file and not its parent dir.
  if (changed || outsideDirty || queuedPlays.length || waitsForDelta(event, model, pendingAdded)) {
    queuedPlays.push(event);
    structureDirty = true;
    scheduleFlush(REVEAL_DEBOUNCE_MS);
    return;
  }
  playEvent(ctx, event);
}

/** Records an event (feed, counters, heat) and, when `animate`, lights it up. */
function ingest(event: VizEvent, animate: boolean): void {
  if (event.agentId && rememberAgent(event.agentId, event.agentType)) agentsDirty = true;
  const known = sessions.get(event.sessionId);
  if (!known) {
    sessions.set(event.sessionId, { sessionId: event.sessionId, firstSeen: event.ts, ended: event.action === 'session_end' });
    sessionsDirty = true;
  } else if (event.action === 'session_end' && !known.ended) {
    known.ended = true;
    sessionsDirty = true;
  }
  for (const abs of event.outsideRepo ?? []) {
    if (model.addOutside(abs).created.length) outsideDirty = true;
  }

  const rec = store.add(event);
  pushBounded(vizState.feed, rec.item, FEED_LIMIT);
  if (!passes(rec.item, vizState.filters)) {
    // Filtered out: no feed row, no light. New satellites still get their nodes.
    if (outsideDirty) scheduleFlush(TREE_DEBOUNCE_MS);
    return;
  }
  panel.push(rec.item);
  accumulate(agg, rec);
  vizState.failCount = agg.fails;
  countersDirty = true;
  if (rec.heatIds.length) {
    heatDirty = true;
    for (const id of rec.heatIds) vizState.heat[id] = agg.heat.get(id) ?? 0;
  }
  if (animate && (vizState.ready || model.nodeCount > 0)) stage(event);
  else if (outsideDirty) scheduleFlush(TREE_DEBOUNCE_MS);
}

function updateSessions(list: SessionInfo[]): void {
  for (const s of list) {
    sessions.set(s.sessionId, { sessionId: s.sessionId, firstSeen: s.firstSeen, ended: s.ended });
    for (const [id, type] of Object.entries(s.agents)) if (rememberAgent(id, type)) agentsDirty = true;
  }
  sessionsDirty = true;
}

/** Clears everything and loads `tree` (not rendered). */
function resetAll(tree: TreeSnapshot, mode: 'live' | 'replay'): void {
  generation++;
  resetState();
  vizState.mode = mode;
  store.clear();
  agg = emptyAggregate();
  vizState.counters = agg.counters;
  sessions.clear();
  sessionsDirty = true;
  pendingAdded = [];
  pendingRemoved = [];
  purgeQueue = [];
  queuedPlays = [];
  fadeMarks.clear();
  structureDirty = false;
  outsideDirty = false;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  model.load(tree);
  model.collapseToBudget(BUDGET);
  panel.rebuild([]);
  countersDirty = true;
  heatDirty = true;
  el('repo-name').textContent = tree.name;
  el('mode').textContent = mode === 'replay' ? 'Repetición' : 'En vivo';
  el('truncated').hidden = !tree.truncated;
}

function finishLoad(): void {
  // The initial zoom-to-fit already includes the hub if history created it.
  hubFramed = model.get(OUTSIDE_HUB_ID) !== undefined;
  if (outsideDirty) {
    outsideDirty = false;
    pinOutside(model, hubRadius());
  }
  structureDirty = false;
  render(true);
}

function handleHello(msg: Hello): void {
  lastHello = msg;
  resetAll(msg.tree, msg.mode);
  updateSessions(msg.sessions);
  // History only feeds the panel and heat; it is not animated.
  for (const event of msg.recent) ingest(event, false);
  finishLoad();
  if (msg.mode === 'replay' && !vizState.replay.active) void replay.start({ canExit: false });
}

function handleMessage(msg: ServerMessage): void {
  if (vizState.replay.active) {
    // Live traffic is dropped while replaying; leaving replay reloads the live state.
    if (msg.type === 'hello') lastHello = msg;
    return;
  }
  switch (msg.type) {
    case 'hello':
      handleHello(msg);
      break;
    case 'event':
      ingest(msg.event, true);
      break;
    case 'tree':
      pendingAdded.push(...msg.added);
      pendingRemoved.push(...msg.removed);
      scheduleFlush(TREE_DEBOUNCE_MS);
      break;
    case 'sessions':
      updateSessions(msg.sessions);
      break;
  }
}

// ---------- user actions ----------

function toggleCollapse(id: string): void {
  const node = model.get(id);
  if (!node || node.kind !== 'dir' || node.outside || id === ROOT_ID) return;
  if (node.collapsed) model.expand(id, Date.now());
  else if (!model.collapse(id)) return;
  view.refreshNode(node);
  structureDirty = true;
  scheduleFlush(0);
}

function applyFilters(f: Filters): void {
  vizState.filters = { ...f };
  agg = store.aggregate(vizState.filters);
  vizState.counters = agg.counters;
  vizState.failCount = agg.fails;
  vizState.heat = Object.fromEntries(agg.heat);
  panel.rebuild(store.visible(vizState.filters, FEED_LIMIT));
  countersDirty = true;
  heatDirty = true;
}

function setRenderer(kind: RendererKind): void {
  if (kind === view.kind) return;
  view.dispose();
  view = makeRenderer(kind);
  vizState.renderer = view.kind;
  panel.setRenderer(view.kind);
  // Same model, heat and feed; only the scene is rebuilt.
  render(true);
  try {
    localStorage.setItem(VIEW_KEY, view.kind);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

const panel = new Panel(vizState.filters, {
  onFilters: applyFilters,
  onRenderer: setRenderer,
});
panel.setRenderer(view.kind);

// ---------- replay ----------

let stopSocket: (() => void) | null = null;

function startSocket(): void {
  stopSocket?.();
  stopSocket = connect(defaultWsUrl(), { onMessage: handleMessage, onStatus: setStatus });
}

const replay = new ReplayController({
  begin(tree) {
    resetAll(tree, 'replay');
  },
  event(e, animate) {
    ingest(e, animate);
  },
  delta(added, removed, animate) {
    if (animate) {
      pendingAdded.push(...added);
      pendingRemoved.push(...removed);
      scheduleFlush(TREE_DEBOUNCE_MS);
      return;
    }
    const r = model.applyDelta(added, removed);
    model.purge(r.removing);
  },
  snapshot(tree, animate) {
    generation++;
    pendingAdded = [];
    pendingRemoved = [];
    purgeQueue = [];
    queuedPlays = [];
    fadeMarks.clear();
    model.load(tree);
    model.collapseToBudget(BUDGET);
    if (animate) render(true);
  },
  commit() {
    finishLoad();
  },
  exit() {
    vizState.mode = 'live';
    el('mode').textContent = 'En vivo';
    if (SOCKET_ENABLED) startSocket();
    else if (lastHello) handleHello(lastHello);
  },
  fallbackTree() {
    return lastHello?.tree ?? null;
  },
});

el('replay-open').addEventListener('click', () => {
  if (!vizState.replay.active) void replay.start({ canExit: true });
});

// ---------- status and periodic sync ----------

function setStatus(status: ConnectionStatus): void {
  vizState.connected = status === 'open';
  el('status').dataset.status = status;
  el('status-text').textContent = STATUS_LABELS[status];
}

// Heat and counters at 10 Hz, only when something changed.
setInterval(() => {
  if (countersDirty) {
    countersDirty = false;
    panel.setCounters(agg.counters, agg.fails);
  }
  if (sessionsDirty) {
    sessionsDirty = false;
    panel.setSessions([...sessions.values()]);
  }
  if (agentsDirty) {
    agentsDirty = false;
    panel.refreshAgents();
  }
  if (!heatDirty) return;
  heatDirty = false;
  // A hidden path lends its heat to the collapsed dir that hides it.
  const out = new Map<string, number>();
  for (const [id, v] of heatIntensity(agg.heat)) {
    const vis = model.visibleAncestor(id);
    if (vis === undefined) continue;
    out.set(vis, Math.max(out.get(vis) ?? 0, v));
  }
  view.setHeat(out);
}, HEAT_INTERVAL_MS);

// Active list, fps readout and feed size without touching the DOM per frame.
setInterval(() => {
  vizState.active = view.activeIds();
  vizState.feedShown = panel.shown;
  el('fps').textContent = `${vizState.fps} fps`;
}, 250);

startFpsMeter();

window.__viz = {
  inject(msg) {
    handleMessage(msg);
  },
  setRenderer,
  setFilters(f) {
    const next = { ...vizState.filters, ...f };
    panel.showFilters(next);
    applyFilters(next);
  },
  toggleCollapse,
  replay: {
    start: () => replay.start({ canExit: lastHello?.mode !== 'replay' }),
    play: () => replay.play(),
    pause: () => replay.pause(),
    restart: () => replay.restart(),
    setSpeed: (s) => replay.setSpeed(s),
    seek: (f) => replay.seek(f),
    exit: () => replay.exit(),
  },
};

// ?ws=0 disables the socket (tests drive the page through window.__viz.inject).
if (SOCKET_ENABLED) {
  startSocket();
} else {
  setStatus('closed');
  el('status-text').textContent = 'Sin socket (modo prueba)';
}
