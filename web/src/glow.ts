// Glow state shared by the 3D and 2D renderers: pulses, fade-outs, subagent halos and
// residual heat. Only nodes with an active glow are sampled per frame.
import { Color } from 'three';

export const GLOW_DURATION_MS = 3500;
export const FADE_OUT_MS = 600;
const BLINK_PERIOD_MS = 160;
export const REMOVE_COLOR = '#ef4444';
/** Residual heat tints idle nodes toward this color. */
export const HEAT_COLOR = new Color('#fdba74');

export interface PulseOptions {
  /** 0..1, how far the node goes toward the glow color and how much it grows. */
  intensity: number;
  durationMs?: number;
  /** Number of on/off blinks at the start (fail). */
  blinks?: number;
  /** Subagent hue: draws a ring around the node while it glows. */
  halo?: string;
}

interface Glow {
  color: Color;
  halo: Color | null;
  start: number;
  duration: number;
  peak: number;
  blinks: number;
  fade: boolean;
}

/** What a renderer needs to draw one node this frame. */
export interface GlowSample {
  color: Color;
  opacity: number;
  /** Multiplier on the node's base scale. 0 when a fade-out finished. */
  scale: number;
  halo: Color | null;
  haloAlpha: number;
  /** False once the glow is over: the renderer restores the idle look and stops sampling. */
  alive: boolean;
}

/** Idle color: base tinted by heat (0 = no heat). */
export function idleColor(out: Color, base: Color, heat: number): Color {
  out.copy(base);
  if (heat > 0) out.lerp(HEAT_COLOR, heat * 0.7).multiplyScalar(1 + heat * 0.6);
  return out;
}

export class GlowBook {
  private readonly glows = new Map<string, Glow>();
  readonly heat = new Map<string, number>();

  pulse(id: string, color: string, opts: PulseOptions, now = performance.now()): void {
    const prev = this.glows.get(id);
    // A node fading out stays fading; a weaker pulse must not cut a stronger one short.
    if (prev?.fade) return;
    const peak = opts.intensity;
    if (prev) {
      const prevK = prev.peak * (1 - (now - prev.start) / prev.duration) ** 2;
      if (prevK > peak && !opts.halo) return;
    }
    this.glows.set(id, {
      color: new Color(color),
      halo: opts.halo ? new Color(opts.halo) : null,
      start: now,
      duration: opts.durationMs ?? GLOW_DURATION_MS,
      peak,
      blinks: opts.blinks ?? 0,
      fade: false,
    });
  }

  fadeOut(id: string, now = performance.now()): void {
    this.glows.set(id, {
      color: new Color(REMOVE_COLOR),
      halo: null,
      start: now,
      duration: FADE_OUT_MS,
      peak: 1,
      blinks: 0,
      fade: true,
    });
  }

  has(id: string): boolean {
    return this.glows.has(id);
  }

  isFading(id: string): boolean {
    return this.glows.get(id)?.fade === true;
  }

  delete(id: string): void {
    this.glows.delete(id);
  }

  clear(): void {
    this.glows.clear();
  }

  ids(): IterableIterator<string> {
    return this.glows.keys();
  }

  get size(): number {
    return this.glows.size;
  }

  /**
   * Samples the glow of `id` at `now` into `out`. `idle` is the node's idle color
   * (base + heat) and `baseOpacity` its idle opacity. Ended glows are removed.
   */
  sample(id: string, idle: Color, baseOpacity: number, now: number, out: GlowSample): boolean {
    const glow = this.glows.get(id);
    if (!glow) return false;
    const t = (now - glow.start) / glow.duration;
    out.halo = null;
    out.haloAlpha = 0;
    if (glow.fade) {
      const k = Math.min(1, Math.max(0, t));
      out.color.copy(glow.color).multiplyScalar(1.2 * (1 - k) + 0.2);
      out.opacity = baseOpacity * (1 - k);
      out.scale = t >= 1 ? 0 : 1 + 0.6 * (1 - k);
      out.alive = t < 1;
      if (t >= 1) this.glows.delete(id);
      return true;
    }
    if (t >= 1) {
      out.color.copy(idle);
      out.opacity = baseOpacity;
      out.scale = 1;
      out.alive = false;
      this.glows.delete(id);
      return true;
    }
    let k = glow.peak * (1 - t) * (1 - t);
    const elapsed = now - glow.start;
    if (glow.blinks > 0 && elapsed < glow.blinks * 2 * BLINK_PERIOD_MS) {
      if (Math.floor(elapsed / BLINK_PERIOD_MS) % 2 === 1) k *= 0.1;
    }
    out.color.copy(idle).lerp(glow.color, Math.min(1, k * 1.6)).multiplyScalar(1 + 0.9 * k);
    out.opacity = Math.min(1, baseOpacity + k);
    out.scale = 1 + 0.9 * k;
    if (glow.halo) {
      out.halo = glow.halo;
      // The ring outlives the core flash a little so the agent stays readable.
      out.haloAlpha = Math.min(1, 0.25 + 1.2 * (1 - t));
    }
    out.alive = true;
    return true;
  }
}

export function newSample(): GlowSample {
  return { color: new Color(), opacity: 1, scale: 1, halo: null, haloAlpha: 0, alive: false };
}
