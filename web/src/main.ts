// Entry point: wires the WebSocket, the tree model, the renderer (3D or 2D), the Timeline
// view, the side panel, the detail drawer, the live stream, replay and window.__viz /
// window.__vizState.
import './style.css';
import { ACTION_COLORS, type ServerMessage, type SessionInfo, type TreeEntry, type TreeSnapshot, type VizEvent } from '../../src/shared/types.ts';
import { agentColor, rememberAgent } from './agents.ts';
import { DetailDrawer } from './detail.ts';
import { eventTargets, playEvent, waitsForDelta, type EffectsContext } from './effects.ts';
import { FADE_OUT_MS } from './glow.ts';
import { createGraph2D } from './graph2d.ts';
import { DAG_LEVEL_DISTANCE, createGraph3D } from './graph3d.ts';
import { applyDom, formatNumber, getLang, onLangChange, setLang, t, tn, type Lang } from './i18n.ts';
import { statusLabel } from './labels.ts';
import { LabelOverlay, MAX_OVERLAY_LABELS, type OverlayItem } from './overlay.ts';
import { Panel, type SessionRow } from './panel.ts';
import { PanelResizer } from './panelResize.ts';
import { escapeHtml, type Renderer, type RendererKind, type RendererOptions, type ViewKind } from './renderer.ts';
import { ReplayController } from './replay.ts';
import { activeSessions, endOpenSessions, sessionPalette, sessionRing } from './sessions.ts';
import { FEED_LIMIT, pushBounded, resetState, startFpsMeter, vizState, type Filters } from './state.ts';
import { EventStore, accumulate, emptyAggregate, heatIntensity, passes, touches, type Aggregate } from './store.ts';
import { LiveStream } from './stream.ts';
import { TimelineView } from './timeline.ts';
import { TimelineModel } from './timelineModel.ts';
import { Toasts } from './toast.ts';
import { snapshotTally } from './tools.ts';
import { OUTSIDE_HUB_ID, ROOT_ID, TreeModel, isAbsolutePath, normalizePath, pinOutside, type VizNode } from './treeModel.ts';
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
const VIEW_KEY = 'neurons:view';
/** Graph kind (3d / 2d) to return to from the Timeline, when VIEW_KEY holds 'timeline'. */
const GRAPH_KEY = 'neurons:graph';
const TIMELINE_ROW_PATHS = 300;
/** Key the versions named repo-synapse saved the view under: read when there is no new one. */
const LEGACY_VIEW_KEY = 'repo-synapse:view';
const STREAM_KEY = 'neurons.stream';
/** Existing nodes stay pinned this long after a collapse toggle, so only the new ones move. */
const TOGGLE_PIN_MS = 800;
const TOGGLE_FOCUS_MS = 900;
const SHOW_FOCUS_MS = 1000;
const SHOW_PULSE_COLOR = '#e0f2fe';

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
/** Newest event ts seen since the last reset: the clock of the session tint in replay. */
let lastEventTs = 0;
/** Sessions that counted for the tint at the last check, joined (detects changes). */
let activeKey = '';
let connectionStatus: ConnectionStatus = 'connecting';
/** ?ws=0: the page runs without a socket (tests inject messages). */
let noSocket = false;

// ---------- language ----------

vizState.lang = getLang();
document.documentElement.lang = vizState.lang;
applyDom();
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
  btn.setAttribute('aria-pressed', String(btn.dataset.lang === vizState.lang));
  btn.addEventListener('click', () => setLang(btn.dataset.lang === 'es' ? 'es' : 'en'));
}

// ---------- renderer ----------

const graphEl = el('graph');

/** A repo dir that a click opens or closes. */
function isToggleable(n: VizNode): boolean {
  return n.kind === 'dir' && !n.outside && n.id !== ROOT_ID;
}

function nodeLabel(n: VizNode): string {
  if (n.id === ROOT_ID) return escapeHtml(t('node.root', { name: n.name }));
  if (n.id === OUTSIDE_HUB_ID) return escapeHtml(t('node.outsideHub'));
  if (n.outside) return escapeHtml(n.kind === 'dir' ? t('node.outsideGroup', { name: n.name }) : n.id);
  const hint = (text: string): string => `${escapeHtml(n.kind === 'dir' ? `${n.id}/` : n.id)}<br><span class="tip-hint">${escapeHtml(text)}</span>`;
  if (n.collapsed) return hint(tn('node.expand', model.descendantCount(n.id)));
  if (isToggleable(n)) return hint(t('node.collapse'));
  return hint(t('node.fileHint'));
}

