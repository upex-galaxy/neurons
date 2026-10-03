import { describe, expect, it } from 'vitest';
import type { VizEvent } from '../../src/shared/types.ts';
import type { Filters } from '../src/state.ts';
import { EventStore, MAIN_AGENT, feedItem, heatIntensity, passes, pathTag } from '../src/store.ts';

let n = 0;
function ev(partial: Partial<VizEvent>): VizEvent {
  return { id: `e${n++}`, ts: 1000 + n, sessionId: 's1', phase: 'post', action: 'read', paths: ['a.ts'], source: 'hook', ...partial };
}

const all: Filters = { session: '', agent: '', showExternal: true };

describe('filters', () => {
  it('filters by session, agent and external', () => {
    const main = ev({});
    const sub = ev({ agentId: 'ag1', agentType: 'Explore' });
    const ext = ev({ external: true, source: 'watcher' });
    const other = ev({ sessionId: 's2' });
    expect([main, sub, ext, other].map((e) => passes(e, all))).toEqual([true, true, true, true]);
    expect(passes(sub, { ...all, agent: MAIN_AGENT })).toBe(false);
    expect(passes(main, { ...all, agent: MAIN_AGENT })).toBe(true);
    expect(passes(sub, { ...all, agent: 'ag1' })).toBe(true);
    expect(passes(main, { ...all, agent: 'ag1' })).toBe(false);
    expect(passes(ext, { ...all, showExternal: false })).toBe(false);
    expect(passes(other, { ...all, session: 's1' })).toBe(false);
  });
});

describe('EventStore', () => {
  it('counts non-pre events and heats file paths per filter', () => {
    const s = new EventStore();
    s.add(ev({ phase: 'pre', paths: ['a.ts'] }));
    s.add(ev({ paths: ['a.ts'] }));
    s.add(ev({ paths: ['a.ts'], sessionId: 's2' }));
    s.add(ev({ action: 'edit', paths: ['b.ts'], phase: 'fail' }));
    s.add(ev({ action: 'turn_start', paths: [] }));
    s.add(ev({ action: 'context_load', paths: [], outsideRepo: ['/tmp/x'] }));
    const agg = s.aggregate(all);
    expect(agg.counters).toEqual({ read: 2, edit: 1, turn_start: 1, context_load: 1 });
    expect(agg.fails).toBe(1);
    expect(Object.fromEntries(agg.heat)).toEqual({ 'a.ts': 2, 'b.ts': 1, '/tmp/x': 1 });
    const only2 = s.aggregate({ ...all, session: 's2' });
    expect(Object.fromEntries(only2.heat)).toEqual({ 'a.ts': 1 });
    expect(s.visible({ ...all, session: 's2' }, 10).length).toBe(1);
    expect(s.visible(all, 3).map((i) => i.action)).toEqual(['edit', 'turn_start', 'context_load']);
  });

  it('maps heat to 0.15 + 0.6 * count / max', () => {
    const h = heatIntensity(new Map([['a', 4], ['b', 1], ['c', 0]]));
    expect(h.get('a')).toBeCloseTo(0.75);
    expect(h.get('b')).toBeCloseTo(0.3);
    expect(h.has('c')).toBe(false);
  });
});

describe('worktree feed tag', () => {
  it('carries the worktree into the feed item and tags its path', () => {
    const item = feedItem(ev({ action: 'edit', paths: ['web/src/main.ts'], worktree: 'agent-af7ec553e0c4e91b1', agentId: 'af7' }));
    expect(item).toMatchObject({ path: 'web/src/main.ts', worktree: 'agent-af7ec553e0c4e91b1' });
    const tag = pathTag(item);
    expect(tag?.text).toBe('worktree');
    expect(tag?.title).toContain('.claude/worktrees/agent-af7ec553e0c4e91b1/');
    expect(tag?.title).not.toMatch(/[\u2013\u2014]/);
  });

  it('no tag for a main-repo event', () => {
    const item = feedItem(ev({ paths: ['web/src/main.ts'] }));
    expect(item.worktree).toBeUndefined();
    expect(pathTag(item)).toBeUndefined();
  });
});
