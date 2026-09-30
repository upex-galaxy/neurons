// Turns a VizEvent into light: particle chains along the tree, node pulses, subagent
// halos, satellites outside the repo and the pink flash of moves.
import { Color } from 'three';
import { ACTION_COLORS, EXTERNAL_COLOR, FAIL_COLOR, type TreeEntry, type VizEvent } from '../../src/shared/types.ts';
import { BACKGROUND, type ParticleStyle, type Renderer } from './renderer.ts';
import { ROOT_ID, normalizePath, parentPath, type TreeModel } from './treeModel.ts';

export const HOP_INTERVAL_MS = 80;
/** ~5.5 frames per hop at 60 fps, about 90 ms. */
export const PARTICLE_SPEED = 0.18;
const HOP_TRAVEL_MS = Math.round(1000 / 60 / PARTICLE_SPEED);
const MAX_PATHS_PER_EVENT = 16;
const MAX_SECONDARY = 40;
const MOVE_FLASH_MS = 900;
/** Tree deltas are flushed every 150 ms; a move's new link may appear a bit after its event. */
const MOVE_RETRY_MS = 260;

interface EventStyle {
  particle: ParticleStyle;
  pulse: number;
  blinks: number;
  color: string;
  halo?: string;
}

export interface EffectsContext {
  model: TreeModel;
  /** Current renderer (it changes when toggling 3D/2D). */
  view(): Renderer;
  agentColor(agentId: string): string;
  /** Called once per event, when its first particle leaves the root. */
  onFirstEmit(event: VizEvent): void;
  /**
   * Bumped on every reset (replay seek/restart, leaving replay, reconnect). Timers of an
   * event played under an older value do nothing, so they cannot light the new tree.
   */
  generation(): number;
}

/** Runs `fn` after `ms` unless the context was reset in between. */
type Later = (fn: () => void, ms: number) => void;

export function dim(hex: string, amount: number): string {
  return `#${new Color(hex).lerp(new Color(BACKGROUND), amount).getHexString()}`;
}

function styleFor(event: VizEvent, halo: string | undefined): EventStyle {
  const withHalo = (s: EventStyle): EventStyle => {
    if (!halo) return s;
    return { ...s, halo, particle: { ...s.particle, halo } };
  };
  if (event.phase === 'fail') {
    return withHalo({ particle: { color: FAIL_COLOR, width: 2, speed: PARTICLE_SPEED }, pulse: 0.9, blinks: 3, color: FAIL_COLOR });
  }
  if (event.external) {
    return { particle: { color: EXTERNAL_COLOR, width: 1.5, speed: PARTICLE_SPEED }, pulse: 0.5, blinks: 0, color: EXTERNAL_COLOR };
  }
  const color = ACTION_COLORS[event.action];
  if (event.phase === 'pre') {
    return withHalo({ particle: { color: dim(color, 0.45), width: 1.2, speed: PARTICLE_SPEED }, pulse: 0.35, blinks: 0, color });
  }
  return withHalo({ particle: { color, width: 2.5, speed: PARTICLE_SPEED }, pulse: 1, blinks: 0, color });
}

/**
 * Sends particles hop by hop from the root (or the outside hub) to `path`, or to its deepest
 * visible ancestor, and pulses the destination on arrival. Returns the arrival delay in ms.
 */
function lightPath(ctx: EffectsContext, later: Later, path: string, style: EventStyle, onEmit: () => void): number {
  const chain = ctx.model.chain(path);
  if (chain.length === 0) return 0;
  const hops = chain.length - 1;
  const target = chain[chain.length - 1] ?? ROOT_ID;
  for (let i = 0; i < hops; i++) {
    const from = chain[i]!;
    const to = chain[i + 1]!;
    later(() => {
      const link = ctx.model.link(from, to);
      if (!link) return;
      ctx.view().emitParticle(link, style.particle);
      onEmit();
      if (i + 1 < hops) {
        // Faint trace on the dirs the light passes through.
        later(() => ctx.view().pulse(to, style.color, { intensity: style.pulse * 0.2, durationMs: 900 }), HOP_TRAVEL_MS);
      }
    }, i * HOP_INTERVAL_MS);
  }
  const arrival = hops === 0 ? 0 : (hops - 1) * HOP_INTERVAL_MS + HOP_TRAVEL_MS;
  later(() => {
    const opts = { intensity: style.pulse, blinks: style.blinks, ...(style.halo ? { halo: style.halo } : {}) };
    ctx.view().pulse(target, style.color, opts);
  }, arrival);
  if (hops === 0) onEmit();
  return arrival;
}

