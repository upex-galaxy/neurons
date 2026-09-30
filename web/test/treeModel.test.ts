import { describe, expect, it } from 'vitest';
import type { TreeSnapshot } from '../../src/shared/types.ts';
import { ROOT_ID, TreeModel, depthOf, linkKey, normalizePath, parentPath } from '../src/treeModel.ts';

const tree: TreeSnapshot = {
  root: '/tmp/demo',
  name: 'demo',
  truncated: false,
  entries: [
    { path: 'docs', kind: 'dir' },
    { path: 'docs/a.md', kind: 'file' },
    { path: 'src', kind: 'dir' },
    { path: 'src/api', kind: 'dir' },
    { path: 'src/api/user.ts', kind: 'file' },
    { path: 'src/index.ts', kind: 'file' },
  ],
};

function load(): TreeModel {
  const m = new TreeModel();
  m.load(tree);
  return m;
}

describe('path helpers', () => {
  it('normalizes and splits paths', () => {
    expect(normalizePath('./src/api/')).toBe('src/api');
    expect(normalizePath('.')).toBe('');
    expect(parentPath('src/api/user.ts')).toBe('src/api');
    expect(parentPath('src')).toBe(ROOT_ID);
    expect(depthOf('')).toBe(0);
    expect(depthOf('src/api/user.ts')).toBe(3);
  });
});

