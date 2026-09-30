// Event records kept in the page (no DOM): feed items, filters, counters and heat.
// Pure so it can be unit tested in Node.
import { FILE_ACTIONS, type Action, type VizEvent } from '../../src/shared/types.ts';
import type { FeedItem, Filters } from './state.ts';
import { normalizePath } from './treeModel.ts';

export const MAIN_AGENT = 'main';
const RECORD_LIMIT = 20_000;

export interface EventRecord {
  item: FeedItem;
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
  if (event.external) item.external = true;
  return item;
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
  return { item: feedItem(event), heatIds, counts };
}

export interface Aggregate {
  counters: Partial<Record<Action, number>>;
  fails: number;
  heat: Map<string, number>;
}

export function emptyAggregate(): Aggregate {
  return { counters: {}, fails: 0, heat: new Map() };
}

export function accumulate(agg: Aggregate, rec: EventRecord): void {
  if (!rec.counts) return;
  const a = rec.item.action;
  agg.counters[a] = (agg.counters[a] ?? 0) + 1;
  if (rec.item.phase === 'fail') agg.fails++;
  for (const id of rec.heatIds) agg.heat.set(id, (agg.heat.get(id) ?? 0) + 1);
}

export class EventStore {
  private records: EventRecord[] = [];

  add(event: VizEvent): EventRecord {
    const rec = toRecord(event);
    this.records.push(rec);
    if (this.records.length > RECORD_LIMIT) this.records.splice(0, this.records.length - RECORD_LIMIT);
    return rec;
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

  aggregate(f: Filters): Aggregate {
    const agg = emptyAggregate();
    for (const rec of this.records) if (passes(rec.item, f)) accumulate(agg, rec);
    return agg;
  }
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
