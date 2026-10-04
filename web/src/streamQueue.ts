// Queue behind the floating "now" stream: newest line at the bottom, at most STREAM_MAX
// shown, each one leaving after STREAM_TTL_MS. Hovering the stack pauses the clock. A Pre
// and its Post (same toolUseId) share one line, so a tool call never shows twice.
// Pure (no DOM) for unit tests.
import type { Action, Phase } from '../../src/shared/types.ts';

export const STREAM_MAX = 6;
export const STREAM_TTL_MS = 8000;

export interface StreamLine {
  /** Event id of the latest event on this line (what a click opens). */
  id: string;
  /** toolUseId when there is one, else the event id. */
  key: string;
  action: Action;
  phase: Phase;
  /** Path, skill name or "server/tool". */
  target: string;
  sessionId: string;
  agentId?: string;
  external?: boolean;
  expires: number;
}

export interface StreamChange {
  added?: StreamLine;
  updated?: StreamLine;
  removed: StreamLine[];
}

export class StreamQueue {
  private lines: StreamLine[] = [];
  private pausedAt: number | null = null;

  constructor(
    private readonly max = STREAM_MAX,
    private readonly ttl = STREAM_TTL_MS,
  ) {}

  /** Adds a line, or refreshes the line of the same tool call. */
  push(line: Omit<StreamLine, 'expires'>, now: number): StreamChange {
    const expires = now + this.ttl;
    const same = this.lines.find((l) => l.key === line.key);
    if (same) {
      Object.assign(same, line, { expires });
      return { updated: same, removed: [] };
    }
    const added: StreamLine = { ...line, expires };
    this.lines.push(added);
    const removed = this.lines.length > this.max ? this.lines.splice(0, this.lines.length - this.max) : [];
    return { added, removed };
  }

  /** Removes the lines whose time ran out; nothing leaves while paused. */
  expire(now: number): StreamLine[] {
    if (this.pausedAt !== null) return [];
    const gone = this.lines.filter((l) => l.expires <= now);
    if (gone.length) this.lines = this.lines.filter((l) => l.expires > now);
    return gone;
  }

  pause(now: number): void {
    this.pausedAt ??= now;
  }

  /** Resumes the clock: every line gets back the time it spent paused. */
  resume(now: number): void {
    if (this.pausedAt === null) return;
    const delta = now - this.pausedAt;
    this.pausedAt = null;
    for (const l of this.lines) l.expires += delta;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  clear(): StreamLine[] {
    const gone = this.lines;
    this.lines = [];
    return gone;
  }

  items(): readonly StreamLine[] {
    return this.lines;
  }

  get size(): number {
    return this.lines.length;
  }
}
