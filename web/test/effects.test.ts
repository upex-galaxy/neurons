import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeSnapshot, VizEvent } from '../../src/shared/types.ts';
import { eventTargets, playEvent, waitsForDelta, type EffectsContext } from '../src/effects.ts';
import type { PulseOptions } from '../src/glow.ts';
import type { Renderer } from '../src/renderer.ts';
import { TreeModel } from '../src/treeModel.ts';

const tree: TreeSnapshot = {
  root: '/tmp/demo',
  name: 'demo',
  truncated: false,
  entries: [
    { path: 'src', kind: 'dir' },
    { path: 'src/api', kind: 'dir' },
    { path: 'src/api/user.ts', kind: 'file' },
  ],
};

function event(over: Partial<VizEvent>): VizEvent {
  return { id: 'e1', ts: 0, sessionId: 's1', phase: 'post', action: 'read', paths: [], source: 'hook', ...over };
}

function fakeView(calls: string[], pulses: Array<{ id: string; opts: PulseOptions }> = []): Renderer {
  return {
    emitParticle: (l) => calls.push(`particle:${l.key}`),
    pulse: (id, _color, opts) => {
      calls.push(`pulse:${id}`);
      pulses.push({ id, opts });
    },
    flashLink: (l) => calls.push(`flash:${l.key}`),
  } as Partial<Renderer> as Renderer;
}

describe('waitsForDelta', () => {
  const model = new TreeModel();
  model.load(tree);

  it('holds a create whose file is only in the buffered tree delta', () => {
    const e = event({ action: 'create', paths: ['src/api/health.ts'] });
    expect(waitsForDelta(e, model, [{ path: 'src/api/health.ts', kind: 'file' }])).toBe(true);
  });

  it('holds a move until its destination lands', () => {
    const e = event({ action: 'move', paths: ['src/api/users.ts'], fromPaths: ['src/api/user.ts'] });
    expect(waitsForDelta(e, model, [{ path: './src/api/users.ts', kind: 'file' }])).toBe(true);
  });

  it('plays at once when the targets exist or no delta will add them', () => {
    expect(waitsForDelta(event({ paths: ['src/api/user.ts'] }), model, [{ path: 'x.ts', kind: 'file' }])).toBe(false);
    expect(waitsForDelta(event({ paths: ['src/api/ghost.ts'] }), model, [])).toBe(false);
    expect(waitsForDelta(event({ paths: ['src/api/ghost.ts'] }), model, [{ path: 'other.ts', kind: 'file' }])).toBe(false);
  });
});

describe('worktree events (paths rewritten from .claude/worktrees/<name>/)', () => {
  const model = new TreeModel();
  model.load(tree);

  it('never wait for a tree delta: the server does not add their paths', () => {
    const e = event({ action: 'create', paths: ['src/api/health.ts'], worktree: 'agent-x' });
    expect(waitsForDelta(e, model, [{ path: 'src/api/health.ts', kind: 'file' }])).toBe(false);
  });

  it('reveal the deepest existing node when the path is not in the main tree', () => {
    expect(model.existing('src/api/v2/only-here.ts')).toBe('src/api');
    expect(model.existing('src/api/user.ts')).toBe('src/api/user.ts');
    expect(model.existing('nope/x.ts')).toBe('');
    const e = event({ action: 'create', paths: ['src/api/v2/only-here.ts', 'src/api/v2/other.ts'], worktree: 'agent-x' });
    expect(eventTargets(e, model)).toEqual(['src/api']);
    // Without the worktree mark the path is kept as is (a create waiting for its delta).
    expect(eventTargets({ ...e, worktree: undefined } as VizEvent, model)).toEqual(['src/api/v2/only-here.ts', 'src/api/v2/other.ts']);
  });
});

describe('playEvent timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(ring?: string): {
    ctx: EffectsContext;
    calls: string[];
    pulses: Array<{ id: string; opts: PulseOptions }>;
    bump: () => void;
  } {
    const model = new TreeModel();
    model.load(tree);
    const calls: string[] = [];
    const pulses: Array<{ id: string; opts: PulseOptions }> = [];
    let gen = 0;
    const view = fakeView(calls, pulses);
    const ctx: EffectsContext = {
      model,
      view: () => view,
      agentColor: () => '#a78bfa',
      sessionRing: () => ring,
      onFirstEmit: () => {},
      generation: () => gen,
    };
    return { ctx, calls, pulses, bump: () => gen++ };
  }

  it('puts the session ring on the target of a main-agent event', () => {
    const { ctx, pulses } = setup('#e9a17a');
    playEvent(ctx, event({ paths: ['src/api/user.ts'] }));
    vi.advanceTimersByTime(2000);
    const target = pulses.find((p) => p.id === 'src/api/user.ts');
    expect(target?.opts.ring).toBe('#e9a17a');
    expect(target?.opts.halo).toBeUndefined();
    // Pass-through traces on the dirs stay plain.
    expect(pulses.filter((p) => p.id === 'src/api').every((p) => !p.opts.ring)).toBe(true);
  });

  it('keeps the agent halo (and no ring) on subagent events', () => {
    const { ctx, pulses } = setup('#e9a17a');
    playEvent(ctx, event({ paths: ['src/api/user.ts'], agentId: 'sub-1' }));
    vi.advanceTimersByTime(2000);
    const target = pulses.find((p) => p.id === 'src/api/user.ts');
    expect(target?.opts.halo).toBe('#a78bfa');
    expect(target?.opts.ring).toBeUndefined();
  });

  it('draws no ring when the context gives none (single session)', () => {
    const { ctx, pulses } = setup(undefined);
    playEvent(ctx, event({ action: 'turn_start' }));
    vi.advanceTimersByTime(2000);
    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses.every((p) => !p.opts.ring && !p.opts.halo)).toBe(true);
  });

  it('lights the chain hop by hop and pulses the target', () => {
    const { ctx, calls } = setup();
    playEvent(ctx, event({ paths: ['src/api/user.ts'], secondary: ['src/api'] }));
    vi.advanceTimersByTime(2000);
    expect(calls).toContain('particle:src/api->src/api/user.ts');
    expect(calls).toContain('pulse:src/api/user.ts');
  });

  it('a worktree event lights the equivalent main-repo node when it exists', () => {
    const { ctx, calls } = setup();
    playEvent(ctx, event({ action: 'edit', paths: ['src/api/user.ts'], worktree: 'agent-x', agentId: 'sub-1' }));
    vi.advanceTimersByTime(2000);
    expect(calls).toContain('particle:src/api->src/api/user.ts');
    expect(calls).toContain('pulse:src/api/user.ts');
  });

  it('a worktree event on a file only the worktree has lights its deepest existing ancestor', () => {
    const { ctx, calls } = setup();
    playEvent(ctx, event({ action: 'create', paths: ['src/api/v2/only-here.ts'], worktree: 'agent-x' }));
    vi.advanceTimersByTime(2000);
    expect(calls).toContain('particle:src->src/api');
    expect(calls).toContain('pulse:src/api');
    expect(calls.some((c) => c.includes('only-here'))).toBe(false);
  });

  it('drops pending hops, pulses and flashes after a reset (replay seek, reconnect)', () => {
    const { ctx, calls, bump } = setup();
    playEvent(ctx, event({ paths: ['src/api/user.ts'], secondary: ['src/api'] }));
    playEvent(ctx, event({ action: 'move', paths: ['src/api/moved.ts'], fromPaths: ['src/api/user.ts'] }));
    const before = calls.length;
    bump();
    vi.advanceTimersByTime(2000);
    expect(calls.length).toBe(before);
  });
});
