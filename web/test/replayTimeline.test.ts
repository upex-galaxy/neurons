import { describe, expect, it } from 'vitest';
import type { LogLine, TreeSnapshot, VizEvent } from '../../src/shared/types.ts';
import { MAX_GAP_MS, buildTimeline, indexAt, segmentStarts } from '../src/replayTimeline.ts';

const tree = (name: string): TreeSnapshot => ({ root: `/r/${name}`, name, truncated: false, entries: [] });
const event = (ts: number): LogLine => ({
  kind: 'event',
  event: { id: String(ts), ts, sessionId: 's', phase: 'post', action: 'read', paths: [], source: 'hook' } as VizEvent,
});

const log: LogLine[] = [
  { kind: 'tree', ts: 0, tree: tree('a') },
  event(500),
  event(1500),
  event(21_500), // 20 s gap -> 3 s
  { kind: 'treeDelta', ts: 22_000, added: [{ path: 'x', kind: 'file' }], removed: [] },
  { kind: 'tree', ts: 100_000, tree: tree('b') }, // 78 s gap -> 3 s
  event(100_400),
];

describe('replay timeline', () => {
  it('finds segments and compresses long gaps', () => {
    expect(segmentStarts(log)).toEqual([0, 5]);
    const tl = buildTimeline(log, 0, null)!;
    expect(tl.tree.name).toBe('a');
    expect(tl.items.map((i) => i.t)).toEqual([500, 1500, 1500 + MAX_GAP_MS, 5000, 5000 + MAX_GAP_MS, 8400]);
    expect(tl.compressedGaps).toBe(2);
    expect(tl.durationMs).toBe(8400);
    expect(tl.savedMs).toBe(20_000 - 3000 + 78_000 - 3000);
  });

  it('starts at the chosen segment and falls back when there is no tree line', () => {
    const tl = buildTimeline(log, 1, null)!;
    expect(tl.tree.name).toBe('b');
    expect(tl.items.length).toBe(1);
    expect(buildTimeline([event(1)], 0, null)).toBeNull();
    expect(buildTimeline([event(1)], 0, tree('f'))!.items.length).toBe(1);
  });

  it('indexes the playhead', () => {
    const tl = buildTimeline(log, 0, null)!;
    expect(indexAt(tl.items, 0)).toBe(0);
    expect(indexAt(tl.items, 1500)).toBe(2);
    expect(indexAt(tl.items, 1e9)).toBe(tl.items.length);
  });
});