describe('TreeModel', () => {
  it('builds nodes and parent->child links from a snapshot', () => {
    const m = load();
    expect(m.nodeCount).toBe(7);
    expect(m.linkCount).toBe(6);
    const root = m.get(ROOT_ID)!;
    expect(root.name).toBe('demo');
    expect(root.kind).toBe('dir');
    expect(m.get('src/api/user.ts')).toMatchObject({ kind: 'file', depth: 3, name: 'user.ts', parentId: 'src/api' });
    expect(m.link('src', 'src/api')?.key).toBe(linkKey('src', 'src/api'));
    expect(m.link('', 'src')).toBeDefined();
  });

  it('creates missing ancestors for entries', () => {
    const m = new TreeModel();
    m.load({ ...tree, entries: [{ path: 'a/b/c.ts', kind: 'file' }] });
    expect(m.get('a')?.kind).toBe('dir');
    expect(m.get('a/b')?.kind).toBe('dir');
    expect(m.link('a/b', 'a/b/c.ts')).toBeDefined();
  });

  it('chains from the root to the deepest existing ancestor', () => {
    const m = load();
    expect(m.chain('src/api/user.ts')).toEqual(['', 'src', 'src/api', 'src/api/user.ts']);
    expect(m.chain('src/api/missing.ts')).toEqual(['', 'src', 'src/api']);
    expect(m.chain('')).toEqual(['']);
    expect(m.chain('nope/x')).toEqual(['']);
  });

  it('adds immediately and removes in two phases', () => {
    const m = load();
    const r = m.applyDelta([{ path: 'src/new/x.ts', kind: 'file' }], ['src/api']);
    expect(r.added.map((n) => n.id)).toEqual(['src/new', 'src/new/x.ts']);
    expect(r.removing.sort()).toEqual(['src/api', 'src/api/user.ts']);
    expect(m.get('src/api')?.removing).toBe(true);
    // Still present until purged, so the view can fade it out.
    expect(m.nodeCount).toBe(9);
    const gone = m.purge(r.removing);
    expect(gone.sort()).toEqual(['src/api', 'src/api/user.ts']);
    expect(m.get('src/api')).toBeUndefined();
    expect(m.link('src', 'src/api')).toBeUndefined();
    expect(m.nodeCount).toBe(7);
    expect(m.linkCount).toBe(6);
  });

  it('keeps a node that is re-added while fading out', () => {
    const m = load();
    const r1 = m.applyDelta([], ['src/api']);
    const r2 = m.applyDelta([{ path: 'src/api/user.ts', kind: 'file' }], []);
    expect(r2.added).toEqual([]);
    expect(m.get('src/api/user.ts')?.removing).toBe(false);
    expect(m.get('src/api')?.removing).toBe(false);
    expect(m.purge(r1.removing)).toEqual([]);
    expect(m.get('src/api/user.ts')).toBeDefined();
  });

  it('reports nodes revived after their fade started in an earlier delta', () => {
    const m = load();
    const r1 = m.applyDelta([], ['src/api']);
    expect(r1.removing.sort()).toEqual(['src/api', 'src/api/user.ts']);
    // `rm -rf src/api && mkdir -p src/api && touch src/api/user.ts` in a later flush.
    const r2 = m.applyDelta(
      [
        { path: 'src/api', kind: 'dir' },
        { path: 'src/api/user.ts', kind: 'file' },
      ],
      [],
    );
    expect(r2.added).toEqual([]);
    expect(r2.removing).toEqual([]);
    // The view must cancel both fades, or the nodes end at scale 0 and stay invisible.
    expect(r2.revived.sort()).toEqual(['src/api', 'src/api/user.ts']);
    expect(m.purge(r1.removing)).toEqual([]);
  });

  it('does not report as revived a node removed and re-added in the same delta', () => {
    const m = load();
    const r = m.applyDelta([{ path: 'src/api/user.ts', kind: 'file' }], ['src/api']);
    expect(r.revived).toEqual([]);
    expect(r.removing).toEqual([]);
  });

  it('revives fading ancestors of a brand-new path', () => {
    const m = load();
    const r1 = m.applyDelta([], ['src/api']);
    const r2 = m.applyDelta([{ path: 'src/api/new.ts', kind: 'file' }], []);
    expect(r2.added.map((n) => n.id)).toEqual(['src/api/new.ts']);
    expect(r2.revived).toEqual(['src/api']);
    // Only the old child is purged; the dir keeps its new file.
    expect(m.purge(r1.removing)).toEqual(['src/api/user.ts']);
    expect(m.get('src/api/new.ts')?.parentId).toBe('src/api');
  });

  it('never removes the root', () => {
    const m = load();
    expect(m.applyDelta([], ['']).removing).toEqual([]);
  });

  it('re-indexes live links whose endpoints became node objects', () => {
    const m = load();
    const data = m.data();
    // Simulate force-graph replacing ids with node objects.
    for (const l of data.links) {
      l.source = m.get(l.source as string)!;
      l.target = m.get(l.target as string)!;
    }
    m.syncLive(data.links);
    const live = m.link('src', 'src/index.ts');
    expect(live).toBe(data.links.find((l) => l.key === 'src->src/index.ts'));
  });
});

describe('satellites', () => {
  it('groups outside paths by prefix', async () => {
    const { outsideGroup } = await import('../src/treeModel.ts');
    expect(outsideGroup('/Users/alex/.claude/skills/x/SKILL.md')).toBe('~/.claude');
    expect(outsideGroup('/home/u/.claude/CLAUDE.md')).toBe('~/.claude');
    expect(outsideGroup('/tmp/a/b.log')).toBe('/tmp');
    expect(outsideGroup('/private/tmp/c.json')).toBe('/tmp');
    expect(outsideGroup('/opt/homebrew/lib/x')).toBe('/opt/homebrew');
    expect(outsideGroup('/Users/alex/other-repo/src/a.ts')).toBe('/Users/alex');
  });

  it('creates hub -> group -> satellite and chains from the hub', async () => {
    const { OUTSIDE_HUB_ID, groupId } = await import('../src/treeModel.ts');
    const m = load();
    const r = m.addOutside('/tmp/x/out.log');
    expect(r.id).toBe('/tmp/x/out.log');
    expect(r.created.map((n) => n.id)).toEqual([OUTSIDE_HUB_ID, groupId('/tmp'), '/tmp/x/out.log']);
    expect(m.addOutside('/private/tmp/y').created.map((n) => n.id)).toEqual(['/private/tmp/y']);
    expect(m.chain('/tmp/x/out.log')).toEqual([OUTSIDE_HUB_ID, groupId('/tmp'), '/tmp/x/out.log']);
    expect(m.link(groupId('/tmp'), '/tmp/x/out.log')).toBeDefined();
    // Satellites are part of the graph data and never removed by tree deltas.
    expect(m.data().nodes.some((n) => n.id === OUTSIDE_HUB_ID)).toBe(true);
    expect(m.applyDelta([], ['/tmp/x/out.log']).removing).toEqual([]);
  });

  it('pins the hub and its children', async () => {
    const { OUTSIDE_HUB_ID, pinOutside } = await import('../src/treeModel.ts');
    const m = load();
    m.addOutside('/tmp/a');
    pinOutside(m, 200);
    expect(m.get(OUTSIDE_HUB_ID)).toMatchObject({ fx: -200, fy: 0, fz: 0 });
    expect(m.get('/tmp/a')?.fx).toBeTypeOf('number');
  });
});

