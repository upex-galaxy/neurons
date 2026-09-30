// Pure replay timeline: splits a LogLine[] into segments (one per 'tree' line) and puts
// every later line on a compressed clock where gaps longer than MAX_GAP_MS become MAX_GAP_MS.
import type { LogLine, TreeSnapshot } from '../../src/shared/types.ts';

export const MAX_GAP_MS = 3000;

export interface TimedLine {
  /** Position on the compressed timeline, ms from the segment start. */
  t: number;
  /** Original epoch ms. */
  ts: number;
  line: LogLine;
}

export interface Timeline {
  tree: TreeSnapshot;
  startTs: number;
  items: TimedLine[];
  durationMs: number;
  compressedGaps: number;
  /** Real time removed by compression, ms. */
  savedMs: number;
}

export function lineTs(line: LogLine): number {
  return line.kind === 'event' ? line.event.ts : line.ts;
}

/** Indexes of the 'tree' lines: each one starts a segment. */
export function segmentStarts(lines: readonly LogLine[]): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (l.kind === 'tree') out.push(i);
  });
  return out;
}

/**
 * Timeline from segment `segment` to the end of the log. Later 'tree' lines stay in the
 * list (they reset the tree when played). `fallback` is used when the log has no tree line.
 */
export function buildTimeline(lines: readonly LogLine[], segment: number, fallback: TreeSnapshot | null): Timeline | null {
  const starts = segmentStarts(lines);
  let from = 0;
  let tree: TreeSnapshot | null = fallback;
  let startTs = lines.length ? lineTs(lines[0]!) : 0;
  if (starts.length) {
    const idx = starts[Math.max(0, Math.min(segment, starts.length - 1))]!;
    const first = lines[idx] as Extract<LogLine, { kind: 'tree' }>;
    tree = first.tree;
    startTs = first.ts;
    from = idx + 1;
  }
  if (!tree) return null;
  const items: TimedLine[] = [];
  let t = 0;
  let prev = startTs;
  let compressedGaps = 0;
  let savedMs = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    const ts = lineTs(line);
    let gap = Math.max(0, ts - prev);
    if (gap > MAX_GAP_MS) {
      compressedGaps++;
      savedMs += gap - MAX_GAP_MS;
      gap = MAX_GAP_MS;
    }
    t += gap;
    prev = Math.max(prev, ts);
    items.push({ t, ts, line });
  }
  return { tree, startTs, items, durationMs: t, compressedGaps, savedMs };
}

/** Number of items with t <= playhead (items are sorted by t). */
export function indexAt(items: readonly TimedLine[], playhead: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.t <= playhead) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
