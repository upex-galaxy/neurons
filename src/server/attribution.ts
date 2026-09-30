// Attribution of disk changes (seen by the watcher) to Claude tool calls.
//
// - A PreToolUse(Bash) opens a window keyed by tool_use_id. A disk change seen while
//   windows are open is attributed to the most recently opened of them.
// - Edit/Write/MultiEdit/NotebookEdit mark their target path in flight: disk
//   changes on it are Claude's but duplicate the hook event, so they are suppressed.
// - Paths already reported by a hook (bashEditDiff, Edit/Write post, a Bash rm/mv
//   guess) suppress watcher changes on them for `dedupeMs`.
// - The other way round, paths the watcher already emitted stay on record (present or
//   gone) while the Bash window they fell in is alive, so a late bashEditDiff does not
//   repeat them.
// Windows are matched against the time the change was seen (DiskChange.ts), not the
// time it is classified: a flush can lag behind the hooks.
// Pure logic with an injectable clock: expiry is lazy, no timers.

import type { HookPayload } from './normalize.ts';
import type { PathResolver } from './paths.ts';

export type DiskChangeType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | 'move' | 'moveDir';

export interface DiskChange {
  type: DiskChangeType;
  /** Relative to the repo root, "/" separators. For a move, the new location. */
  path: string;
  /** For `move` / `moveDir`: the previous location. */
  from?: string;
  /** Part of a change already reported (the contents of a moved dir): update the tree, emit nothing. */
  quiet?: boolean;
  /** Epoch ms when the watcher first saw the path change. */
  ts: number;
}

export interface Attribution {
  attributed: boolean;
  suppressed: boolean;
  sessionId?: string;
  agentId?: string;
  toolUseId?: string;
  promptId?: string;
}

/** Who a hook-reported change belongs to. */
export interface Owner {
  sessionId: string;
  agentId?: string;
  toolUseId?: string;
  promptId?: string;
}

export interface AttributorOptions {
  now?: () => number;
  /** Extra time a window stays open after its closing hook (FSEvents latency). */
  graceMs?: number;
  /** Hard lifetime of a window whose closing hook never arrives. */
  ttlMs?: number;
  /** How long a hook-reported path suppresses watcher changes. */
  dedupeMs?: number;
  /** How long a closed window is kept to classify changes seen while it was open but flushed late. */
  retainMs?: number;
  /** Turns tool_input.file_path into a repo-relative path. Without it, only relative inputs are tracked. */
  resolver?: PathResolver;
}

interface Window extends Owner {
  seq: number;
  openedAt: number;
  /** Set when a closing hook arrived: the window ends at this time. */
  closeAt?: number;
}

interface InFlight extends Owner {
  rel: string;
  openedAt: number;
  closeAt?: number;
}

interface Reported {
  until: number;
  owner?: Owner;
  /** Also covers everything beneath the path (a deleted or moved dir). */
  subtree?: boolean;
}

interface Emitted {
  /** When the change was seen (DiskChange.ts). */
  at: number;
  /** What the emission told: the path exists (create, edit, move target) or is gone. */
  present: boolean;
  subtree: boolean;
}

export interface EmitOptions {
  /** The path exists after the change (create, edit, move target). Default true. */
  present?: boolean;
  /** Also covers everything beneath (a dir removed, or moved with its contents). */
  subtree?: boolean;
}

