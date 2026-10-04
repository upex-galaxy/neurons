import { describe, expect, it } from 'vitest';
import { STREAM_MAX, STREAM_TTL_MS, StreamQueue, type StreamLine } from '../src/streamQueue.ts';

function line(key: string, over: Partial<StreamLine> = {}): Omit<StreamLine, 'expires'> {
  return { id: key, key, action: 'read', phase: 'post', target: `src/${key}.ts`, sessionId: 's1', ...over };
}

describe('StreamQueue', () => {
  it('keeps the newest lines at the bottom, at most STREAM_MAX', () => {
    const q = new StreamQueue();
    const removed: string[] = [];
    for (let i = 0; i < STREAM_MAX + 2; i++) removed.push(...q.push(line(`f${i}`), 0).removed.map((l) => l.key));
    expect(q.size).toBe(STREAM_MAX);
    expect(removed).toEqual(['f0', 'f1']);
    expect(q.items().at(-1)?.key).toBe(`f${STREAM_MAX + 1}`);
  });

  it('merges a Post into the line of its Pre (same key) and restarts its clock', () => {
    const q = new StreamQueue();
    q.push(line('k', { id: 'pre', phase: 'pre' }), 0);
    const change = q.push(line('k', { id: 'post', phase: 'post', action: 'edit' }), 1000);
    expect(change.added).toBeUndefined();
    expect(change.updated?.id).toBe('post');
    expect(q.size).toBe(1);
    expect(q.items()[0]).toMatchObject({ id: 'post', phase: 'post', action: 'edit', expires: 1000 + STREAM_TTL_MS });
  });

  it('expires lines after the TTL and pauses while hovered', () => {
    const q = new StreamQueue(6, 1000);
    q.push(line('a'), 0);
    q.push(line('b'), 500);
    q.pause(600);
    expect(q.expire(5000)).toEqual([]);
    expect(q.paused).toBe(true);
    q.resume(5600); // paused 5000 ms: a now ends at 6000, b at 6500
    expect(q.expire(5999)).toEqual([]);
    expect(q.expire(6000).map((l) => l.key)).toEqual(['a']);
    expect(q.expire(6500).map((l) => l.key)).toEqual(['b']);
    expect(q.size).toBe(0);
  });

  it('clears everything at once', () => {
    const q = new StreamQueue();
    q.push(line('a'), 0);
    q.push(line('b'), 0);
    expect(q.clear().map((l) => l.key)).toEqual(['a', 'b']);
    expect(q.size).toBe(0);
  });
});
