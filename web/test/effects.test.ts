import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeSnapshot, VizEvent } from '../../src/shared/types.ts';
import { playEvent, waitsForDelta, type EffectsContext } from '../src/effects.ts';
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

function fakeView(calls: string[]): Renderer {
  return {
    emitParticle: (l) => calls.push(`particle:${l.key}`),
    pulse: (id) => calls.push(`pulse:${id}`),
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

describe('playEvent timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(): { ctx: EffectsContext; calls: string[]; bump: () => void } {
    const model = new TreeModel();
    model.load(tree);
    const calls: string[] = [];
    let gen = 0;
    const view = fakeView(calls);
    const ctx: EffectsContext = {
      model,
      view: () => view,
      agentColor: () => '#a78bfa',
      onFirstEmit: () => {},
      generation: () => gen,
    };
    return { ctx, calls, bump: () => gen++ };
  }

  it('lights the chain hop by hop and pulses the target', () => {
    const { ctx, calls } = setup();
    playEvent(ctx, event({ paths: ['src/api/user.ts'], secondary: ['src/api'] }));
    vi.advanceTimersByTime(2000);
    expect(calls).toContain('particle:src/api->src/api/user.ts');
    expect(calls).toContain('pulse:src/api/user.ts');
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
