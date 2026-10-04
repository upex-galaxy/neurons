// Data behind the Timeline view: rows (files, search dirs, outside paths, skills and MCP
// tools) in order of first touch grouped by folder, one mark per event and path, prompt
// turns, subagent lifetimes and a time axis that shortens long pauses. Pure (no DOM) so it
// can be unit tested in Node; web/src/timeline.ts draws it.
import { ACTION_COLORS, EXTERNAL_COLOR, FAIL_COLOR, type Action, type Phase, type VizEvent } from '../../src/shared/types.ts';
import { EXTERNAL_SESSION } from './sessions.ts';
import { toolOf } from './tools.ts';
import { isAbsolutePath, normalizePath } from './treeModel.ts';

/** A pause between two events longer than this is shortened on the axis. */
export const GAP_THRESHOLD_MS = 10_000;
/** Width, in axis time, that a shortened pause keeps. */
export const GAP_SHOWN_MS = 2_000;
/** Tool calls remembered to join a Pre with its Post (bounded like the server's). */
const PENDING_MAX = 2000;
/** Sessions remembered per row for the left edge stripe. */
const ROW_SESSIONS_MAX = 4;
export const MAX_AGENT_LANES = 4;
/** Overlapping turns (two sessions at once) stack in up to this many lanes. */
export const MAX_TURN_LANES = 2;

/** Group keys that are not repo folders. */
export const OUTSIDE_GROUP = '~outside';
export const TOOLS_GROUP = '~tools';

// ---------- time axis ----------

export interface TimeBreak {
  fromTs: number;
  toTs: number;
  /** Axis positions (ms) of both ends: toCt - fromCt is GAP_SHOWN_MS. */
  fromCt: number;
  toCt: number;
}

/**
 * Maps epoch ms to axis ms ("ct"): 1:1 except that every pause longer than
 * GAP_THRESHOLD_MS between two consecutive events takes GAP_SHOWN_MS. Events arrive in
 * order almost always; a late one only forces a rebuild when it lands inside a pause.
 */
export class TimeAxis {
  /** Every timestamp added, sorted (kept for rebuilds). */
  private times: number[] = [];
  breaks: TimeBreak[] = [];
  startTs = 0;
  lastTs = 0;
  /** Axis position of lastTs. */
  lastCt = 0;

  get empty(): boolean {
    return this.times.length === 0;
  }

  clear(): void {
    this.times = [];
    this.breaks = [];
    this.startTs = 0;
    this.lastTs = 0;
    this.lastCt = 0;
  }

  /** Adds a timestamp. Returns true when positions of earlier timestamps changed. */
  add(ts: number): boolean {
    if (this.times.length === 0) {
      this.times.push(ts);
      this.startTs = this.lastTs = ts;
      this.lastCt = 0;
      return false;
    }
    if (ts >= this.lastTs) {
      this.times.push(ts);
      this.extend(ts);
      return false;
    }
    // Late event: insert it and rebuild only when it changes the axis before lastTs.
    const i = upperBound(this.times, ts, (v) => v);
    this.times.splice(i, 0, ts);
    if (ts >= this.startTs && !this.insideBreak(ts)) return false;
    this.rebuild();
    return true;
  }

  private extend(ts: number): void {
    const gap = ts - this.lastTs;
    if (gap > GAP_THRESHOLD_MS) {
      this.breaks.push({ fromTs: this.lastTs, toTs: ts, fromCt: this.lastCt, toCt: this.lastCt + GAP_SHOWN_MS });
      this.lastCt += GAP_SHOWN_MS;
    } else {
      this.lastCt += gap;
    }
    this.lastTs = ts;
  }

  private rebuild(): void {
    const times = this.times;
    this.breaks = [];
    this.startTs = this.lastTs = times[0]!;
    this.lastCt = 0;
    for (let i = 1; i < times.length; i++) this.extend(times[i]!);
  }

  private insideBreak(ts: number): boolean {
    const b = this.breakBefore(ts);
    return b !== undefined && ts < b.toTs;
  }

  /** Last break whose start is before ts. */
  private breakBefore(ts: number): TimeBreak | undefined {
    const i = upperBound(this.breaks, ts, (b) => b.fromTs) - 1;
    return i >= 0 ? this.breaks[i] : undefined;
  }

  /** Axis position of an epoch ms. Linear past the last event. */
  toCt(ts: number): number {
    if (this.times.length === 0) return 0;
    if (ts >= this.lastTs) return this.lastCt + (ts - this.lastTs);
    const b = this.breakBefore(ts);
    if (!b) return ts - this.startTs;
    if (ts >= b.toTs) return b.toCt + (ts - b.toTs);
    return b.fromCt + ((ts - b.fromTs) / (b.toTs - b.fromTs)) * (b.toCt - b.fromCt);
  }

