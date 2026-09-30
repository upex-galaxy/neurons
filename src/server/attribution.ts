// Attribution of disk changes (seen by the watcher) to Claude tool calls.
//
// - A PreToolUse(Bash) opens a window keyed by tool_use_id. Any disk change while
//   a window is open is attributed to the most recently opened one.
// - Edit/Write/MultiEdit/NotebookEdit mark their target path in flight: disk
//   changes on it are Claude's but duplicate the hook event, so they are suppressed.
// - Paths already reported by a hook (bashEditDiff, Edit/Write post) suppress
//   watcher changes on them for `dedupeMs`.
// Pure logic with an injectable clock: expiry is lazy, no timers.

import type { Action } from '../shared/types.ts';
import type { HookPayload } from './normalize.ts';
import type { PathResolver } from './paths.ts';

export type DiskChangeType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface DiskChange {
  type: DiskChangeType;
  /** Relative to the repo root, "/" separators. */
  path: string;
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

export class Attributor {
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #ttlMs: number;
  readonly #dedupeMs: number;
  readonly #resolver: PathResolver | undefined;
  readonly #windows = new Map<string, Window>();
  readonly #inFlight = new Map<string, InFlight>();
  readonly #reported = new Map<string, Reported>();
  /** `${action}\0${rel}` -> time the watcher emitted it (reverse dedupe for late bashEditDiff). */
  readonly #emitted = new Map<string, number>();
  #seq = 0;

  constructor(opts: AttributorOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#graceMs = opts.graceMs ?? 600;
    this.#ttlMs = opts.ttlMs ?? 600_000;
    this.#dedupeMs = opts.dedupeMs ?? 2000;
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
  noteReported(rels: string[], who?: Owner): void {
    const until = this.#now() + this.#dedupeMs;
    for (const rel of rels) {
      this.#reported.set(rel, who ? { until, owner: { ...who } } : { until });
    }
    this.#cap(this.#reported);
  }

  /** Records that the watcher emitted `action` on `rel` (so a later hook event can skip it). */
  noteEmitted(rel: string, action: Action): void {
    this.#emitted.set(`${action}\0${rel}`, this.#now());
    this.#cap(this.#emitted);
  }

  /** True when the watcher emitted `action` on `rel` within the last `dedupeMs`. */
  wasEmitted(rel: string, action: Action): boolean {
    const at = this.#emitted.get(`${action}\0${rel}`);
    return at !== undefined && this.#now() - at <= this.#dedupeMs;
  }

  classify(c: DiskChange): Attribution {
    this.#expire();
    const rel = c.path;
    const isDirChange = c.type === 'addDir' || c.type === 'unlinkDir';
    // A dir change is covered by any in-flight or reported path beneath it
    // (Write into a new folder, `rm -r` listed file by file in bashEditDiff).
    const matches = (target: string): boolean => target === rel || (isDirChange && within(target, rel));

    for (const f of this.#inFlight.values()) {
      if (matches(f.rel)) return { attributed: true, suppressed: true, ...ownerFields(f) };
    }
    for (const [target, r] of this.#reported) {
      if (matches(target)) {
        const w = r.owner ? undefined : this.#latestWindow();
        return { attributed: true, suppressed: true, ...ownerFields(r.owner ?? w) };
      }
    }
    const w = this.#latestWindow();
    if (w) return { attributed: true, suppressed: false, ...ownerFields(w) };
    return { attributed: false, suppressed: false };
  }

  /** Bash windows still open (including those in their grace period). */
  openWindows(): number {
    this.#expire();
    return this.#windows.size;
  }

  #latestWindow(): Window | undefined {
    let best: Window | undefined;
    for (const w of this.#windows.values()) if (!best || w.seq > best.seq) best = w;
    return best;
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
    const expired = (e: { openedAt: number; closeAt?: number }) =>
      (e.closeAt !== undefined && e.closeAt < now) || e.openedAt + this.#ttlMs < now;
    for (const [k, w] of this.#windows) if (expired(w)) this.#windows.delete(k);
    for (const [k, f] of this.#inFlight) if (expired(f)) this.#inFlight.delete(k);
    for (const [k, r] of this.#reported) if (r.until < now) this.#reported.delete(k);
    for (const [k, at] of this.#emitted) if (now - at > this.#dedupeMs) this.#emitted.delete(k);
  }

  #cap<V>(map: Map<string, V>): void {
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
