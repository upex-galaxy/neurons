// Event records kept in the page (no DOM): feed items, filters, counters and heat.
// Pure so it can be unit tested in Node.
import { FILE_ACTIONS, type Action, type VizEvent } from '../../src/shared/types.ts';
import { t } from './i18n.ts';
import { worktreeLabel } from './labels.ts';
import type { FeedItem, Filters } from './state.ts';
import { emptyTally, tallyEvent, type ToolTally } from './tools.ts';
import { normalizePath } from './treeModel.ts';

export const MAIN_AGENT = 'main';
export const RECORD_LIMIT = 20_000;
/**
 * Records dropped at once when the limit is reached, so a trim (and the Timeline rebuild
 * that follows it) happens once per this many events, not on every one.
 */
export const TRIM_CHUNK = 1_000;

export interface EventRecord {
  item: FeedItem;
  /** The event as received (paths and metadata only, never file content). */
  event: VizEvent;
  /** Node ids that gain heat from this event (empty for pre and non-file actions). */
  heatIds: string[];
  /** Counts toward counters (not a pre). */
  counts: boolean;
}

export function feedItem(event: VizEvent): FeedItem {
  const item: FeedItem = {
    id: event.id,
    ts: event.ts,
    sessionId: event.sessionId,
    action: event.action,
    phase: event.phase,
    path: event.paths[0] ?? event.outsideRepo?.[0] ?? '',
  };
  if (event.agentId) item.agentId = event.agentId;
  if (event.agentType) item.agentType = event.agentType;
  if (event.detail) item.detail = event.detail;
  if (event.denied) item.denied = true;
  if (event.external) item.external = true;
  if (event.worktree) item.worktree = event.worktree;
  return item;
}

/**
 * The small tag shown next to a feed row's path when the event happened in a subagent
 * worktree (the path is the main-repo equivalent), or undefined.
 */
export function pathTag(item: Pick<FeedItem, 'path' | 'worktree'>): { text: string; title: string } | undefined {
  if (!item.worktree) return undefined;
  return {
    text: worktreeLabel(),
    title: t('feed.worktreeTitle', { name: item.worktree }),
  };
}

export function passes(item: Pick<FeedItem, 'sessionId' | 'agentId' | 'external'>, f: Filters): boolean {
  if (f.session && item.sessionId !== f.session) return false;
  if (f.agent === MAIN_AGENT) {
    if (item.agentId) return false;
  } else if (f.agent && item.agentId !== f.agent) {
    return false;
  }
  if (!f.showExternal && item.external) return false;
  return true;
}

export function toRecord(event: VizEvent): EventRecord {
  const counts = event.phase !== 'pre';
  const heatIds: string[] = [];
  if (counts && FILE_ACTIONS.includes(event.action)) {
    for (const raw of event.paths) heatIds.push(normalizePath(raw));
    for (const raw of event.outsideRepo ?? []) heatIds.push(normalizePath(raw));
  }
  return { item: feedItem(event), event, heatIds, counts };
}

export interface Aggregate {
  counters: Partial<Record<Action, number>>;
  fails: number;
  heat: Map<string, number>;
  /** Skills, MCP, CLI programs and built-in tools (finished calls only). */
  tools: ToolTally;
}

export function emptyAggregate(): Aggregate {
  return { counters: {}, fails: 0, heat: new Map(), tools: emptyTally() };
}

export function accumulate(agg: Aggregate, rec: EventRecord): void {
  if (!rec.counts) return;
  tallyEvent(agg.tools, rec.event);
  const a = rec.item.action;
  agg.counters[a] = (agg.counters[a] ?? 0) + 1;
  if (rec.item.phase === 'fail') agg.fails++;
  for (const id of rec.heatIds) agg.heat.set(id, (agg.heat.get(id) ?? 0) + 1);
}

export class EventStore {
  private records: EventRecord[] = [];
  private trimCount = 0;

  add(event: VizEvent): EventRecord {
    const rec = toRecord(event);
    this.records.push(rec);
    if (this.records.length > RECORD_LIMIT) {
      this.records.splice(0, this.records.length - (RECORD_LIMIT - TRIM_CHUNK));
      this.trimCount++;
    }
    return rec;
  }

  /** How many times the oldest records were dropped. Views built from the records rebuild when it changes. */
  get trims(): number {
    return this.trimCount;
  }

  clear(): void {
    this.records = [];
  }

  get size(): number {
    return this.records.length;
  }

  /** The newest `limit` items that pass the filter, oldest first. */
  visible(f: Filters, limit: number): FeedItem[] {
    const out: FeedItem[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.records[i]!;
      if (passes(rec.item, f)) out.push(rec.item);
    }
    return out.reverse();
  }

  /** The record with this event id, or undefined once it left the buffer. */
  get(id: string): EventRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i]!.item.id === id) return this.records[i];
    return undefined;
  }

  /**
   * The id of the event before (`dir` -1) or after (+1) `id` among those that pass the
   * filter, or undefined at either end.
   */
  neighbor(id: string, dir: -1 | 1, f: Filters): string | undefined {
    let i = this.records.length - 1;
    while (i >= 0 && this.records[i]!.item.id !== id) i--;
    if (i < 0) return undefined;
    for (let j = i + dir; j >= 0 && j < this.records.length; j += dir) {
      const rec = this.records[j]!;
      if (passes(rec.item, f)) return rec.item.id;
    }
    return undefined;
  }

  /** Newest first: events that touched `path` (target, move source or search hit). */
  forPath(path: string, f: Filters, limit: number): EventRecord[] {
    const out: EventRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const rec = this.records[i]!;
      if (passes(rec.item, f) && touches(rec.event, path)) out.push(rec);
    }
    return out;
  }

  /** Every record that passes the filter, oldest first. */
  forEach(f: Filters, cb: (rec: EventRecord) => void): void {
    for (const rec of this.records) if (passes(rec.item, f)) cb(rec);
  }

  aggregate(f: Filters): Aggregate {
    const agg = emptyAggregate();
    for (const rec of this.records) if (passes(rec.item, f)) accumulate(agg, rec);
    return agg;
  }
}

/** True when the event names `path` as a target, a move source or a secondary hit. */
export function touches(event: VizEvent, path: string): boolean {
  const hit = (list: readonly string[] | undefined): boolean => !!list?.some((p) => normalizePath(p) === path);
  return hit(event.paths) || hit(event.fromPaths) || hit(event.secondary) || hit(event.outsideRepo);
}

/** Residual glow per id: 0.15 + 0.6 * count / max, for ids with heat > 0. */
export function heatIntensity(heat: ReadonlyMap<string, number>): Map<string, number> {
  let max = 0;
  for (const v of heat.values()) if (v > max) max = v;
  const out = new Map<string, number>();
  if (max === 0) return out;
  for (const [id, v] of heat) if (v > 0) out.set(id, 0.15 + (0.6 * v) / max);
  return out;
}