export interface ReportOptions {
  /** Also cover paths beneath the reported ones. */
  subtree?: boolean;
  /** Suppression time instead of dedupeMs. */
  ms?: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FINISH_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
const TURN_END_EVENTS = new Set(['Stop', 'StopFailure', 'SessionEnd', 'UserPromptSubmit']);
/** Safety cap for maps whose closing events may never arrive. */
const MAX_ENTRIES = 5000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function owner(p: HookPayload): Owner {
  const o: Owner = { sessionId: p.session_id };
  const agentId = str(p.agent_id);
  const toolUseId = str(p.tool_use_id);
  const promptId = str(p.prompt_id);
  if (agentId) o.agentId = agentId;
  if (toolUseId) o.toolUseId = toolUseId;
  if (promptId) o.promptId = promptId;
  return o;
}

function ownerFields(o: Owner | undefined): Omit<Attribution, 'attributed' | 'suppressed'> {
  if (!o) return {};
  const out: Omit<Attribution, 'attributed' | 'suppressed'> = { sessionId: o.sessionId };
  if (o.agentId) out.agentId = o.agentId;
  if (o.toolUseId) out.toolUseId = o.toolUseId;
  if (o.promptId) out.promptId = o.promptId;
  return out;
}

/** True when `rel` is `target` or lies under it. */
function within(rel: string, target: string): boolean {
  return target === '' || rel === target || rel.startsWith(target + '/');
}

/** Moment a window or in-flight mark stops covering changes. */
function endOf(e: { openedAt: number; closeAt?: number }, ttlMs: number): number {
  return Math.min(e.closeAt ?? Infinity, e.openedAt + ttlMs);
}

export class Attributor {
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #ttlMs: number;
  readonly #dedupeMs: number;
  readonly #retainMs: number;
  readonly #resolver: PathResolver | undefined;
  readonly #windows = new Map<string, Window>();
  readonly #inFlight = new Map<string, InFlight>();
  readonly #reported = new Map<string, Reported>();
  /** rel -> watcher emission on record (reverse dedupe for a late Bash post). */
  readonly #emitted = new Map<string, Emitted>();
  #seq = 0;

  constructor(opts: AttributorOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#graceMs = opts.graceMs ?? 600;
    this.#ttlMs = opts.ttlMs ?? 600_000;
    this.#dedupeMs = opts.dedupeMs ?? 2000;
    this.#retainMs = opts.retainMs ?? 5000;
    this.#resolver = opts.resolver;
  }

