import { describe, expect, it } from 'vitest';
import { ACTION_COLORS, FAIL_COLOR, type VizEvent } from '../../src/shared/types.ts';
import {
  GAP_SHOWN_MS,
  GAP_THRESHOLD_MS,
  OUTSIDE_GROUP,
  TOOLS_GROUP,
  TimeAxis,
  TimelineModel,
  ellipsizeMiddle,
  itemAt,
  layoutRows,
  markStyle,
  markTargets,
} from '../src/timelineModel.ts';

let n = 0;
function ev(partial: Partial<VizEvent>): VizEvent {
  n++;
  return { id: `e${n}`, ts: 1000 + n, sessionId: 's1', phase: 'post', action: 'read', paths: [], source: 'hook', ...partial };
}

const T0 = 1_700_000_000_000;

describe('markStyle', () => {
  it('maps each action to its shape and color, hollow before running', () => {
    expect(markStyle({ action: 'read', phase: 'post' })).toEqual({ shape: 'dot', color: ACTION_COLORS.read, filled: true });
    expect(markStyle({ action: 'read', phase: 'pre' })).toEqual({ shape: 'dot', color: ACTION_COLORS.read, filled: false });
    expect(markStyle({ action: 'edit', phase: 'post' }).shape).toBe('bar');
    expect(markStyle({ action: 'create', phase: 'post' }).shape).toBe('plus');
    expect(markStyle({ action: 'delete', phase: 'post' }).shape).toBe('cross');
    expect(markStyle({ action: 'move', phase: 'post' }).shape).toBe('arrow');
    expect(markStyle({ action: 'search', phase: 'post' }).shape).toBe('ring');
    expect(markStyle({ action: 'context_load', phase: 'info' })).toEqual({ shape: 'diamond', color: ACTION_COLORS.context_load, filled: true });
    expect(markStyle({ action: 'skill', phase: 'post' }).color).toBe('#fb923c');
    expect(markStyle({ action: 'mcp', phase: 'post' }).color).toBe('#2dd4bf');
  });

  it('paints a failure gray in the shape of its action', () => {
    expect(markStyle({ action: 'bash', phase: 'fail' })).toEqual({ shape: 'tick', color: FAIL_COLOR, filled: true });
    expect(markStyle({ action: 'edit', phase: 'fail' })).toEqual({ shape: 'bar', color: FAIL_COLOR, filled: true });
  });
});

describe('markTargets', () => {
  it('marks repo paths, a move source and outside paths, never search hits', () => {
    const move = markTargets(ev({ action: 'move', paths: ['docs/notes.md'], fromPaths: ['docs/old.md'] }));
    expect(move.map((t) => t.key)).toEqual(['f:docs/notes.md', 'f:docs/old.md']);
    expect(move[0]).toMatchObject({ group: 'docs', kind: 'file' });

    const search = markTargets(ev({ action: 'search', paths: [''], secondary: ['src/a.ts', 'src/b.ts'] }));
    expect(search).toEqual([{ key: 'f:', path: '', kind: 'dir', group: '' }]);

    const outside = markTargets(ev({ action: 'context_load', phase: 'info', outsideRepo: ['/home/u/.claude/CLAUDE.md'] }));
    expect(outside).toEqual([{ key: 'o:/home/u/.claude/CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', kind: 'outside', group: OUTSIDE_GROUP }]);
  });

  it('gives skills and MCP calls without paths their own row', () => {
    expect(markTargets(ev({ action: 'skill', tool: { kind: 'skill', name: 'humanizer' }, detail: 'humanizer' }))).toEqual([
      { key: 's:humanizer', path: 'humanizer', kind: 'skill', group: TOOLS_GROUP },
    ]);
    expect(markTargets(ev({ action: 'mcp', detail: 'context7/resolve-library-id' }))[0]).toMatchObject({ key: 'm:context7/resolve-library-id', group: TOOLS_GROUP });
    // An MCP call that names a repo file marks the file.
    expect(markTargets(ev({ action: 'mcp', paths: ['src/a.ts'], detail: 'fs/read' }))[0]?.key).toBe('f:src/a.ts');
  });

  it('asks the tree whether a path is a dir', () => {
    const kindOf = (p: string) => (p === 'src' ? 'dir' : 'file') as 'dir' | 'file';
    expect(markTargets(ev({ action: 'read', paths: ['src'] }), kindOf)[0]?.kind).toBe('dir');
  });

  it('ignores actions that do not touch anything', () => {
    for (const action of ['turn_start', 'subagent_start', 'tool', 'batch_end', 'session_start'] as const) {
      expect(markTargets(ev({ action, phase: 'info', paths: [''] }))).toEqual([]);
    }
  });
});