  /** Inverse of toCt (inside a break it interpolates across the real pause). */
  toTs(ct: number): number {
    if (this.times.length === 0) return 0;
    if (ct >= this.lastCt) return this.lastTs + (ct - this.lastCt);
    const i = upperBound(this.breaks, ct, (b) => b.fromCt) - 1;
    const b = i >= 0 ? this.breaks[i] : undefined;
    if (!b) return this.startTs + ct;
    if (ct >= b.toCt) return b.toTs + (ct - b.toCt);
    return b.fromTs + ((ct - b.fromCt) / (b.toCt - b.fromCt)) * (b.toTs - b.fromTs);
  }

  /**
   * Position of "now" (the cursor): after the last event it grows with the clock until
   * the pause reaches GAP_THRESHOLD_MS, then waits there for the next event.
   */
  nowCt(now: number): number {
    if (this.times.length === 0) return 0;
    return this.lastCt + Math.max(0, Math.min(now - this.lastTs, GAP_THRESHOLD_MS));
  }

  /** The break that holds axis position ct, if any. */
  breakAtCt(ct: number): TimeBreak | undefined {
    const i = upperBound(this.breaks, ct, (b) => b.fromCt) - 1;
    const b = i >= 0 ? this.breaks[i] : undefined;
    return b && ct <= b.toCt ? b : undefined;
  }

  /** The first break that ends after ts (to skip ticks over a pause). */
  breakContaining(ts: number): TimeBreak | undefined {
    const b = this.breakBefore(ts);
    return b && ts < b.toTs ? b : undefined;
  }
}

/** First index whose key is > value (list sorted by key). */
export function upperBound<T>(list: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]!) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose key is >= value (list sorted by key). */
export function lowerBound<T>(list: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]!) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- marks ----------

export type MarkShape = 'dot' | 'bar' | 'plus' | 'cross' | 'arrow' | 'ring' | 'diamond' | 'triangle' | 'square' | 'tick';

export interface MarkStyle {
  shape: MarkShape;
  color: string;
  /** Post / info are filled, pre is hollow. */
  filled: boolean;
}

const SHAPES: Partial<Record<Action, MarkShape>> = {
  read: 'dot',
  edit: 'bar',
  create: 'plus',
  delete: 'cross',
  move: 'arrow',
  search: 'ring',
  context_load: 'diamond',
  skill: 'triangle',
  mcp: 'square',
  bash: 'tick',
};

/** Actions that leave a mark on the timeline. */
export const MARK_ACTIONS: ReadonlySet<Action> = new Set(Object.keys(SHAPES) as Action[]);

/** Shape by action, color by action (gray when it failed, dim for external changes), hollow for pre. */
export function markStyle(e: Pick<VizEvent, 'action' | 'phase' | 'external'>): MarkStyle {
  const shape = SHAPES[e.action] ?? 'dot';
  const color = e.phase === 'fail' ? FAIL_COLOR : e.external ? EXTERNAL_COLOR : ACTION_COLORS[e.action];
  return { shape, color, filled: e.phase !== 'pre' };
}

export interface TimelineMark extends MarkStyle {
  /** Event id (the detail drawer opens it). */
  id: string;
  ts: number;
  action: Action;
  phase: Phase;
  sessionId: string;
  /** Subagent events go to the row's thin sub-lane. */
  agentId?: string;
  /** For a Post or Failure: the ts of its Pre on the same row (drawn as a joining line). */
  startTs?: number;
}

export type RowKind = 'file' | 'dir' | 'outside' | 'skill' | 'mcp';

export interface TimelineRow {
  key: string;
  /** Repo path ("" = root), absolute outside path, or the skill / "server/tool" name. */
  path: string;
  kind: RowKind;
  group: string;
  /** First-touch order among every row. */
  order: number;
  firstTs: number;
  /** Sorted by ts. */
  marks: TimelineMark[];
  /** Sessions that touched it (no external), first first, at most 4. */
  sessions: string[];
  /** Has subagent marks: draws a sub-lane. */
  hasSub: boolean;
  /** performance.now()-like time it appeared (slide-in), 0 = no animation. */
  addedAt: number;
}

export interface TimelineGroup {
  /** Folder path ("" = root), OUTSIDE_GROUP or TOOLS_GROUP. */
  key: string;
  order: number;
  firstTs: number;
  /** In first-touch order. */
  rows: TimelineRow[];
}

