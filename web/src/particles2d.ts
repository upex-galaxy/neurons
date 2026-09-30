// Particles of the 2D view, kept outside force-graph. Its photons live on `link.__photons`,
// are wiped by every graphData() call and carry no style of their own (the canvas callback
// only gets the link), so in-flight particles vanished on structural updates and took the
// style of the last emit on a shared link. Here each particle keeps the style it was
// emitted with and survives setData while its link stays in the graph.
import type { ParticleStyle } from './renderer.ts';
import type { VizLink, VizNode } from './treeModel.ts';

const FRAME_MS = 1000 / 60;

export interface Particle2D {
  link: VizLink;
  color: string;
  width: number;
  halo?: string;
  start: number;
  /** Travel time over the whole link, from the per-frame speed at 60 fps. */
  duration: number;
}

function endpoint(end: string | VizNode): VizNode | null {
  return typeof end === 'object' ? end : null;
}

export class ParticleTrack {
  private list: Particle2D[] = [];

  add(link: VizLink, style: ParticleStyle, now: number): void {
    this.list.push({
      link,
      color: style.color,
      width: style.width,
      ...(style.halo ? { halo: style.halo } : {}),
      start: now,
      duration: FRAME_MS / Math.max(0.001, style.speed),
    });
  }

  /** Drops particles whose link left the graph (purged or hidden by a collapse). */
  retain(live: ReadonlySet<VizLink>): void {
    this.list = this.list.filter((p) => live.has(p.link));
  }

  clear(): void {
    this.list = [];
  }

  get size(): number {
    return this.list.length;
  }

  /** Calls `draw` for every particle still travelling at `now`; arrived ones are removed. */
  step(now: number, draw: (x: number, y: number, p: Particle2D) => void): void {
    let kept = 0;
    for (const p of this.list) {
      const t = (now - p.start) / p.duration;
      if (t >= 1) continue;
      this.list[kept++] = p;
      const s = endpoint(p.link.source);
      const e = endpoint(p.link.target);
      // Endpoints not bound by the layout yet: keep the particle, draw nothing this frame.
      if (!s || !e) continue;
      const k = Math.max(0, t);
      const sx = s.x ?? 0;
      const sy = s.y ?? 0;
      draw(sx + ((e.x ?? 0) - sx) * k, sy + ((e.y ?? 0) - sy) * k, p);
    }
    this.list.length = kept;
  }
}