describe('TimelineModel rows', () => {
  it('orders rows by first touch and groups them under folders in first-touch order', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, action: 'read', paths: ['src/api/user.ts'] }));
    m.add(ev({ ts: T0 + 100, action: 'read', paths: ['README.md'] }));
    m.add(ev({ ts: T0 + 200, action: 'edit', paths: ['src/api/order.ts'] }));
    m.add(ev({ ts: T0 + 300, action: 'read', paths: ['src/api/user.ts'] }));
    expect(m.groups.map((g) => g.key)).toEqual(['src/api', '']);
    expect(m.orderedRows().map((r) => r.path)).toEqual(['src/api/user.ts', 'src/api/order.ts', 'README.md']);
    expect(m.rows.get('f:src/api/user.ts')?.marks).toHaveLength(2);
    expect(m.counts).toMatchObject({ rows: 3, marks: 4, groups: 2 });
  });

  it('bumps the layout version only for structural changes', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: ['a.ts'] }));
    const v = m.version;
    m.add(ev({ ts: T0 + 10, paths: ['a.ts'] }));
    expect(m.version).toBe(v);
    m.add(ev({ ts: T0 + 20, paths: ['a.ts'], agentId: 'ag1' }));
    expect(m.version).toBeGreaterThan(v);
    expect(m.rows.get('f:a.ts')?.hasSub).toBe(true);
  });

  it('keeps marks sorted when an event arrives late and joins Pre with Post', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0 + 500, paths: ['a.ts'], phase: 'pre', toolUseId: 'tu1' }));
    m.add(ev({ ts: T0 + 900, paths: ['a.ts'], phase: 'post', toolUseId: 'tu1' }));
    m.add(ev({ ts: T0 + 100, paths: ['a.ts'] }));
    const marks = m.rows.get('f:a.ts')!.marks;
    expect(marks.map((k) => k.ts)).toEqual([T0 + 100, T0 + 500, T0 + 900]);
    expect(marks[2]).toMatchObject({ startTs: T0 + 500, filled: true });
    expect(marks[1]).toMatchObject({ filled: false });
    expect(m.rows.get('f:a.ts')!.firstTs).toBe(T0 + 100);
  });

  it('joins a Post only with the Pre on its own row, for every event of a split Post', () => {
    // `prettier --write src`: the Pre is a bash mark on the root row, the Post becomes one
    // edit event per changed file, all with the same toolUseId.
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: [''], action: 'bash', phase: 'pre', toolUseId: 'tu9' }));
    for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      m.add(ev({ ts: T0 + 1200, paths: [p], action: 'edit', phase: 'post', toolUseId: 'tu9' }));
    }
    for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      expect(m.rows.get(`f:${p}`)!.marks[0]!.startTs).toBeUndefined();
    }
  });

  it('gives every Post event on the Pre row its start, not just the first one', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: ['old.ts', 'new.ts'], action: 'move', phase: 'pre', toolUseId: 'tu8' }));
    m.add(ev({ ts: T0 + 300, paths: ['old.ts'], action: 'delete', phase: 'post', toolUseId: 'tu8' }));
    m.add(ev({ ts: T0 + 300, paths: ['new.ts'], action: 'create', phase: 'post', toolUseId: 'tu8' }));
    m.add(ev({ ts: T0 + 400, paths: ['other.ts'], action: 'edit', phase: 'post', toolUseId: 'tu8' }));
    expect(m.rows.get('f:old.ts')!.marks[1]).toMatchObject({ phase: 'post', startTs: T0 });
    expect(m.rows.get('f:new.ts')!.marks[1]).toMatchObject({ phase: 'post', startTs: T0 });
    expect(m.rows.get('f:other.ts')!.marks[0]!.startTs).toBeUndefined();
  });

  it('records the sessions that touched a row; two of them turn the stripe on', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: ['a.ts'], sessionId: 's1' }));
    m.add(ev({ ts: T0 + 1, paths: ['a.ts'], sessionId: 'external', external: true, source: 'watcher' }));
    expect(m.multiSession).toBe(false);
    m.add(ev({ ts: T0 + 2, paths: ['a.ts'], sessionId: 's2' }));
    expect(m.rows.get('f:a.ts')?.sessions).toEqual(['s1', 's2']);
    expect(m.multiSession).toBe(true);
  });

  it('turns: UserPromptSubmit to Stop, numbered; an unfinished one stays open', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, action: 'turn_start', phase: 'info', detail: 'fix the bug' }));
    m.add(ev({ ts: T0 + 50, paths: ['a.ts'] }));
    m.add(ev({ ts: T0 + 100, action: 'turn_end', phase: 'info' }));
    m.add(ev({ ts: T0 + 200, action: 'turn_start', phase: 'info' }));
    expect(m.turns).toMatchObject([
      { index: 1, startTs: T0, endTs: T0 + 100, detail: 'fix the bug', fail: false },
      { index: 2, startTs: T0 + 200, endTs: null },
    ]);
    m.add(ev({ ts: T0 + 300, action: 'turn_end', phase: 'fail' }));
    expect(m.turns[1]).toMatchObject({ endTs: T0 + 300, fail: true });
  });

  it('turns of two sessions that overlap take separate lanes', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, action: 'turn_start', phase: 'info', sessionId: 'a' }));
    m.add(ev({ ts: T0 + 10, action: 'turn_start', phase: 'info', sessionId: 'b' }));
    m.add(ev({ ts: T0 + 20, action: 'turn_end', phase: 'info', sessionId: 'a' }));
    m.add(ev({ ts: T0 + 30, action: 'turn_start', phase: 'info', sessionId: 'a' }));
    expect(m.turns.map((tu) => [tu.sessionId, tu.lane])).toEqual([
      ['a', 0],
      ['b', 1],
      ['a', 0],
    ]);
    expect(m.turnLanes).toBe(2);
  });

  it('subagents: one span each, parallel ones in separate lanes, a free lane is reused', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, action: 'subagent_start', phase: 'info', agentId: 'a', agentType: 'Explore' }));
    m.add(ev({ ts: T0 + 10, action: 'subagent_start', phase: 'info', agentId: 'b' }));
    m.add(ev({ ts: T0 + 20, paths: ['x.ts'], agentId: 'b' }));
    m.add(ev({ ts: T0 + 30, action: 'subagent_stop', phase: 'info', agentId: 'a' }));
    m.add(ev({ ts: T0 + 40, action: 'subagent_start', phase: 'info', agentId: 'c' }));
    expect(m.agents.map((a) => [a.agentId, a.lane, a.endTs])).toEqual([
      ['a', 0, T0 + 30],
      ['b', 1, null],
      ['c', 0, null],
    ]);
    expect(m.agentLanes).toBe(2);
    expect(m.agents[0]?.agentType).toBe('Explore');
  });

  it('a subagent whose start was not seen gets a span from its first event', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: ['x.ts'], agentId: 'z', agentType: 'Plan' }));
    expect(m.agents).toMatchObject([{ agentId: 'z', agentType: 'Plan', startTs: T0, endTs: null }]);
  });

  it('clear() empties everything', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: ['a.ts'] }));
    m.clear();
    expect(m.isEmpty).toBe(true);
    expect(m.counts).toEqual({ rows: 0, marks: 0, groups: 0, turns: 0, agents: 0 });
    expect(m.axis.empty).toBe(true);
  });
});