export interface TurnSpan {
  /** 1-based, in order of appearance under the current filter. */
  index: number;
  sessionId: string;
  eventId: string;
  startTs: number;
  endTs: number | null;
  fail: boolean;
  /** The prompt summary the server sent (first 120 chars, tags removed). */
  detail?: string;
  /** Lane in the turn band (another session's turn may overlap in time). */
  lane: number;
}

export interface AgentSpan {
  agentId: string;
  agentType: string;
  sessionId: string;
  /** subagent_start event, when seen. */
  eventId?: string;
  startTs: number;
  endTs: number | null;
  lane: number;
}

/** Where an event leaves a mark. */
export interface MarkTarget {
  key: string;
  path: string;
  kind: RowKind;
  group: string;
}

/** Parent folder of a repo path ("" for top-level entries and for the root itself). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export type KindOf = (path: string) => 'file' | 'dir' | undefined;

/**
 * Rows an event marks: its repo paths (and a move's old paths), then outside paths; a
 * skill or MCP call that names no path marks its own row in the "Skills and MCP" group.
 * Search hits (secondary) do not get rows: one grep would add dozens.
 */
export function markTargets(e: VizEvent, kindOf?: KindOf): MarkTarget[] {
  if (!MARK_ACTIONS.has(e.action)) return [];
  const out: MarkTarget[] = [];
  const seen = new Set<string>();
  const repo = (raw: string): void => {
    if (isAbsolutePath(raw)) return outside(raw);
    const path = normalizePath(raw);
    const key = `f:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const kind = kindOf?.(path) ?? (path === '' || e.action === 'search' ? 'dir' : 'file');
    out.push({ key, path, kind, group: path === '' ? '' : parentDir(path) });
  };
  const outside = (abs: string): void => {
    const key = `o:${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, path: abs, kind: 'outside', group: OUTSIDE_GROUP });
  };
  for (const p of e.paths) repo(p);
  for (const p of e.fromPaths ?? []) repo(p);
  for (const p of e.outsideRepo ?? []) outside(p);
  if (out.length === 0 && (e.action === 'skill' || e.action === 'mcp')) {
    const tool = toolOf(e);
    const name = e.action === 'skill' ? (tool?.name ?? e.detail ?? '?') : (e.detail ?? (tool ? `${tool.server ?? '?'}/${tool.name}` : '?'));
    out.push({ key: `${e.action === 'skill' ? 's' : 'm'}:${name}`, path: name, kind: e.action, group: TOOLS_GROUP });
  }
  return out;
}

export interface TimelineCounts {
  rows: number;
  marks: number;
  groups: number;
  turns: number;
  agents: number;
}

/**
 * Everything the Timeline draws, built incrementally from events (in arrival order).
 * `version` changes when the row layout must be recomputed (new row, group, sub-lane,
 * agent lane or a shifted axis); adding a mark to an existing row does not change it.
 */
export class TimelineModel {
  readonly axis = new TimeAxis();
  readonly rows = new Map<string, TimelineRow>();
  groups: TimelineGroup[] = [];
  turns: TurnSpan[] = [];
  agents: AgentSpan[] = [];
  agentLanes = 0;
  turnLanes = 0;
  markCount = 0;
  version = 0;
  /** Bumped on every change, layout or not (the view redraws). */
  revision = 0;
  /** Newest mark, for vertical follow. */
  lastRow: TimelineRow | null = null;
  /** Latest `addedAt` of a new row (the view animates until it is SLIDE_MS old). */
  lastAddedAt = 0;
  private readonly groupsByKey = new Map<string, TimelineGroup>();
  private readonly openTurns = new Map<string, TurnSpan>();
  private readonly agentsById = new Map<string, AgentSpan>();
  /** Open calls by toolUseId: Pre ts and the rows its Pre marked (LRU by call, not by row). */
  private readonly pending = new Map<string, { ts: number; rows: Set<string>; done: boolean }>();
  private readonly sessions = new Set<string>();

  constructor(private readonly kindOf?: KindOf) {}

  clear(): void {
    this.axis.clear();
    this.rows.clear();
    this.groups = [];
    this.turns = [];
    this.agents = [];
    this.agentLanes = 0;
    this.turnLanes = 0;
    this.markCount = 0;
    this.lastRow = null;
    this.lastAddedAt = 0;
    this.groupsByKey.clear();
    this.openTurns.clear();
    this.agentsById.clear();
    this.pending.clear();
    this.sessions.clear();
    this.version++;
    this.revision++;
  }

  get counts(): TimelineCounts {
    return { rows: this.rows.size, marks: this.markCount, groups: this.groups.length, turns: this.turns.length, agents: this.agents.length };
  }