const rendererOptions: RendererOptions = {
  label: nodeLabel,
  onNodeClick: (n) => {
    if (isToggleable(n)) toggleCollapse(n.id, { feedback: true });
    else if (n.kind === 'file' && !n.outside) openFile(n.id);
    else if (n.kind === 'file' && n.outside) openFile(n.id);
  },
  clickable: (n) => isToggleable(n) || n.kind === 'file',
};

function makeRenderer(kind: RendererKind): Renderer {
  if (kind === '3d') {
    try {
      return createGraph3D(graphEl, rendererOptions);
    } catch (err) {
      // No WebGL: fall back to the canvas view.
      console.warn('[neurons] 3D unavailable, using 2D', err);
      graphEl.replaceChildren();
    }
  }
  return createGraph2D(graphEl, rendererOptions);
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage blocked: default view.
    return null;
  }
}

function initialView(): ViewKind {
  const q = params.get('view');
  if (q === '2d' || q === '3d' || q === 'timeline') return q;
  const saved = readStored(VIEW_KEY) ?? readStored(LEGACY_VIEW_KEY);
  return saved === '2d' || saved === '3d' || saved === 'timeline' ? saved : '3d';
}

function initialKind(v: ViewKind): RendererKind {
  if (v !== 'timeline') return v;
  const saved = readStored(GRAPH_KEY);
  return saved === '2d' ? '2d' : '3d';
}

let currentView: ViewKind = initialView();
let view: Renderer = makeRenderer(initialKind(currentView));
vizState.renderer = view.kind;

const overlay = new LabelOverlay(el('stage'), () => view);

const ctx: EffectsContext = {
  model,
  view: () => view,
  agentColor,
  sessionRing(event) {
    syncMultiSession();
    return sessionRing(event, sessionPalette.peek(event.sessionId), vizState.multiSession);
  },
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
  // A paused graph does not lay out: the Timeline is ready as soon as the data is in.
  if (initial && currentView === 'timeline') vizState.ready = true;
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
      ? t('top.nodesOf', { visible: vizState.visibleNodeCount, total: vizState.nodeCount })
      : tn('top.nodes', vizState.nodeCount);
}