describe('TimeAxis gap compression', () => {
  it('keeps short gaps 1:1 and shortens long pauses to GAP_SHOWN_MS', () => {
    const a = new TimeAxis();
    a.add(T0);
    a.add(T0 + 4_000);
    a.add(T0 + 4_000 + 60_000);
    a.add(T0 + 4_000 + 60_000 + 1_000);
    expect(a.breaks).toHaveLength(1);
    expect(a.toCt(T0 + 4_000)).toBe(4_000);
    expect(a.toCt(T0 + 64_000)).toBe(4_000 + GAP_SHOWN_MS);
    expect(a.toCt(T0 + 65_000)).toBe(4_000 + GAP_SHOWN_MS + 1_000);
    // Inside the pause it interpolates.
    expect(a.toCt(T0 + 34_000)).toBeCloseTo(4_000 + GAP_SHOWN_MS / 2);
  });

  it('a gap of exactly the threshold is not shortened', () => {
    const a = new TimeAxis();
    a.add(T0);
    a.add(T0 + GAP_THRESHOLD_MS);
    expect(a.breaks).toHaveLength(0);
    expect(a.toCt(T0 + GAP_THRESHOLD_MS)).toBe(GAP_THRESHOLD_MS);
  });

  it('toTs inverts toCt, also across a pause', () => {
    const a = new TimeAxis();
    for (const ts of [T0, T0 + 2_000, T0 + 302_000, T0 + 303_000]) a.add(ts);
    for (const ts of [T0, T0 + 1_500, T0 + 100_000, T0 + 302_500, T0 + 400_000]) {
      expect(a.toTs(a.toCt(ts))).toBeCloseTo(ts, 3);
    }
  });

  it('the live cursor follows the clock up to the threshold, then waits', () => {
    const a = new TimeAxis();
    a.add(T0);
    expect(a.nowCt(T0 + 3_000)).toBe(3_000);
    expect(a.nowCt(T0 + 600_000)).toBe(GAP_THRESHOLD_MS);
    expect(a.nowCt(T0 - 50)).toBe(0);
  });

  it('a late event inside a pause rebuilds the axis and reports the shift', () => {
    const a = new TimeAxis();
    a.add(T0);
    a.add(T0 + 60_000);
    expect(a.breaks).toHaveLength(1);
    expect(a.add(T0 + 30_000)).toBe(true);
    expect(a.breaks).toHaveLength(2);
    expect(a.toCt(T0 + 30_000)).toBe(GAP_SHOWN_MS);
    expect(a.toCt(T0 + 60_000)).toBe(GAP_SHOWN_MS * 2);
    // A late event that falls in a 1:1 stretch changes nothing.
    expect(a.add(T0 + 59_000)).toBe(true);
    const b = new TimeAxis();
    b.add(T0);
    b.add(T0 + 5_000);
    expect(b.add(T0 + 2_000)).toBe(false);
  });

  it('breakAtCt and breakContaining find the pause', () => {
    const a = new TimeAxis();
    a.add(T0);
    a.add(T0 + 1_000);
    a.add(T0 + 100_000);
    expect(a.breakAtCt(1_000 + GAP_SHOWN_MS / 2)?.fromTs).toBe(T0 + 1_000);
    expect(a.breakAtCt(500)).toBeUndefined();
    expect(a.breakContaining(T0 + 50_000)?.toTs).toBe(T0 + 100_000);
    expect(a.breakContaining(T0 + 100_000)).toBeUndefined();
  });
});