  /** Drops the oldest finished call, or the oldest call when every call is still open. */
  private evictPending(): void {
    for (const [id, c] of this.pending) {
      if (c.done) {
        this.pending.delete(id);
        return;
      }
    }
    this.pending.delete(this.pending.keys().next().value!);
  }

  /** Two or more main sessions marked rows: rows get a session stripe. */
  get multiSession(): boolean {
    return this.sessions.size >= 2;
  }

  get isEmpty(): boolean {
    return this.rows.size === 0 && this.turns.length === 0 && this.agents.length === 0;
  }

  /** Rows in display order: groups by first touch, rows by first touch inside each. */
  orderedRows(): TimelineRow[] {
    const out: TimelineRow[] = [];
    for (const g of this.groups) out.push(...g.rows);
    return out;
  }

  /**
   * Adds one event. `addedAt` (a performance.now() value) makes new rows slide in; 0 adds
   * them still (history, replay seek). Returns true when something visible changed.
   */
  add(e: VizEvent, addedAt = 0): boolean {
    const turnOrAgent = this.addSpan(e);
    const targets = markTargets(e, this.kindOf);
    if (!turnOrAgent && targets.length === 0) return false;
    if (this.axis.add(e.ts)) this.version++;
    this.revision++;
    if (targets.length === 0) return true;

    // A Post joins only the Pre drawn on its own row. One Post can become several events (a
    // Bash edit diff marks one file per event) that share the toolUseId, so a match is not
    // consumed; whole calls age out at PENDING_MAX, never single rows of a live call.
    let call = e.toolUseId ? this.pending.get(e.toolUseId) : undefined;
    if (e.toolUseId && e.phase === 'pre') {
      if (call) this.pending.delete(e.toolUseId);
      else call = { ts: e.ts, rows: new Set<string>(), done: false };
      call.ts = e.ts;
      this.pending.set(e.toolUseId, call);
      if (this.pending.size > PENDING_MAX) this.evictPending();
    } else if (call) {
      call.done = true;
    }
    if (e.agentId) this.ensureAgent(e);
    const style = markStyle(e);
    const external = e.external || e.sessionId === EXTERNAL_SESSION;
    if (!external && e.sessionId) this.sessions.add(e.sessionId);
    for (const target of targets) {
      const row = this.row(target, e.ts, addedAt);
      const mark: TimelineMark = { ...style, id: e.id, ts: e.ts, action: e.action, phase: e.phase, sessionId: e.sessionId };
      if (e.agentId) mark.agentId = e.agentId;
      if (call) {
        if (e.phase === 'pre') call.rows.add(target.key);
        else if (call.rows.has(target.key)) mark.startTs = call.ts;
      }
      insertSorted(row.marks, mark);
      this.markCount++;
      if (e.agentId && !row.hasSub) {
        row.hasSub = true;
        this.version++;
      }
      if (!external && e.sessionId && !row.sessions.includes(e.sessionId) && row.sessions.length < ROW_SESSIONS_MAX) {
        row.sessions.push(e.sessionId);
      }
      this.lastRow = row;
    }
    return true;
  }

  private row(t: MarkTarget, ts: number, addedAt: number): TimelineRow {
    let row = this.rows.get(t.key);
    if (row) {
      if (ts < row.firstTs) row.firstTs = ts;
      return row;
    }
    let group = this.groupsByKey.get(t.group);
    if (!group) {
      group = { key: t.group, order: this.groups.length, firstTs: ts, rows: [] };
      this.groupsByKey.set(t.group, group);
      this.groups.push(group);
    }
    row = { key: t.key, path: t.path, kind: t.kind, group: t.group, order: this.rows.size, firstTs: ts, marks: [], sessions: [], hasSub: false, addedAt };
    this.rows.set(t.key, row);
    group.rows.push(row);
    if (addedAt > this.lastAddedAt) this.lastAddedAt = addedAt;
    this.version++;
    return row;
  }

