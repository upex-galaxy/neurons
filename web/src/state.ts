// Observable page state for tests and debugging: window.__vizState and window.__viz.
import type { Action, Phase, ServerMessage } from '../../src/shared/types.ts';
import type { RendererKind } from './renderer.ts';

export interface FeedItem {
  id: string;
  ts: number;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  action: Action;
  phase: Phase;
  /** First repo path, or the first outside path, or "" when the event has none. */
  path: string;
  detail?: string;
  external?: boolean;
}

export interface Filters {
  /** "" = every session. */
  session: string;
  /** "" = every agent, "main" = main agent only, else an agentId. */
  agent: string;
  showExternal: boolean;
}

export interface ReplayState {
  /** True while the replay controls are shown (log loaded). */
  active: boolean;
  playing: boolean;
  speed: number;
  /** Log items already applied. */
  index: number;
  total: number;
  /** Playhead and length on the compressed timeline, ms. */
  elapsedMs: number;
  durationMs: number;
  /** Gaps longer than 3 s that were shortened to 3 s. */
  compressedGaps: number;
  segment: number;
  segments: number;
}

export interface VizState {
  ready: boolean;
  mode: 'live' | 'replay' | null;
  renderer: RendererKind;
  nodeCount: number;
  linkCount: number;
  visibleNodeCount: number;
  collapsedCount: number;
  satelliteCount: number;
  /** Ids with an active glow (pulse, fade) right now. */
  active: string[];
  created: string[];
  removed: string[];
  /** Touch count per node id for the current filter (non-pre, file actions). */
  heat: Record<string, number>;
  /** Every received event, oldest first, bounded (not filtered). */
  feed: FeedItem[];
  /** Rows currently shown in the panel feed (after filters). */
  feedShown: number;
  /** Per action, for the current filter, non-pre events. */
  counters: Partial<Record<Action, number>>;
  failCount: number;
  filters: Filters;
  fps: number;
  lastEventLatencyMs: number | null;
  connected: boolean;
  replay: ReplayState;
}

export interface VizApi {
  inject(msg: ServerMessage): void;
  setRenderer(kind: RendererKind): void;
  setFilters(f: Partial<Filters>): void;
  toggleCollapse(id: string): void;
  replay: {
    start(): Promise<void>;
    play(): void;
    pause(): void;
    restart(): void;
    setSpeed(speed: number): void;
    seek(fraction: number): void;
    exit(): void;
  };
}

declare global {
  interface Window {
    __vizState: VizState;
    __viz: VizApi;
  }
}

export const FEED_LIMIT = 300;
const TRACK_LIMIT = 500;

export function emptyReplay(): ReplayState {
  return {
    active: false,
    playing: false,
    speed: 1,
    index: 0,
    total: 0,
    elapsedMs: 0,
    durationMs: 0,
    compressedGaps: 0,
    segment: 0,
    segments: 0,
  };
}

export function createState(): VizState {
  return {
    ready: false,
    mode: null,
    renderer: '3d',
    nodeCount: 0,
    linkCount: 0,
    visibleNodeCount: 0,
    collapsedCount: 0,
    satelliteCount: 0,
    active: [],
    created: [],
    removed: [],
    heat: {},
    feed: [],
    feedShown: 0,
    counters: {},
    failCount: 0,
    filters: { session: '', agent: '', showExternal: true },
    fps: 0,
    lastEventLatencyMs: null,
    connected: false,
    replay: emptyReplay(),
  };
}

export const vizState: VizState = createState();
window.__vizState = vizState;

/** Resets the graph/feed state. Keeps connection, fps, renderer, filters and replay. */
export function resetState(): void {
  const fresh = createState();
  fresh.connected = vizState.connected;
  fresh.fps = vizState.fps;
  fresh.renderer = vizState.renderer;
  fresh.filters = vizState.filters;
  fresh.replay = vizState.replay;
  Object.assign(vizState, fresh);
}

/** Pushes to a bounded list, dropping the oldest entries. */
export function pushBounded<T>(list: T[], item: T, limit = TRACK_LIMIT): void {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

/** Moving average of frames per second, sampled with requestAnimationFrame. */
export function startFpsMeter(): void {
  let last = performance.now();
  let avgMs = 16.7;
  const tick = (now: number): void => {
    const dt = now - last;
    last = now;
    // Ignore gaps from hidden tabs so one long frame does not poison the average.
    if (dt > 0 && dt < 1000) avgMs = avgMs * 0.9 + dt * 0.1;
    vizState.fps = Math.round(1000 / avgMs);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