function refreshOverlay(): void {
  const items: OverlayItem[] = [];
  const root = model.get(ROOT_ID);
  if (root) items.push({ node: root, text: root.name, kind: 'root' });
  const hub = model.get(OUTSIDE_HUB_ID);
  if (hub) items.push({ node: hub, text: t('node.outsideHub'), kind: 'hub' });
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
    items.push({ node: n, text: n.collapsed ? `${n.name} (+${formatNumber(countOf(n.id))})` : n.name, kind: 'dir' });
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
/** An open file list in the detail drawer got a new event. */
let detailDirty = false;
let sessionsDirty = false;
let agentsDirty = false;

/** Expands the collapsed dirs hiding the event's targets. True when one was expanded. */
function revealTargets(event: VizEvent, now: number): boolean {
  let changed = false;
  for (const p of eventTargets(event, model)) {
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

/** Now for the session tint: the wall clock live, the log's own time in replay. */
function tintClock(): number {
  return vizState.replay.active ? lastEventTs : Date.now();
}

function assignSessionColor(sessionId: string): void {
  const color = sessionPalette.assign(sessionId);
  if (color && vizState.sessionColors[sessionId] !== color) vizState.sessionColors[sessionId] = color;
}

/** Recomputes which sessions count for the tint; marks the panel dirty when that changed. */
function syncMultiSession(): string[] {
  const active = activeSessions(sessions.values(), tintClock());
  const multi = active.length >= 2;
  const key = active.join(',');
  if (multi !== vizState.multiSession || key !== activeKey) {
    vizState.multiSession = multi;
    activeKey = key;
    sessionsDirty = true;
  }
  return active;
}

/** Records an event (feed, counters, heat) and, when `animate`, lights it up. */
function ingest(event: VizEvent, animate: boolean): void {
  if (event.agentId && rememberAgent(event.agentId, event.agentType)) agentsDirty = true;
  if (event.ts > lastEventTs) lastEventTs = event.ts;
  const known = sessions.get(event.sessionId);
  if (!known) {
    sessions.set(event.sessionId, {
      sessionId: event.sessionId,
      firstSeen: event.ts,
      lastSeen: event.ts,
      ended: event.action === 'session_end',
      ...(event.action === 'session_end' && event.detail === 'clear' ? { cleared: true } : {}),
    });
    sessionsDirty = true;
  } else {
    if (event.ts > known.lastSeen) known.lastSeen = event.ts;
    if (event.action === 'session_end' && !known.ended) {
      known.ended = true;
      if (event.detail === 'clear') known.cleared = true;
      sessionsDirty = true;
    } else if (event.action === 'session_start' && known.ended) {
      known.ended = false;
      delete known.cleared;
      sessionsDirty = true;
    }
  }
  assignSessionColor(event.sessionId);
  for (const abs of event.outsideRepo ?? []) {
    if (model.addOutside(abs).created.length) outsideDirty = true;
  }

  const trims = store.trims;
  const rec = store.add(event);
  // The store dropped its oldest records: the Timeline follows, so its marks never point at
  // events the page no longer has and it stops growing. The rebuild includes this event.
  const trimmed = store.trims !== trims;
  if (trimmed) rebuildTimeline(false);
  pushBounded(vizState.feed, rec.item, FEED_LIMIT);
  if (!passes(rec.item, vizState.filters)) {
    // Filtered out: no feed row, no light. New satellites still get their nodes.
    if (outsideDirty) scheduleFlush(TREE_DEBOUNCE_MS);
    return;
  }
  panel.push(rec.item);
  if (!trimmed && timelineModel.add(event, animate ? performance.now() : 0)) timeline.invalidate();
  if (animate) stream.offer(event);
  const openPath = detail.openPath;
  if (openPath !== null && touches(event, openPath)) detailDirty = true;
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
    const lastSeen = Math.max(s.lastSeen, sessions.get(s.sessionId)?.lastSeen ?? 0);
    sessions.set(s.sessionId, { sessionId: s.sessionId, firstSeen: s.firstSeen, lastSeen, ended: s.ended, ...(s.cleared ? { cleared: true } : {}) });
    for (const [id, type] of Object.entries(s.agents)) if (rememberAgent(id, type)) agentsDirty = true;
  }
  // First appearance = firstSeen, so a reload gives every session the same hue again.
  sessionPalette.assignAll(list);
  for (const s of list) assignSessionColor(s.sessionId);
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
  sessionPalette.clear();
  lastEventTs = 0;
  activeKey = '';
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
  stream.clear();
  rebuildTimeline();
  countersDirty = true;
  heatDirty = true;
  detailDirty = true;
  el('repo-name').textContent = tree.name;
  setMode(mode);
  el('truncated').hidden = !tree.truncated;
}

function setMode(mode: 'live' | 'replay'): void {
  const chip = el('mode');
  chip.dataset.i18n = mode === 'replay' ? 'mode.replay' : 'mode.live';
  chip.textContent = t(chip.dataset.i18n);
  timeline.relabel();
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

let unpinTimer: ReturnType<typeof setTimeout> | null = null;
let pinned: VizNode[] = [];

/**
 * Freezes the nodes already laid out (fx/fy/fz) for a moment so a collapse toggle only moves
 * the nodes it adds; the layout cools down faster meanwhile, then everything is released.
 */
function holdLayout(ms: number): void {
  if (unpinTimer !== null) clearTimeout(unpinTimer);
  else pinned = [];
  for (const n of model.nodes.values()) {
    if (n.x === undefined || n.fx !== undefined || n.id === ROOT_ID || n.outside) continue;
    n.fx = n.x;
    n.fy = n.y;
    n.fz = n.z;
    pinned.push(n);
  }
  view.calm(ms + 400);
  const gen = generation;
  unpinTimer = setTimeout(() => {
    unpinTimer = null;
    const list = pinned;
    pinned = [];
    if (gen !== generation) return;
    for (const n of list) {
      delete n.fx;
      delete n.fy;
      delete n.fz;
    }
  }, ms);
}

function toggleCollapse(id: string, opts: { feedback?: boolean } = {}): void {
  const node = model.get(id);
  if (!node || node.kind !== 'dir' || node.outside || id === ROOT_ID) return;
  const opening = !!node.collapsed;
  if (opts.feedback) holdLayout(TOGGLE_PIN_MS);
  if (opening) model.expand(id, Date.now());
  else if (!model.collapse(id)) return;
  view.refreshNode(node);
  structureDirty = true;
  scheduleFlush(0);
  if (!opts.feedback) return;
  view.focus(node, TOGGLE_FOCUS_MS);
  view.pulse(id, ACTION_COLORS.read, { intensity: 0.5, durationMs: 900 });
  toasts.show(opening ? tn('toast.expanded', model.childCount(id), { path: id }) : t('toast.collapsed', { path: id }));
}

/** Id of the graph node for a path of an event (repo path or absolute satellite path). */
function nodeIdFor(path: string): string | undefined {
  if (isAbsolutePath(path)) return model.get(path) ? path : undefined;
  const p = normalizePath(path);
  return model.get(p) ? p : model.existing(p);
}

/**
 * Reveals the node of `path`, eases the camera to it and pulses it. From the Timeline it
 * first switches back to the graph view.
 */
function showInGraph(path: string): boolean {
  if (currentView === 'timeline') {
    if (nodeIdFor(path) === undefined) {
      toasts.show(t('toast.notInGraph'));
      return false;
    }
    setView(view.kind);
    const gen = generation;
    // Let the resumed renderer take its new size before the camera moves.
    setTimeout(() => gen === generation && focusInGraph(path), 80);
    return true;
  }
  return focusInGraph(path);
}

function focusInGraph(path: string): boolean {
  const id = nodeIdFor(path);
  if (id === undefined) {
    toasts.show(t('toast.notInGraph'));
    return false;
  }
  const changed = revealTargets({ ...syntheticEvent, paths: isAbsolutePath(id) ? [] : [id] }, Date.now());
  const go = (): void => {
    const visible = model.visibleAncestor(id) ?? id;
    const node = model.get(visible);
    if (!node) return;
    view.focus(node, SHOW_FOCUS_MS);
    view.pulse(visible, SHOW_PULSE_COLOR, { intensity: 1, durationMs: 2600, blinks: 2 });
  };
  if (changed) {
    structureDirty = true;
    scheduleFlush(0);
    const gen = generation;
    setTimeout(() => gen === generation && go(), 120);
  } else go();
  return true;
}

const syntheticEvent: VizEvent = { id: '', ts: 0, sessionId: '', phase: 'info', action: 'read', paths: [], source: 'hook' };

function openFile(path: string): void {
  detail.openFile(path);
  const id = nodeIdFor(path);
  if (id !== undefined && model.isVisible(id)) view.pulse(id, SHOW_PULSE_COLOR, { intensity: 0.7, durationMs: 1400 });
}

function applyFilters(f: Filters): void {
  vizState.filters = { ...f };
  agg = store.aggregate(vizState.filters);
  vizState.counters = agg.counters;
  vizState.failCount = agg.fails;
  vizState.heat = Object.fromEntries(agg.heat);
  panel.rebuild(store.visible(vizState.filters, FEED_LIMIT));
  stream.clear();
  rebuildTimeline();
  countersDirty = true;
  heatDirty = true;
  detailDirty = true;
}

/**
 * Refills the Timeline from the events kept in the page that pass the filter. `resetView`
 * (a filter change, a reset) also scrolls back to the top and to "now".
 */
function rebuildTimeline(resetView = true): void {
  timelineModel.clear();
  store.forEach(vizState.filters, (rec) => timelineModel.add(rec.event, 0));
  if (!resetView) {
    timeline.invalidate();
    return;
  }
  const f = vizState.filters;
  timeline.reset(!!(f.session || f.agent || !f.showExternal));
}

function setRenderer(kind: RendererKind): void {
  if (kind === view.kind) return;
  view.dispose();
  view = makeRenderer(kind);
  vizState.renderer = view.kind;
  // Same model, heat and feed; only the scene is rebuilt.
  render(true);
}

/** Switches between the 3D graph, the 2D graph and the Timeline. */
function setView(kind: ViewKind): void {
  if (kind === 'timeline') {
    if (currentView !== 'timeline') {
      currentView = 'timeline';
      // The graph stays alive underneath (effects keep their state) but stops drawing.
      view.setPaused(true);
      document.body.classList.add('view-timeline');
      timeline.setActive(true);
    }
  } else {
    const fromTimeline = currentView === 'timeline';
    currentView = kind;
    document.body.classList.remove('view-timeline');
    timeline.setActive(false);
    if (kind !== view.kind) setRenderer(kind);
    else if (fromTimeline) view.setPaused(false);
  }
  vizState.view = currentView;
  panel.setView(currentView);
  try {
    localStorage.setItem(VIEW_KEY, currentView);
    localStorage.setItem(GRAPH_KEY, view.kind);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

const panel = new Panel(vizState.filters, {
  onFilters: applyFilters,
  onView: setView,
  onOpen: (id) => detail.open(id),
  onStream: setStreamOn,
});

const toasts = new Toasts(el('toasts'));

const detail = new DetailDrawer({
  record: (id) => store.get(id),
  neighbor: (id, dir) => store.neighbor(id, dir, vizState.filters),
  forPath: (path, limit) => store.forPath(path, vizState.filters, limit),
  showInGraph,
  copy(text) {
    const done = (): void => toasts.show(t('toast.copied'));
    const fail = (): void => toasts.show(t('toast.copyFailed'));
    try {
      if (navigator.clipboard) void navigator.clipboard.writeText(text).then(done, fail);
      else fail();
    } catch {
      fail();
    }
  },
  onChange(eventId, path) {
    vizState.detail = eventId;
    vizState.detailPath = path;
    panel.select(eventId);
  },
});

const timelineModel = new TimelineModel((p) => model.get(p)?.kind);
const timeline = new TimelineView(el('timeline'), timelineModel, {
  event: (id) => store.get(id)?.event,
  openEvent: (id) => detail.open(id),
  openFile,
  showInGraph: (path) => void showInGraph(path),
  repoName: () => el('repo-name').textContent ?? '',
  now: () => (vizState.replay.active ? (replay.clockTs ?? lastEventTs) : Date.now()),
  replaying: () => vizState.replay.active,
});

// The first view: the graph renderer already exists; the Timeline covers it when chosen.
vizState.view = currentView;
panel.setView(currentView);
if (currentView === 'timeline') {
  view.setPaused(true);
  document.body.classList.add('view-timeline');
  timeline.setActive(true);
}

const stream = new LiveStream(el('stream'), (id) => detail.open(id), (items) => (vizState.stream = items));

function setStreamOn(on: boolean): void {
  vizState.streamOn = on;
  stream.setEnabled(on);
  panel.setStream(on);
  try {
    localStorage.setItem(STREAM_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

{
  let on = true;
  try {
    on = localStorage.getItem(STREAM_KEY) !== '0';
  } catch {
    // Storage blocked: default on.
  }
  vizState.streamOn = on;
  stream.setEnabled(on);
  panel.setStream(on);
}

const resizer = new PanelResizer(el('panel-resize'), (px) => (vizState.panelWidth = px));
vizState.panelWidth = resizer.value;

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
    // A new server run in the log: sessions the previous run never saw end are over (the
    // hooks were removed when it closed). One that goes on reopens with its session_start.
    if (endOpenSessions(sessions.values())) sessionsDirty = true;
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
    setMode('live');
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
  connectionStatus = status;
  vizState.connected = status === 'open';
  el('status').dataset.status = status;
  el('status-text').textContent = noSocket ? t('status.noSocket') : statusLabel(status);
}

function relabel(lang: Lang): void {
  vizState.lang = lang;
  document.documentElement.lang = lang;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  }
  applyDom();
  panel.relabel(store.visible(vizState.filters, FEED_LIMIT));
  panel.setCounters(agg.counters, agg.fails);
  replay.relabel();
  resizer.relabel();
  stream.relabel();
  detail.refresh();
  timeline.relabel();
  setStatus(connectionStatus);
  syncCounts();
  refreshOverlay();
}

onLangChange(relabel);

// Heat and counters at 10 Hz, only when something changed.
setInterval(() => {
  if (countersDirty) {
    countersDirty = false;
    panel.setCounters(agg.counters, agg.fails);
    panel.setTools(agg.tools);
    vizState.tools = snapshotTally(agg.tools);
  }
  if (detailDirty) {
    detailDirty = false;
    detail.refresh();
  }
  const active = syncMultiSession();
  if (sessionsDirty) {
    sessionsDirty = false;
    panel.setSessions([...sessions.values()], active);
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
  syncTimelineState();
  el('fps').textContent = t('top.fps', { fps: vizState.fps });
}, 250);

function syncTimelineState(): void {
  const c = timelineModel.counts;
  const s = vizState.timeline;
  s.following = timeline.isFollowing;
  if (s.rows === c.rows && s.marks === c.marks && s.turns === c.turns && s.agents === c.agents && s.groups === c.groups) return;
  Object.assign(s, c);
  s.rowPaths = timelineModel
    .orderedRows()
    .slice(0, TIMELINE_ROW_PATHS)
    .map((r) => r.path);
}

startFpsMeter();

window.__viz = {
  inject(msg) {
    handleMessage(msg);
  },
  setRenderer: setView,
  setView,
  setFilters(f) {
    const next = { ...vizState.filters, ...f };
    panel.showFilters(next);
    applyFilters(next);
  },
  toggleCollapse: (id) => toggleCollapse(id, { feedback: true }),
  setLang,
  openDetail: (id) => detail.open(id),
  openFile,
  closeDetail: () => detail.close(),
  setPanelWidth: (px) => resizer.set(px),
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
  noSocket = true;
  setStatus('closed');
}