/** Faint flash on search hits, with one short particle from each hit's parent. */
function flashSecondary(ctx: EffectsContext, later: Later, paths: string[], style: EventStyle, delay: number): void {
  const color = style.color;
  later(() => {
    for (const raw of paths.slice(0, MAX_SECONDARY)) {
      const path = normalizePath(raw);
      if (!ctx.model.isVisible(path)) continue;
      const link = ctx.model.link(parentPath(path), path);
      if (link) ctx.view().emitParticle(link, { color: dim(color, 0.3), width: 1, speed: PARTICLE_SPEED });
      later(() => ctx.view().pulse(path, color, { intensity: 0.3, durationMs: 1800 }), HOP_TRAVEL_MS);
    }
  }, delay);
}

/** Pink flash on the link into `path`; retried once if the tree delta has not landed yet. */
function flashInto(ctx: EffectsContext, later: Later, path: string, color: string, retry: boolean): void {
  const p = normalizePath(path);
  const link = ctx.model.isVisible(p) ? ctx.model.link(parentPath(p), p) : undefined;
  if (link) {
    ctx.view().flashLink(link, color, MOVE_FLASH_MS);
    return;
  }
  if (retry) later(() => flashInto(ctx, later, path, color, false), MOVE_RETRY_MS);
}

/** Renders one live event. History (hello.recent) must not go through here. */
export function playEvent(ctx: EffectsContext, event: VizEvent): void {
  const halo = event.agentId && !event.external ? ctx.agentColor(event.agentId) : undefined;
  const style = styleFor(event, halo);
  const gen = ctx.generation();
  const later: Later = (fn, ms) => {
    setTimeout(() => {
      if (ctx.generation() === gen) fn();
    }, ms);
  };
  let emitted = false;
  const onEmit = (): void => {
    if (emitted) return;
    emitted = true;
    ctx.onFirstEmit(event);
  };

  const paths = event.paths.slice(0, MAX_PATHS_PER_EVENT);

  if (event.action === 'move' && event.phase !== 'pre') {
    const pink = ACTION_COLORS.move;
    for (const p of event.fromPaths?.slice(0, MAX_PATHS_PER_EVENT) ?? []) {
      const fromStyle = { ...style, particle: { ...style.particle, color: dim(style.color, 0.5) }, pulse: style.pulse * 0.4 };
      lightPath(ctx, later, p, fromStyle, onEmit);
      flashInto(ctx, later, p, pink, false);
    }
    for (const p of paths) flashInto(ctx, later, p, pink, true);
  }

  let arrival = 0;
  for (const p of paths) arrival = Math.max(arrival, lightPath(ctx, later, p, style, onEmit));
  for (const abs of event.outsideRepo?.slice(0, MAX_PATHS_PER_EVENT) ?? []) {
    arrival = Math.max(arrival, lightPath(ctx, later, abs, style, onEmit));
  }

  if (event.secondary?.length && event.phase !== 'pre') flashSecondary(ctx, later, event.secondary, style, arrival);

  if (paths.length > 0 || event.outsideRepo?.length) return;

  const rootPulse = (intensity: number, durationMs: number): void => {
    const opts = { intensity, durationMs, ...(halo ? { halo } : {}) };
    ctx.view().pulse(ROOT_ID, ACTION_COLORS[event.action], opts);
    onEmit();
  };
  switch (event.action) {
    case 'subagent_start':
    case 'subagent_stop':
      rootPulse(0.45, 1800);
      break;
    case 'turn_start':
    case 'compact':
      rootPulse(0.3, 1500);
      break;
    default:
      break;
  }
}

/** Paths an event wants visible (repo paths and move sources); used to auto-expand collapsed dirs. */
export function eventTargets(event: VizEvent): string[] {
  const out = event.paths.slice(0, MAX_PATHS_PER_EVENT).map(normalizePath);
  for (const p of event.fromPaths?.slice(0, MAX_PATHS_PER_EVENT) ?? []) out.push(normalizePath(p));
  return out;
}

/**
 * True when a target of the event is not in the model yet but a buffered tree delta adds
 * it (the server sends the delta right before a create or a move). Playing the event now
 * would stop the light at the parent dir, so it has to wait for the flush.
 */
export function waitsForDelta(event: VizEvent, model: TreeModel, pendingAdded: readonly TreeEntry[]): boolean {
  if (pendingAdded.length === 0) return false;
  const missing = new Set(eventTargets(event).filter((p) => model.get(p) === undefined));
  if (missing.size === 0) return false;
  return pendingAdded.some((e) => missing.has(normalizePath(e.path)));
}
