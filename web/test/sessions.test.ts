import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { GlowBook, newSample } from '../src/glow.ts';
import {
  ACTIVE_WINDOW_MS,
  EXTERNAL_SESSION,
  SESSION_PALETTE,
  SessionPalette,
  activeSessions,
  endOpenSessions,
  isMultiSession,
  sessionRing,
} from '../src/sessions.ts';

describe('SessionPalette', () => {
  it('gives hues in order of first appearance and keeps them', () => {
    const p = new SessionPalette();
    expect(p.assign('b')).toBe(SESSION_PALETTE[0]);
    expect(p.assign('a')).toBe(SESSION_PALETTE[1]);
    expect(p.assign('b')).toBe(SESSION_PALETTE[0]);
    expect(p.peek('a')).toBe(SESSION_PALETTE[1]);
    expect(p.peek('c')).toBeUndefined();
    expect(p.toRecord()).toEqual({ b: SESSION_PALETTE[0], a: SESSION_PALETTE[1] });
    expect(p.ids()).toEqual(['b', 'a']);
  });

  it('never colors the external pseudo-session', () => {
    const p = new SessionPalette();
    expect(p.assign(EXTERNAL_SESSION)).toBeUndefined();
    expect(p.assign('')).toBeUndefined();
    expect(p.assign('s1')).toBe(SESSION_PALETTE[0]);
  });

  it('assigns a session list by firstSeen, whatever its order', () => {
    const p = new SessionPalette();
    p.assignAll([
      { sessionId: 'late', firstSeen: 300 },
      { sessionId: 'early', firstSeen: 100 },
      { sessionId: 'mid', firstSeen: 200 },
    ]);
    expect(p.ids()).toEqual(['early', 'mid', 'late']);
    // Stable after a reset with the same input (reload, replay restart).
    const again = new SessionPalette();
    again.assignAll([
      { sessionId: 'mid', firstSeen: 200 },
      { sessionId: 'late', firstSeen: 300 },
      { sessionId: 'early', firstSeen: 100 },
    ]);
    expect(again.toRecord()).toEqual(p.toRecord());
  });

  it('wraps around after the palette and clears', () => {
    const p = new SessionPalette();
    for (let i = 0; i < SESSION_PALETTE.length; i++) p.assign(`s${i}`);
    expect(p.assign('extra')).toBe(SESSION_PALETTE[0]);
    p.clear();
    expect(p.ids()).toEqual([]);
    expect(p.assign('extra')).toBe(SESSION_PALETTE[0]);
  });

  it('uses hues distinct from each other and from the subagent palette saturation', () => {
    expect(new Set(SESSION_PALETTE).size).toBe(SESSION_PALETTE.length);
    for (const hex of SESSION_PALETTE) {
      const hsl = { h: 0, s: 0, l: 0 };
      new Color(hex).getHSL(hsl);
      // Subagent hues are S 0.85 / L 0.62: session hues stay visibly calmer.
      expect(hsl.s).toBeLessThan(0.75);
    }
  });
});

describe('active sessions', () => {
  const now = 1_000_000_000;
  it('counts open sessions and sessions with recent events', () => {
    const list = [
      { sessionId: 'open-old', ended: false, lastSeen: now - 5 * ACTIVE_WINDOW_MS },
      { sessionId: 'ended-recent', ended: true, lastSeen: now - 60_000 },
      { sessionId: 'ended-old', ended: true, lastSeen: now - ACTIVE_WINDOW_MS - 1 },
      { sessionId: EXTERNAL_SESSION, ended: false, lastSeen: now },
    ];
    expect(activeSessions(list, now)).toEqual(['open-old', 'ended-recent']);
    expect(isMultiSession(list, now)).toBe(true);
  });

  it('needs two sessions for the tint', () => {
    expect(isMultiSession([{ sessionId: 'a', ended: false, lastSeen: now }], now)).toBe(false);
    expect(
      isMultiSession(
        [
          { sessionId: 'a', ended: false, lastSeen: now },
          { sessionId: 'b', ended: true, lastSeen: now - ACTIVE_WINDOW_MS - 1 },
        ],
        now,
      ),
    ).toBe(false);
    expect(isMultiSession([], now)).toBe(false);
  });

  // Regression: /clear ends the session and goes on in the same window with a new id.
  it('a session ended by /clear stops counting at once', () => {
    const list = [
      { sessionId: 'before-clear', ended: true, cleared: true, lastSeen: now - 1000 },
      { sessionId: 'after-clear', ended: false, lastSeen: now },
    ];
    expect(activeSessions(list, now)).toEqual(['after-clear']);
    expect(isMultiSession(list, now)).toBe(false);
  });

  // Regression: in replay, a session the previous server run never saw end stayed active.
  it('endOpenSessions ends what is still open and keeps lastSeen', () => {
    const list = [
      { sessionId: 'a', ended: false, lastSeen: now - 2 * ACTIVE_WINDOW_MS },
      { sessionId: 'b', ended: true, lastSeen: now - 5 },
      { sessionId: EXTERNAL_SESSION, ended: false, lastSeen: now },
    ];
    expect(endOpenSessions(list)).toBe(true);
    expect(list.map((s) => [s.sessionId, s.ended, s.lastSeen])).toEqual([
      ['a', true, now - 2 * ACTIVE_WINDOW_MS],
      ['b', true, now - 5],
      [EXTERNAL_SESSION, false, now],
    ]);
    expect(endOpenSessions(list)).toBe(false);
    // A, left open by the old run, plus C in the new one: no tint.
    expect(isMultiSession([list[0]!, { sessionId: 'c', ended: false, lastSeen: now }], now)).toBe(false);
  });
});