  onHook(p: HookPayload): void {
    const now = this.#now();
    const event = p.hook_event_name;
    const toolName = str(p.tool_name);
    const toolUseId = str(p.tool_use_id);

    if (event === 'PreToolUse' && toolName === 'Bash') {
      const key = toolUseId ?? `anon:${++this.#seq}`;
      this.#windows.set(key, { ...owner(p), seq: ++this.#seq, openedAt: now });
      this.#cap(this.#windows);
      return;
    }

    if (toolName && EDIT_TOOLS.has(toolName) && (event === 'PreToolUse' || FINISH_EVENTS.has(event))) {
      const rel = this.#relOf(p);
      if (event === 'PreToolUse') {
        if (rel === undefined) return;
        this.#inFlight.set(toolUseId ?? `anon:${rel}`, { ...owner(p), rel, openedAt: now });
        this.#cap(this.#inFlight);
      } else {
        const key = toolUseId ?? (rel !== undefined ? `anon:${rel}` : undefined);
        const f = key !== undefined ? this.#inFlight.get(key) : undefined;
        if (f) f.closeAt = Math.min(f.closeAt ?? Infinity, now + this.#graceMs);
      }
      return;
    }

    if (FINISH_EVENTS.has(event) && toolUseId) {
      const w = this.#windows.get(toolUseId);
      if (w) w.closeAt = Math.min(w.closeAt ?? Infinity, now + this.#graceMs);
      return;
    }

    if (TURN_END_EVENTS.has(event)) {
      const closeAt = now + this.#graceMs;
      for (const w of this.#windows.values()) {
        if (w.sessionId === p.session_id) w.closeAt = Math.min(w.closeAt ?? Infinity, closeAt);
      }
      for (const f of this.#inFlight.values()) {
        if (f.sessionId === p.session_id) f.closeAt = Math.min(f.closeAt ?? Infinity, closeAt);
      }
    }
  }

  /** Paths a hook already emitted events for: watcher changes on them are duplicates. */
  noteReported(rels: string[], who?: Owner, opts: ReportOptions = {}): void {
    const until = this.#now() + (opts.ms ?? this.#dedupeMs);
    for (const rel of rels) {
      const r: Reported = { until };
      if (who) r.owner = { ...who };
      if (opts.subtree) r.subtree = true;
      const prev = this.#reported.get(rel);
      if (prev && prev.until > until) r.until = prev.until;
      this.#reported.delete(rel);
      this.#reported.set(rel, r);
    }
    this.#cap(this.#reported);
  }

  /**
   * Records that the watcher emitted an event on `rels` for a change seen at `ts`, and
   * whether it showed them present or gone.
   */
  noteEmitted(rels: string[], ts: number, opts: EmitOptions = {}): void {
    const present = opts.present ?? true;
    const subtree = opts.subtree ?? false;
    for (const rel of rels) {
      this.#emitted.delete(rel);
      this.#emitted.set(rel, { at: ts, present, subtree });
    }
    this.#cap(this.#emitted);
  }

  /**
   * True when the watcher already showed `rel` in the state `present` during the Bash
   * window `toolUseId` (or within `dedupeMs` when that window is unknown). The latest
   * record wins, its own or a subtree record of a dir above it: a file lit as created and
   * then deleted by the same command is not "already shown" as deleted.
   */
  wasEmitted(rel: string, toolUseId?: string, present = true): boolean {
    this.#expire();
    const w = toolUseId !== undefined ? this.#windows.get(toolUseId) : undefined;
    const since = w ? w.openedAt : this.#now() - this.#dedupeMs;
    let latest = this.#emitted.get(rel);
    let i = rel.lastIndexOf('/');
    while (i > 0) {
      const e = this.#emitted.get(rel.slice(0, i));
      if (e && e.subtree && (!latest || e.at > latest.at)) latest = e;
      i = rel.lastIndexOf('/', i - 1);
    }
    return latest !== undefined && latest.at >= since && latest.present === present;
  }

  classify(c: DiskChange): Attribution {
    this.#expire();
    const rels = c.from !== undefined ? [c.path, c.from] : [c.path];
    const isDirChange = c.type === 'addDir' || c.type === 'unlinkDir' || c.type === 'moveDir';
    // A dir change is covered by any in-flight or reported path beneath it
    // (Write into a new folder, `rm -r` listed file by file in bashEditDiff).
    const matches = (target: string, subtree = false): boolean =>
      rels.some((rel) => target === rel || (isDirChange && within(target, rel)) || (subtree && within(rel, target)));

    for (const f of this.#inFlight.values()) {
      if (this.#activeAt(f, c.ts) && matches(f.rel)) return { attributed: true, suppressed: true, ...ownerFields(f) };
    }
    for (const [target, r] of this.#reported) {
      if (matches(target, r.subtree)) {
        const w = r.owner ? undefined : this.#windowAt(c.ts);
        return { attributed: true, suppressed: true, ...ownerFields(r.owner ?? w) };
      }
    }
    const w = this.#windowAt(c.ts);
    if (w) return { attributed: true, suppressed: false, ...ownerFields(w) };
    return { attributed: false, suppressed: false };
  }

  /** Bash windows still open (including those in their grace period). */
  openWindows(): number {
    this.#expire();
    const now = this.#now();
    let n = 0;
    for (const w of this.#windows.values()) if (this.#activeAt(w, now)) n++;
    return n;
  }

  /** The most recently opened window that was open at `ts`. */
  #windowAt(ts: number): Window | undefined {
    let best: Window | undefined;
    for (const w of this.#windows.values()) {
      if (this.#activeAt(w, ts) && (!best || w.seq > best.seq)) best = w;
    }
    return best;
  }

  #activeAt(e: { openedAt: number; closeAt?: number }, ts: number): boolean {
    return e.openedAt <= ts && ts <= endOf(e, this.#ttlMs);
  }

  #relOf(p: HookPayload): string | undefined {
    const input = p.tool_input;
    if (typeof input !== 'object' || input === null) return undefined;
    const rec = input as Record<string, unknown>;
    const file = str(rec.file_path) ?? str(rec.notebook_path);
    if (!file) return undefined;
    if (this.#resolver) {
      const r = this.#resolver.resolve(file, str(p.cwd));
      return r.inside ? r.rel : undefined;
    }
    return file.startsWith('/') ? undefined : file.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  #expire(): void {
    const now = this.#now();
    // Closed windows linger for retainMs: a change seen while they were open may be classified late.
    const gone = (e: { openedAt: number; closeAt?: number }) => endOf(e, this.#ttlMs) + this.#retainMs < now;
    for (const [k, w] of this.#windows) if (gone(w)) this.#windows.delete(k);
    for (const [k, f] of this.#inFlight) if (gone(f)) this.#inFlight.delete(k);
    for (const [k, r] of this.#reported) if (r.until < now) this.#reported.delete(k);
    let floor = Infinity;
    for (const w of this.#windows.values()) floor = Math.min(floor, w.openedAt);
    for (const [k, e] of this.#emitted) {
      if (now - e.at > this.#dedupeMs && e.at < floor) this.#emitted.delete(k);
    }
  }

  #cap<V>(map: Map<string, V>): void {
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
