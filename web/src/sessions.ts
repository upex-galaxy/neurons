// Per-session tint: one hue per main Claude session, so several sessions on the same repo
// can be told apart without filtering. Pure (no DOM, no three) so it can be unit tested.
import type { VizEvent } from '../../src/shared/types.ts';

/**
 * Muted editorial hues, in assignment order. They sit away from the vivid golden-angle
 * subagent hues (S 0.85, L 0.62) and the first two contrast strongly (warm vs cool).
 */
export const SESSION_PALETTE: readonly string[] = [
  '#e9a17a', // clay
  '#86c5b8', // sage
  '#b9a3e3', // lavender
  '#e6899b', // rose
  '#a9c47f', // olive
  '#8fb3e3', // periwinkle
  '#d9c27a', // straw
  '#c792b8', // mauve
];

/** Session id the server gives to changes nobody claimed (watcher). It gets no hue. */
export const EXTERNAL_SESSION = 'external';

/** A session that ended still counts while it had events in this window. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

export interface SessionActivity {
  sessionId: string;
  ended: boolean;
  lastSeen: number;
  /** Ended by /clear: the same window goes on as a new session, so it stops counting at once. */
  cleared?: boolean;
}

/** Hue per session in order of first appearance; wraps around after the palette. */
export class SessionPalette {
  private readonly colors = new Map<string, string>();

  /** Assigns on first sight. Undefined for the external pseudo-session. */
  assign(sessionId: string): string | undefined {
    if (!sessionId || sessionId === EXTERNAL_SESSION) return undefined;
    let c = this.colors.get(sessionId);
    if (!c) {
      c = SESSION_PALETTE[this.colors.size % SESSION_PALETTE.length]!;
      this.colors.set(sessionId, c);
    }
    return c;
  }

  /** Hue already assigned, without assigning one. */
  peek(sessionId: string): string | undefined {
    return this.colors.get(sessionId);
  }

  /** Assigns in `firstSeen` order (hello and sessions messages list sessions unordered). */
  assignAll(list: Iterable<{ sessionId: string; firstSeen: number }>): void {
    const sorted = [...list].sort((a, b) => a.firstSeen - b.firstSeen || (a.sessionId < b.sessionId ? -1 : 1));
    for (const s of sorted) this.assign(s.sessionId);
  }

  clear(): void {
    this.colors.clear();
  }

  /** Session ids in assignment order. */
  ids(): string[] {
    return [...this.colors.keys()];
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.colors);
  }
}

/** The page's palette (like agents.ts, one per page; main clears it on every reset). */
export const sessionPalette = new SessionPalette();

/**
 * Sessions that count toward the tint: not ended, or ended with events in the last 10 min.
 * One ended by /clear does not count: its window lives on as the session that replaced it.
 */
export function activeSessions(list: Iterable<SessionActivity>, now: number): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (s.sessionId === EXTERNAL_SESSION) continue;
    if (!s.ended || (!s.cleared && now - s.lastSeen <= ACTIVE_WINDOW_MS)) out.push(s.sessionId);
  }
  return out;
}

/**
 * Ends every session still open (replay, at a 'tree' line: a new server run starts and
 * the previous one never logged their end). Returns true when something changed.
 */
export function endOpenSessions(list: Iterable<SessionActivity>): boolean {
  let changed = false;
  for (const s of list) {
    if (s.ended || s.sessionId === EXTERNAL_SESSION) continue;
    s.ended = true;
    changed = true;
  }
  return changed;
}

/** True when two or more sessions count: only then the tint shows. */
export function isMultiSession(list: Iterable<SessionActivity>, now: number): boolean {
  return activeSessions(list, now).length >= 2;
}

/**
 * Session ring for an event, or undefined. Only main-agent events of a known session get
 * one, and only while several sessions are active. Subagent events keep their agent halo,
 * and external changes keep their own grey look.
 */
export function sessionRing(
  event: Pick<VizEvent, 'sessionId' | 'agentId' | 'external'>,
  color: string | undefined,
  multi: boolean,
): string | undefined {
  if (!multi || !color) return undefined;
  if (event.agentId || event.external || event.sessionId === EXTERNAL_SESSION) return undefined;
  return color;
}