describe('sessionRing', () => {
  const hue = SESSION_PALETTE[0];
  it('rings main-agent events only with several sessions', () => {
    expect(sessionRing({ sessionId: 's1' }, hue, true)).toBe(hue);
    expect(sessionRing({ sessionId: 's1' }, hue, false)).toBeUndefined();
  });

  it('leaves subagent, external and unknown sessions alone', () => {
    expect(sessionRing({ sessionId: 's1', agentId: 'sub' }, hue, true)).toBeUndefined();
    expect(sessionRing({ sessionId: 's1', external: true }, hue, true)).toBeUndefined();
    expect(sessionRing({ sessionId: EXTERNAL_SESSION }, hue, true)).toBeUndefined();
    expect(sessionRing({ sessionId: 's1' }, undefined, true)).toBeUndefined();
  });
});

describe('GlowBook session ring', () => {
  it('samples a ring when there is no halo', () => {
    const book = new GlowBook();
    book.pulse('n', '#22d3ee', { intensity: 1, ring: '#e9a17a' }, 0);
    const s = newSample();
    book.sample('n', new Color(0, 0, 0), 1, 100, s);
    expect(s.ring?.getHexString()).toBe('e9a17a');
    expect(s.ringAlpha).toBeGreaterThan(0);
    expect(s.halo).toBeNull();
  });

  it('prefers the agent halo when both are given', () => {
    const book = new GlowBook();
    book.pulse('n', '#22d3ee', { intensity: 1, halo: '#38bdf8', ring: '#e9a17a' }, 0);
    const s = newSample();
    book.sample('n', new Color(0, 0, 0), 1, 100, s);
    expect(s.halo?.getHexString()).toBe('38bdf8');
    expect(s.ring).toBeNull();
  });

  it('a weaker ringed pulse keeps a stronger plain glow and adds its ring (the session stays readable)', () => {
    const book = new GlowBook();
    book.pulse('n', '#f59e0b', { intensity: 1 }, 0);
    book.pulse('n', '#22d3ee', { intensity: 0.3, ring: '#86c5b8' }, 10);
    const s = newSample();
    book.sample('n', new Color(0, 0, 0), 1, 20, s);
    expect(s.ring?.getHexString()).toBe('86c5b8');
    const plain = new GlowBook();
    plain.pulse('n', '#f59e0b', { intensity: 1 }, 0);
    const p = newSample();
    plain.sample('n', new Color(0, 0, 0), 1, 20, p);
    expect(s.color.getHexString()).toBe(p.color.getHexString());
  });

  // Regression: with several sessions, a weak main-agent pre erased a live subagent halo.
  it('a weaker ringed pulse never erases a subagent halo', () => {
    const book = new GlowBook();
    book.pulse('n', '#22d3ee', { intensity: 1, halo: '#38bdf8' }, 0);
    book.pulse('n', '#22d3ee', { intensity: 0.35, ring: '#e9a17a' }, 200);
    const s = newSample();
    book.sample('n', new Color(0, 0, 0), 1, 300, s);
    expect(s.halo?.getHexString()).toBe('38bdf8');
    expect(s.ring).toBeNull();
  });

  it('a weaker ringed pulse keeps the blinks of a fail flash', () => {
    const book = new GlowBook();
    book.pulse('n', '#ef4444', { intensity: 0.9, blinks: 3 }, 0);
    book.pulse('n', '#22d3ee', { intensity: 0.35, ring: '#e9a17a' }, 100);
    const plain = new GlowBook();
    plain.pulse('n', '#ef4444', { intensity: 0.9, blinks: 3 }, 0);
    for (const t of [170, 400]) {
      const s = newSample();
      const p = newSample();
      book.sample('n', new Color(0, 0, 0), 1, t, s);
      plain.sample('n', new Color(0, 0, 0), 1, t, p);
      expect(s.color.getHexString()).toBe(p.color.getHexString());
      expect(s.opacity).toBe(p.opacity);
    }
  });
});