describe('layout', () => {
  it('stacks a header per group and taller rows when they have a sub-lane', () => {
    const m = new TimelineModel();
    m.add(ev({ ts: T0, paths: ['src/a.ts'] }));
    m.add(ev({ ts: T0 + 1, paths: ['src/b.ts'], agentId: 'ag' }));
    m.add(ev({ ts: T0 + 2, paths: ['docs/c.md'] }));
    const { items, height } = layoutRows(m.groups, { groupH: 20, rowH: 18, subH: 8 });
    expect(items.map((i) => [i.type, i.row?.path ?? i.group.key, i.y, i.h])).toEqual([
      ['group', 'src', 0, 20],
      ['row', 'src/a.ts', 20, 18],
      ['row', 'src/b.ts', 38, 26],
      ['group', 'docs', 64, 20],
      ['row', 'docs/c.md', 84, 18],
    ]);
    expect(height).toBe(102);
    expect(itemAt(items, 0)).toBe(0);
    expect(itemAt(items, 63)).toBe(2);
    expect(itemAt(items, 101)).toBe(4);
    expect(itemAt(items, 102)).toBe(-1);
  });
});

describe('ellipsizeMiddle', () => {
  const len = (s: string) => s.length;
  it('keeps text that fits and cuts the middle of text that does not', () => {
    expect(ellipsizeMiddle('src/api/user.ts', 20, len)).toBe('src/api/user.ts');
    const cut = ellipsizeMiddle('packages/server/src/api/user.ts', 15, len);
    expect(cut).toHaveLength(15);
    expect(cut.startsWith('package')).toBe(true);
    expect(cut.endsWith('user.ts')).toBe(true);
    expect(cut).toContain('…');
    expect(ellipsizeMiddle('abcdef', 0, len)).toBe('…');
  });
});

