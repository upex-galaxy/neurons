import { describe, expect, it } from 'vitest';
import { ParticleTrack, type Particle2D } from '../src/particles2d.ts';
import type { VizLink, VizNode } from '../src/treeModel.ts';

function node(id: string, x: number): VizNode {
  return { id, kind: 'dir', depth: 0, name: id, parentId: null, x, y: 0 };
}

function link(from: VizNode, to: VizNode): VizLink {
  return { key: `${from.id}->${to.id}`, source: from, target: to };
}

function drawn(track: ParticleTrack, now: number): Array<{ x: number; p: Particle2D }> {
  const out: Array<{ x: number; p: Particle2D }> = [];
  track.step(now, (x, _y, p) => out.push({ x, p }));
  return out;
}

describe('ParticleTrack (2D particles)', () => {
  const root = node('', 0);
  const src = node('src', 100);
  const docs = node('docs', -100);

  it('keeps the style each particle was emitted with on a shared link', () => {
    const t = new ParticleTrack();
    const l = link(root, src);
    // PreToolUse (dim, thin) then PostToolUse (bright, wide, subagent halo) a few ms apart.
    t.add(l, { color: '#335566', width: 1.2, speed: 0.18 }, 0);
    t.add(l, { color: '#22d3ee', width: 2.5, speed: 0.18, halo: '#a78bfa' }, 10);
    const out = drawn(t, 40);
    expect(out).toHaveLength(2);
    expect(out[0]!.p).toMatchObject({ color: '#335566', width: 1.2 });
    expect(out[0]!.p.halo).toBeUndefined();
    expect(out[1]!.p).toMatchObject({ color: '#22d3ee', width: 2.5, halo: '#a78bfa' });
    // Each one travels on its own clock.
    expect(out[0]!.x).toBeGreaterThan(out[1]!.x);
  });

  it('keeps particles in flight across a structural update and drops those on removed links', () => {
    const t = new ParticleTrack();
    const a = link(root, src);
    const b = link(root, docs);
    t.add(a, { color: '#fff', width: 2, speed: 0.18 }, 0);
    t.add(b, { color: '#fff', width: 2, speed: 0.18 }, 0);
    // setData() with `a` still in the graph and `b` purged.
    t.retain(new Set([a]));
    expect(drawn(t, 30).map((d) => d.p.link)).toEqual([a]);
  });

  it('removes a particle once it reaches the end of its link', () => {
    const t = new ParticleTrack();
    t.add(link(root, src), { color: '#fff', width: 2, speed: 0.18 }, 0);
    expect(drawn(t, 50)).toHaveLength(1);
    expect(drawn(t, 1000 / 60 / 0.18 + 1)).toHaveLength(0);
    expect(t.size).toBe(0);
  });
});
