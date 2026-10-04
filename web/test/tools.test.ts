import { describe, expect, it } from 'vitest';
import type { VizEvent } from '../../src/shared/types.ts';
import type { Filters } from '../src/state.ts';
import { EventStore } from '../src/store.ts';
import { SEEN_CALLS_LIMIT, emptyTally, snapshotTally, sortedCounts, tallyEvent, toolOf } from '../src/tools.ts';

let n = 0;
function ev(partial: Partial<VizEvent>): VizEvent {
  return { id: `t${n++}`, ts: 1000 + n, sessionId: 's1', phase: 'post', action: 'tool', paths: [], source: 'hook', ...partial };
}

const all: Filters = { session: '', agent: '', showExternal: true };

describe('toolOf', () => {
  it('uses the server field when present', () => {
    expect(toolOf(ev({ tool: { kind: 'mcp', name: 'resolve-library-id', server: 'context7' } }))).toEqual({
      kind: 'mcp',
      name: 'resolve-library-id',
      server: 'context7',
    });
  });

  it('derives it from toolName for older logs', () => {
    expect(toolOf(ev({ toolName: 'mcp__context7__resolve-library-id' }))).toEqual({ kind: 'mcp', server: 'context7', name: 'resolve-library-id' });
    expect(toolOf(ev({ toolName: 'mcp__claude_ai_Slack__slack_send_message' }))).toEqual({
      kind: 'mcp',
      server: 'claude_ai_Slack',
      name: 'slack_send_message',
    });
    expect(toolOf(ev({ toolName: 'Skill', detail: 'humanizer' }))).toEqual({ kind: 'skill', name: 'humanizer' });
    expect(toolOf(ev({ toolName: 'Read' }))).toEqual({ kind: 'builtin', name: 'Read' });
    expect(toolOf(ev({ source: 'watcher' }))).toBeUndefined();
  });
});

describe('tallyEvent', () => {
  it('counts post and fail only, groups MCP by server and CLI programs once per command', () => {
    const tally = emptyTally();
    const skill = { tool: { kind: 'skill' as const, name: 'humanizer' }, action: 'skill' as const, toolUseId: 'u1' };
    tallyEvent(tally, ev({ ...skill, phase: 'pre' }));
    tallyEvent(tally, ev({ ...skill, phase: 'post' }));
    const mcp = { tool: { kind: 'mcp' as const, name: 'resolve-library-id', server: 'context7' }, action: 'mcp' as const };
    tallyEvent(tally, ev({ ...mcp, phase: 'pre' }));
    tallyEvent(tally, ev({ ...mcp, phase: 'post' }));
    tallyEvent(tally, ev({ ...mcp, phase: 'fail' }));
    tallyEvent(tally, ev({ tool: { kind: 'mcp', name: 'query-docs', server: 'context7' }, action: 'mcp' }));
    const bash = { tool: { kind: 'builtin' as const, name: 'Bash' }, action: 'bash' as const };
    tallyEvent(tally, ev({ ...bash, cli: ['git', 'npm', 'git'] }));
    tallyEvent(tally, ev({ ...bash, phase: 'fail', cli: ['git'] }));
    tallyEvent(tally, ev({ ...bash, phase: 'pre', cli: ['rm'] }));
    tallyEvent(tally, ev({ tool: { kind: 'builtin', name: 'Read' }, action: 'read', paths: ['a.ts'] }));
    tallyEvent(tally, ev({ action: 'turn_start', phase: 'info' }));
    expect(snapshotTally(tally)).toEqual({
      skills: { humanizer: 1 },
      mcp: { context7: { 'resolve-library-id': 2, 'query-docs': 1 } },
      cli: { git: 2, npm: 1 },
      builtin: { Bash: 2, Read: 1 },
    });
    expect(sortedCounts(tally.mcp.get('context7')!)).toEqual([
      ['resolve-library-id', 2],
      ['query-docs', 1],
    ]);
  });

  it('follows the panel filters through the store aggregate', () => {
    const s = new EventStore();
    s.add(ev({ tool: { kind: 'skill', name: 'humanizer' }, action: 'skill' }));
    s.add(ev({ tool: { kind: 'skill', name: 'pdf' }, action: 'skill', sessionId: 's2' }));
    s.add(ev({ tool: { kind: 'builtin', name: 'Bash' }, action: 'bash', cli: ['gh'], agentId: 'ag1' }));
    expect(snapshotTally(s.aggregate(all).tools).skills).toEqual({ humanizer: 1, pdf: 1 });
    expect(snapshotTally(s.aggregate({ ...all, session: 's2' }).tools).skills).toEqual({ pdf: 1 });
    expect(snapshotTally(s.aggregate({ ...all, agent: 'main' }).tools).cli).toEqual({});
    expect(snapshotTally(s.aggregate(all).tools).cli).toEqual({ gh: 1 });
  });
});

describe('EventStore lookups', () => {
  it('finds events by id, steps through the filtered list and lists a file history', () => {
    const s = new EventStore();
    const a = s.add(ev({ action: 'read', paths: ['src/a.ts'] })).item.id;
    const b = s.add(ev({ action: 'read', paths: ['src/b.ts'], sessionId: 's2' })).item.id;
    const c = s.add(ev({ action: 'search', paths: [], secondary: ['src/a.ts'] })).item.id;
    const d = s.add(ev({ action: 'move', paths: ['src/c.ts'], fromPaths: ['./src/a.ts'] })).item.id;
    expect(s.get(b)?.event.paths).toEqual(['src/b.ts']);
    expect(s.get('nope')).toBeUndefined();
    expect(s.neighbor(a, 1, all)).toBe(b);
    expect(s.neighbor(a, 1, { ...all, session: 's1' })).toBe(c);
    expect(s.neighbor(a, -1, all)).toBeUndefined();
    expect(s.neighbor(d, 1, all)).toBeUndefined();
    expect(s.forPath('src/a.ts', all, 10).map((r) => r.item.id)).toEqual([d, c, a]);
    expect(s.forPath('src/a.ts', all, 2).map((r) => r.item.id)).toEqual([d, c]);
  });
});

describe('one call, several events', () => {
  it('counts a call once when the server split it into several events', () => {
    const tally = emptyTally();
    const call = { tool: { kind: 'builtin' as const, name: 'Bash' }, action: 'edit' as const, toolUseId: 'b1', cli: ['npx'] };
    for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts']) tallyEvent(tally, ev({ ...call, paths: [p] }));
    // The same tool_use_id in another session is another call.
    tallyEvent(tally, ev({ ...call, sessionId: 's2', paths: ['src/a.ts'] }));
    expect(snapshotTally(tally)).toMatchObject({ cli: { npx: 2 }, builtin: { Bash: 2 } });
  });

  it('remembers a bounded number of calls', () => {
    const tally = emptyTally();
    for (let i = 0; i < SEEN_CALLS_LIMIT + 50; i++) tallyEvent(tally, ev({ tool: { kind: 'builtin', name: 'Read' }, action: 'read', toolUseId: `r${i}` }));
    expect(tally.seen.size).toBe(SEEN_CALLS_LIMIT);
    expect(tally.builtin.get('Read')).toBe(SEEN_CALLS_LIMIT + 50);
  });
});