describe('TimelineModel Pre/Post join', () => {
  const postMark = (m: TimelineModel, path: string, id: string) =>
    m.orderedRows().find((r) => r.key.endsWith(path))?.marks.find((k) => k.id === id);

  it('keeps an open call joined while thousands of other calls start and finish', () => {
    const m = new TimelineModel();
    m.add(ev({ id: 'pre-a', ts: T0, toolUseId: 'call-a', phase: 'pre', action: 'bash', paths: ['a.ts'] }));
    for (let i = 0; i < 2500; i++) {
      m.add(ev({ ts: T0 + 1 + i, toolUseId: `other-${i}`, phase: 'pre', action: 'read', paths: [`f${i}.ts`] }));
      m.add(ev({ ts: T0 + 2 + i, toolUseId: `other-${i}`, phase: 'post', action: 'read', paths: [`f${i}.ts`] }));
    }
    m.add(ev({ id: 'post-a', ts: T0 + 9000, toolUseId: 'call-a', phase: 'post', action: 'bash', paths: ['a.ts'] }));
    expect(postMark(m, 'a.ts', 'post-a')?.startTs).toBe(T0);
  });

  it('joins every row of one call that touches more rows than the cap', () => {
    const m = new TimelineModel();
    const paths = Array.from({ length: 2500 }, (_, i) => `big/f${i}.ts`);
    m.add(ev({ id: 'pre-big', ts: T0, toolUseId: 'call-big', phase: 'pre', action: 'read', paths }));
    m.add(ev({ id: 'post-big', ts: T0 + 10, toolUseId: 'call-big', phase: 'post', action: 'read', paths }));
    const joined = m.orderedRows().filter((r) => r.marks.some((k) => k.id === 'post-big' && k.startTs === T0));
    expect(joined).toHaveLength(2500);
  });

  it('joins a Post only on the row its Pre marked', () => {
    const m = new TimelineModel();
    m.add(ev({ id: 'pre-x', ts: T0, toolUseId: 'call-x', phase: 'pre', action: 'read', paths: ['x.ts'] }));
    m.add(ev({ id: 'post-y', ts: T0 + 5, toolUseId: 'call-x', phase: 'post', action: 'read', paths: ['y.ts'] }));
    expect(postMark(m, 'y.ts', 'post-y')?.startTs).toBeUndefined();
  });
});