  /** Turns and subagent lifetimes. True when the event opened or closed one. */
  private addSpan(e: VizEvent): boolean {
    switch (e.action) {
      case 'turn_start': {
        // A new prompt while one is still open (no Stop seen): the old one ends here.
        const open = this.openTurns.get(e.sessionId);
        if (open && open.endTs === null) open.endTs = e.ts;
        const lane = freeLane(this.turns, e.ts, MAX_TURN_LANES);
        const turn: TurnSpan = { index: this.turns.length + 1, sessionId: e.sessionId, eventId: e.id, startTs: e.ts, endTs: null, fail: false, lane };
        if (e.detail) turn.detail = e.detail;
        if (lane + 1 > this.turnLanes) {
          this.turnLanes = lane + 1;
          this.version++;
        }
        this.turns.push(turn);
        this.openTurns.set(e.sessionId, turn);
        return true;
      }
      case 'turn_end': {
        const open = this.openTurns.get(e.sessionId);
        if (!open) return false;
        open.endTs = Math.max(open.startTs, e.ts);
        open.fail = e.phase === 'fail';
        this.openTurns.delete(e.sessionId);
        return true;
      }
      case 'subagent_start':
        if (!e.agentId) return false;
        this.ensureAgent(e);
        return true;
      case 'subagent_stop': {
        if (!e.agentId) return false;
        const span = this.ensureAgent(e);
        span.endTs = Math.max(span.startTs, e.ts);
        return true;
      }
      default:
        return false;
    }
  }

  /** The span of a subagent; created at its first event when its start was not seen. */
  private ensureAgent(e: VizEvent): AgentSpan {
    const id = e.agentId!;
    let span = this.agentsById.get(id);
    if (span) {
      if (e.agentType && !span.agentType) span.agentType = e.agentType;
      if (e.action === 'subagent_start' && !span.eventId) span.eventId = e.id;
      return span;
    }
    span = { agentId: id, agentType: e.agentType ?? '', sessionId: e.sessionId, startTs: e.ts, endTs: null, lane: freeLane(this.agents, e.ts, MAX_AGENT_LANES) };
    if (e.action === 'subagent_start') span.eventId = e.id;
    this.agentsById.set(id, span);
    this.agents.push(span);
    if (span.lane + 1 > this.agentLanes) {
      this.agentLanes = span.lane + 1;
      this.version++;
    }
    return span;
  }
}

/**
 * First lane whose spans all ended at or before ts; with every lane busy, the one whose
 * last span ends first (an open span never ends).
 */
function freeLane(spans: readonly { lane: number; endTs: number | null }[], ts: number, max: number): number {
  const lastEnd: (number | null)[] = [];
  for (const a of spans) {
    const prev = lastEnd[a.lane];
    if (prev === null) continue;
    lastEnd[a.lane] = a.endTs === null ? null : Math.max(prev ?? 0, a.endTs);
  }
  for (let lane = 0; lane < max; lane++) {
    const end = lastEnd[lane];
    if (end === undefined || (end !== null && end <= ts)) return lane;
  }
  let best = 0;
  let bestEnd = Infinity;
  for (let lane = 0; lane < max; lane++) {
    const end = lastEnd[lane] ?? Infinity;
    if (end < bestEnd) {
      bestEnd = end;
      best = lane;
    }
  }
  return best;
}

function insertSorted(marks: TimelineMark[], mark: TimelineMark): void {
  const last = marks[marks.length - 1];
  if (!last || last.ts <= mark.ts) {
    marks.push(mark);
    return;
  }
  marks.splice(upperBound(marks, mark.ts, (m) => m.ts), 0, mark);
}

// ---------- layout ----------

export interface LayoutDims {
  groupH: number;
  rowH: number;
  subH: number;
}

export interface LayoutItem {
  type: 'group' | 'row';
  /** Top, from the start of the row area. */
  y: number;
  h: number;
  group: TimelineGroup;
  row?: TimelineRow;
}

/** Vertical positions: a header per group followed by its rows (with a sub-lane when needed). */
export function layoutRows(groups: readonly TimelineGroup[], dims: LayoutDims): { items: LayoutItem[]; height: number } {
  const items: LayoutItem[] = [];
  let y = 0;
  for (const group of groups) {
    items.push({ type: 'group', y, h: dims.groupH, group });
    y += dims.groupH;
    for (const row of group.rows) {
      const h = dims.rowH + (row.hasSub ? dims.subH : 0);
      items.push({ type: 'row', y, h, group, row });
      y += h;
    }
  }
  return { items, height: y };
}

/** Index of the layout item at vertical offset y, or -1. */
export function itemAt(items: readonly LayoutItem[], y: number): number {
  const i = upperBound(items, y, (it) => it.y) - 1;
  if (i < 0) return -1;
  const it = items[i]!;
  return y < it.y + it.h ? i : -1;
}

/** Shortens `text` in the middle ("src/…/user.ts") until `measure` fits in `max`. */
export function ellipsizeMiddle(text: string, max: number, measure: (s: string) => number): string {
  if (measure(text) <= max) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length - 1;
  let best = '…';
  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const head = Math.ceil(keep / 2);
    const candidate = `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`;
    if (measure(candidate) <= max) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}
