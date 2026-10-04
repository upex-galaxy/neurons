import { describe, expect, it } from 'vitest';
import { MAX_TRAILS, TRAIL_LONG_MS, TRAIL_MS, TrailBook, trailAlpha, trailDuration } from '../src/linkGlow.ts';

describe('trailDuration', () => {
  it('lingers longer for changes and not at all for pre', () => {
    expect(trailDuration('read', 'post')).toBe(TRAIL_MS);
    expect(trailDuration('search', 'fail')).toBe(TRAIL_MS);
    expect(trailDuration('edit', 'post')).toBe(TRAIL_LONG_MS);
    expect(trailDuration('create', 'post')).toBe(TRAIL_LONG_MS);
    expect(trailDuration('delete', 'post')).toBe(TRAIL_LONG_MS);
    expect(trailDuration('edit', 'pre')).toBe(0);
    expect(trailDuration('turn_start', 'info')).toBe(0);
  });
});

describe('trailAlpha', () => {
  it('starts full and fades monotonically to zero', () => {
    expect(trailAlpha(0)).toBe(1);
    expect(trailAlpha(1)).toBe(0);
    let prev = 1;
    for (let t = 0.1; t < 1; t += 0.1) {
      const a = trailAlpha(t);
      expect(a).toBeLessThan(prev);
      prev = a;
    }
  });
});

describe('TrailBook', () => {
  it('creates once per link, last color wins and the fade restarts', () => {
    const created: string[] = [];
    const released: string[] = [];
    const book = new TrailBook<string>(
      (key, color) => {
        created.push(`${key}:${color}`);
        return key;
      },
      (d) => released.push(d),
    );
    book.touch('a->b', '#f00', 1000, 0);
    const again = book.touch('a->b', '#0f0', 1000, 600);
    expect(again.recolor).toBe(true);
    expect(created).toEqual(['a->b:#f00']);
    expect(book.get('a->b')).toMatchObject({ color: '#0f0', start: 600 });
    expect(book.touch('a->b', '#0f0', 1000, 700).recolor).toBe(false);

    // Only live trails are visited; an ended one is released.
    book.touch('b->c', '#00f', 500, 0);
    const seen: string[] = [];
    book.step(1000, (tr, alpha) => {
      seen.push(tr.key);
      expect(alpha).toBeGreaterThan(0);
    });
    expect(seen).toEqual(['a->b']);
    expect(released).toEqual(['b->c']);
    book.step(1700, () => {
      throw new Error('should have ended');
    });
    expect(book.size).toBe(0);
    expect(released).toEqual(['b->c', 'a->b']);
  });

  it('evicts the least recently touched link past the limit', () => {
    const released: string[] = [];
    const book = new TrailBook<string>((k) => k, (d) => released.push(d), 3);
    book.touch('1', '#fff', 1000, 0);
    book.touch('2', '#fff', 1000, 0);
    book.touch('3', '#fff', 1000, 0);
    book.touch('1', '#fff', 1000, 10);
    book.touch('4', '#fff', 1000, 20);
    expect(released).toEqual(['2']);
    expect(book.keys()).toEqual(['3', '1', '4']);
    expect(MAX_TRAILS).toBeGreaterThan(100);
  });

  it('clear releases everything', () => {
    const released: string[] = [];
    const book = new TrailBook<string>((k) => k, (d) => released.push(d));
    book.touch('x', '#fff', 1000, 0);
    book.clear();
    expect(released).toEqual(['x']);
    expect(book.size).toBe(0);
  });
});
