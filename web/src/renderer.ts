// Adapter implemented by the 3D (3d-force-graph) and 2D (force-graph) views. Effects and
// main only talk to this interface, so toggling the view keeps model, heat and feed.
import type { PulseOptions } from './glow.ts';
import { OUTSIDE_HUB_ID, ROOT_ID, type GraphData, type VizLink, type VizNode } from './treeModel.ts';

export type RendererKind = '3d' | '2d';

export interface ParticleStyle {
  color: string;
  width: number;
  /** Fraction of the link per frame. */
  speed: number;
  /** Subagent hue: ring around the particle. */
  halo?: string;
}

export interface RendererOptions {
  /** Hover label (HTML-escaped text). */
  label(node: VizNode): string;
  onNodeClick(node: VizNode): void;
}

export interface Renderer {
  readonly kind: RendererKind;
  /** Pushes visible nodes/links. `initial` runs a warmup and zooms to fit. Returns the live links. */
  setData(data: GraphData, initial: boolean): readonly VizLink[];
  emitParticle(link: VizLink, style: ParticleStyle): void;
  pulse(id: string, color: string, opts: PulseOptions): void;
  fadeOut(id: string): void;
  /** Stops a fade-out (the path came back before its purge) and restores the idle look. */
  cancelFade(id: string): void;
  /** Briefly lights a link (moves). */
  flashLink(link: VizLink, color: string, durationMs: number): void;
  /** Drops per-node state for purged nodes. */
  forget(ids: string[]): void;
  /** Re-reads node flags (collapsed) after a change. */
  refreshNode(node: VizNode): void;
  /** Residual glow per visible node id, 0..1. Replaces the previous map. */
  setHeat(heat: ReadonlyMap<string, number>): void;
  activeIds(): string[];
  /** Screen position relative to the container, or null when off screen/behind the camera. */
  screenCoords(node: VizNode): { x: number; y: number } | null;
  onFirstLayout(cb: () => void): void;
  zoomToFit(ms?: number): void;
  dispose(): void;
}

export const BACKGROUND = '#05060a';
export const LINK_COLOR = '#3a5680';

const DIR_COLOR = '#1e3a5f';
const FILE_COLOR = '#1f2a44';
const ROOT_COLOR = '#3b6ea8';
const COLLAPSED_COLOR = '#2f5d8f';
const HUB_COLOR = '#5b4a8a';
const GROUP_COLOR = '#3b2f5c';
const SATELLITE_COLOR = '#2a2340';

export function baseColor(node: VizNode): string {
  if (node.id === ROOT_ID) return ROOT_COLOR;
  if (node.id === OUTSIDE_HUB_ID) return HUB_COLOR;
  if (node.outside) return node.kind === 'dir' ? GROUP_COLOR : SATELLITE_COLOR;
  if (node.collapsed) return COLLAPSED_COLOR;
  return node.kind === 'dir' ? DIR_COLOR : FILE_COLOR;
}

export function baseOpacity(node: VizNode): number {
  return node.kind === 'dir' ? 0.95 : 0.85;
}

/** Node radius in scene units. Collapsed dirs render slightly bigger. */
export function nodeRadius(node: VizNode): number {
  if (node.id === ROOT_ID) return 4.2;
  if (node.id === OUTSIDE_HUB_ID) return 3.4;
  if (node.kind === 'file') return 1.3;
  return node.collapsed ? 3.4 : 2.4;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