function bigTree(dirs: number, filesPerDir: number): TreeSnapshot {
  const entries: TreeSnapshot['entries'] = [];
  for (let d = 0; d < dirs; d++) {
    entries.push({ path: `pkg${d}`, kind: 'dir' });
    entries.push({ path: `pkg${d}/src`, kind: 'dir' });
    for (let f = 0; f < filesPerDir; f++) entries.push({ path: `pkg${d}/src/f${f}.ts`, kind: 'file' });
  }
  return { root: '/tmp/big', name: 'big', truncated: false, entries };
}

describe('collapse', () => {
  it('collapses deepest dirs first until the budget holds', () => {
    const m = new TreeModel();
    m.load(bigTree(20, 99)); // 1 + 20 * (2 + 99) = 2021 nodes
    expect(m.visibleCount).toBe(2021);
    const done = m.collapseToBudget(1500);
    expect(done.length).toBeGreaterThan(0);
    expect(done.every((id) => id.endsWith('/src'))).toBe(true);
    expect(m.visibleCount).toBeLessThanOrEqual(1500);
    expect(m.data().nodes.length).toBe(m.visibleCount);
    // A collapsed dir hides its children from the chain.
    const hidden = done[0]!;
    expect(m.isVisible(`${hidden}/f0.ts`)).toBe(false);
    expect(m.chain(`${hidden}/f0.ts`)).toEqual(['', hidden.split('/')[0], hidden]);
    expect(m.visibleAncestor(`${hidden}/f0.ts`)).toBe(hidden);
  });

  it('reveals hidden paths and re-collapses least recently active dirs past 1.3x budget', () => {
    const m = new TreeModel();
    m.load(bigTree(20, 99));
    const done = m.collapseToBudget(1500);
    const now = 1_000_000;
    const target = `${done[0]}/f5.ts`;
    expect(m.reveal(target, now)).toEqual([done[0]]);
    m.touch(target, now);
    expect(m.isVisible(target)).toBe(true);
    // Open everything: well past 1.3x the budget.
    for (const id of done) m.expand(id);
    expect(m.visibleCount).toBe(2021);
    const re = m.recollapse(1000, now + 1000);
    expect(re).not.toContain(done[0]); // held for 30 s after the auto-expand
    expect(m.visibleCount).toBeLessThanOrEqual(1000);
    // After the hold, it can be collapsed again.
    const later = m.recollapse(10, now + 31_000);
    expect(m.visibleCount).toBeLessThanOrEqual(1000);
    expect(later.length).toBeGreaterThan(0);
  });

  it('does not collapse files, the root or satellites', () => {
    const m = load();
    m.addOutside('/tmp/a');
    expect(m.collapse('src/index.ts')).toBe(false);
    expect(m.collapse('')).toBe(false);
    expect(m.collapse('::outside/%2Ftmp')).toBe(false);
    expect(m.collapse('src/api')).toBe(true);
    expect(m.descendantCount('src/api')).toBe(1);
  });
});
