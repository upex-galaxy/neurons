// Lingering path glow: after a particle chain reaches its target, the links it crossed stay
// tinted in the action color and fade slowly. Bookkeeping only (no three.js, no canvas), so
// renderers iterate just the touched links each frame and tests run in Node.
import type { Action, Phase } from '../../src/shared/types.ts';

export const TRAIL_MS = 5000;
/** Changes to the tree (edit, create, delete) linger longer. */
export const TRAIL_LONG_MS = 7000;
/** Links tinted at once; the oldest is dropped past this. */
export const MAX_TRAILS = 600;

const LONG_ACTIONS: ReadonlySet<Action> = new Set<Action>(['edit', 'create', 'delete']);

/** How long the path of an event lingers, or 0 when it leaves no trail (pre phase). */
export function trailDuration(action: Action, phase: Phase): number {
  if (phase === 'pre' || phase === 'info') return 0;
  return LONG_ACTIONS.has(action) ? TRAIL_LONG_MS : TRAIL_MS;
}

/** Opacity of a trail at fraction `t` of its life: full at once, then a slow ease-out. */
export function trailAlpha(t: number): number {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return (1 - t) ** 1.7;
}

export interface Trail<D> {
  key: string;
  color: string;
  start: number;
  duration: number;
  /** Renderer data (a three.js line, a cached css color...), created on first touch. */
  data: D;
}

export class TrailBook<D> {
  private readonly trails = new Map<string, Trail<D>>();

  constructor(
    private readonly create: (key: string, color: string) => D,
    /** Called when a trail ends or is evicted, to free its renderer data. */
    private readonly release: (data: D) => void = () => {},
    private readonly limit = MAX_TRAILS,
  ) {}

  /**
   * Tints `key`. On a link that is still glowing the last color wins and the fade restarts;
   * `recolor` says whether the renderer has to update its data for the new color.
   */
  touch(key: string, color: string, duration: number, now: number): { trail: Trail<D>; recolor: boolean } {
    const prev = this.trails.get(key);
    if (prev) {
      const recolor = prev.color !== color;
      prev.color = color;
      prev.start = now;
      prev.duration = duration;
      // Re-insert so eviction order stays "least recently touched first".
      this.trails.delete(key);
      this.trails.set(key, prev);
      return { trail: prev, recolor };
    }
    const trail: Trail<D> = { key, color, start: now, duration, data: this.create(key, color) };
    this.trails.set(key, trail);
    while (this.trails.size > this.limit) {
      const oldest = this.trails.keys().next().value as string;
      this.drop(oldest);
    }
    return { trail, recolor: false };
  }

  /** Visits every live trail with its opacity; ended ones are released and removed. */
  step(now: number, visit: (trail: Trail<D>, alpha: number) => void): void {
    for (const trail of [...this.trails.values()]) {
      const t = (now - trail.start) / trail.duration;
      if (t >= 1) {
        this.drop(trail.key);
        continue;
      }
      visit(trail, trailAlpha(t));
    }
  }

  drop(key: string): void {
    const trail = this.trails.get(key);
    if (!trail) return;
    this.trails.delete(key);
    this.release(trail.data);
  }

  clear(): void {
    for (const trail of this.trails.values()) this.release(trail.data);
    this.trails.clear();
  }

  has(key: string): boolean {
    return this.trails.has(key);
  }

  get(key: string): Trail<D> | undefined {
    return this.trails.get(key);
  }

  get size(): number {
    return this.trails.size;
  }

  keys(): string[] {
    return [...this.trails.keys()];
  }
}
