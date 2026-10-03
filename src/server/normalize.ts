// Claude Code hook payload -> VizEvent[].
// Only paths and short metadata leave this module: file contents, diffs, stdout
// text and tool responses are read (for paths) and dropped.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Action, Phase, SessionInfo, VizEvent } from '../shared/types.ts';
import { classifyBash, extractPathsFromOutput, type BashClassification } from './bash.ts';
import { toPosix, type PathResolver } from './paths.ts';
import { isAlwaysExcluded, type TreeIndex } from './tree.ts';

export interface HookPayload {
  hook_event_name: string;
  session_id: string;
  [k: string]: unknown;
}

export function parseHookPayload(raw: string): HookPayload | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.hook_event_name !== 'string' || obj.hook_event_name === '') return null;
  if (typeof obj.session_id !== 'string' || obj.session_id === '') return null;
  return obj as HookPayload;
}

export interface NormalizerOptions {
  resolver: PathResolver;
  index: TreeIndex;
  now?: () => number;
  newId?: () => string;
  fileExists?: (abs: string) => boolean;
}

const DETAIL_MAX = 120;
const SECONDARY_MAX = 200;
/** Cap for per-tool_use_id memory (Pre seen, Post never arrived). */
const PENDING_MAX = 2000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Collapses whitespace to one line and truncates to 120 chars. */
export function shortDetail(s: string): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > DETAIL_MAX ? line.slice(0, DETAIL_MAX - 1) + '…' : line;
}

// --- Bash command -> detail
// A Bash command can carry the content it writes (heredoc bodies, `echo ... > f`,
// `python -c "open(...).write(...)"`). The detail keeps the command's shape and drops
// that content: only the first logical line, quoted literals redacted when the line
// writes files or runs inline code, echo/printf arguments redacted when it writes.

/** Output redirect to a file (not `2>`, `>&2`, `>/dev/null`). */
const WRITE_REDIRECT_RE = /(?:^|[^<>&\d])>{1,2}\|?\s*(?!&)(?!\/dev\/(?:null|stdout|stderr|tty)\b)[^\s&|;]/;
const TEE_RE = /(?:^|[\s|;&(])tee(?:\s|$)/;
const SED_INPLACE_RE = /(?:^|[\s|;&(])sed\b[^|;&]*\s-[A-Za-z]*i/;
/** Interpreter with inline code: python -c, node -e/-p/--eval, perl -pe, bash -c... */
const INLINE_CODE_RE =
  /(?:^|[\s|;&(/])(?:python[\d.]*|node|nodejs|deno|bun|tsx|perl|ruby|php|bash|sh|zsh|dash|fish|osascript)\b[^|;&]*?\s-(?:[A-Za-z]*[cep]\b|-eval\b|-print\b)/;
const QUOTED_RE = /\$?'[^']*'|"(?:[^"\\]|\\.)*"/g;
const REDACTED = '…';

/** Index of a quote that is never closed on this line, or -1. */
function unterminatedQuote(s: string): number {
  let quote: string | undefined;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === undefined) {
      if (c === '\\') i++;
      else if (c === "'" || c === '"') {
        quote = c;
        start = i;
      }
    } else if (quote === '"' && c === '\\') i++;
    else if (c === quote) quote = undefined;
  }
  return quote === undefined ? -1 : start;
}

/** A Bash command reduced to a one-line detail without the content it may write. */
export function bashDetail(command: string): string {
  let s = command.replace(/\\\r?\n/g, ' ');
  let dropped = false;
  const nl = s.search(/\r?\n/);
  if (nl >= 0) {
    dropped = s.slice(nl).trim() !== '';
    s = s.slice(0, nl);
  }
  const open = unterminatedQuote(s);
  if (open >= 0) {
    // A literal that goes on past the line (multi-line string): keep only its quote.
    s = s.slice(0, open + 1) + REDACTED;
    dropped = false;
  }
  const writes = WRITE_REDIRECT_RE.test(s) || TEE_RE.test(s) || SED_INPLACE_RE.test(s);
  if (writes || INLINE_CODE_RE.test(s)) {
    s = s.replace(QUOTED_RE, (q) => (q.startsWith('$') ? `$'${REDACTED}'` : `${q[0]}${REDACTED}${q[0]}`));
  }
  // Here-string: `cmd <<< word` feeds the word as stdin content.
  s = s.replace(/<<<\s*(?:\S+)?/g, `<<< ${REDACTED}`);
  if (writes) {
    s = s
      .split(/(\|\||&&|[|;&])/)
      .map((seg) =>
        seg.replace(/^(\s*(?:sudo\s+)?(?:echo|printf))((?:\s+[^\s<>|;&]+)+)/, (_m, cmd: string) => `${cmd} ${REDACTED}`),
      )
      .join('');
  }
  return shortDetail(dropped ? `${s} ${REDACTED}` : s);
}

const GLOB_RE = /[*?[\]{}]/;

/** Argument whose value is only known at run time ($VAR, `cmd`). */
function isDynamic(arg: string): boolean {
  return arg.includes('$') || arg.includes('`');
}

/** For a glob argument ("src/*.ts") returns the static directory before the first glob segment. */
function globBase(arg: string): string {
  if (!GLOB_RE.test(arg)) return arg;
  const parts = arg.split('/');
  const idx = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  const base = parts.slice(0, idx).join('/');
  return base === '' ? (arg.startsWith('/') ? '/' : '.') : base;
}

interface Placed {
  paths: string[];
  outside: string[];
}

type ToolPlan = {
  action: Action;
  paths: string[];
  outside: string[];
  detail?: string | undefined;
  secondary?: string[];
  fromPaths?: string[];
};

export class Normalizer {
  readonly #resolver: PathResolver;
  readonly #index: TreeIndex;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #fileExists: (abs: string) => boolean;
  readonly #sessions = new Map<string, SessionInfo>();
  /** tool_use_id -> the file existed at PreToolUse(Write). */
  readonly #writeExisted = new Map<string, boolean>();
  /** tool_use_id -> classification at PreToolUse(Bash). */
  readonly #bashPre = new Map<string, BashClassification>();
  /** tool_use_id -> delete/move plans computed at PreToolUse(Bash), against the tree before the command. */
  readonly #bashPlans = new Map<string, ToolPlan[]>();

  constructor(opts: NormalizerOptions) {
    this.#resolver = opts.resolver;
    this.#index = opts.index;
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
    this.#fileExists = opts.fileExists ?? ((abs) => fs.existsSync(abs));
  }

  sessions(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ ...s, agents: { ...s.agents } }));
  }

  normalize(p: HookPayload): VizEvent[] {
    const ts = this.#now();
    const sessionId = p.session_id;
    const eventName = p.hook_event_name;
    const out: VizEvent[] = [];

    let session = this.#sessions.get(sessionId);
    if (!session || (session.ended && eventName !== 'SessionEnd')) {
      if (!session) {
        session = { sessionId, firstSeen: ts, lastSeen: ts, ended: false, agents: {} };
        this.#sessions.set(sessionId, session);
      }
      session.ended = false;
      delete session.cleared;
      out.push(this.#event(p, ts, { action: 'session_start', phase: 'info', paths: [] }, false));
    }
    session.lastSeen = ts;

    const agentId = str(p.agent_id);
    if (agentId) session.agents[agentId] = str(p.agent_type) ?? session.agents[agentId] ?? '';

    switch (eventName) {
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        out.push(...this.#tool(p, ts, eventName));
        break;
      case 'InstructionsLoaded': {
        const placed = this.#place([str(p.file_path)], str(p.cwd));
        const trigger = this.#place([str(p.trigger_file_path)], str(p.cwd)).paths;
        const reason = str(p.load_reason);
        out.push(
          this.#event(p, ts, {
            action: 'context_load',
            phase: 'info',
            paths: placed.paths,
            outside: placed.outside,
            detail: reason && shortDetail(reason),
            secondary: trigger,
          }),
        );
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = str(p.prompt);
        out.push(this.#event(p, ts, { action: 'turn_start', phase: 'info', paths: [], detail: prompt && shortDetail(prompt) }));
        break;
      }
      case 'Stop':
        out.push(this.#event(p, ts, { action: 'turn_end', phase: 'info', paths: [] }));
        break;
      case 'StopFailure':
        out.push(this.#event(p, ts, { action: 'turn_end', phase: 'fail', paths: [] }));
        break;
      case 'SessionEnd': {
        session.ended = true;
        const reason = str(p.reason);
        if (reason === 'clear') session.cleared = true;
        else delete session.cleared;
        out.push(this.#event(p, ts, { action: 'session_end', phase: 'info', paths: [], detail: reason && shortDetail(reason) }));
        break;
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        const ev = this.#event(p, ts, {
          action: eventName === 'SubagentStart' ? 'subagent_start' : 'subagent_stop',
          phase: 'info',
          paths: [],
        });
        const type = str(p.agent_type);
        if (type) ev.agentType = type;
        out.push(ev);
        break;
      }
      case 'PostToolBatch':
        out.push(this.#event(p, ts, { action: 'batch_end', phase: 'info', paths: [] }));
        break;
      case 'PreCompact':
      case 'PostCompact': {
        const trigger = str(p.trigger);
        out.push(
          this.#event(p, ts, {
            action: 'compact',
            phase: eventName === 'PreCompact' ? 'pre' : 'post',
            paths: [],
            detail: trigger && shortDetail(trigger),
          }),
        );
        break;
      }
      default:
        break;
    }
    return out;
  }

  // ---------------------------------------------------------------- tools

  #tool(p: HookPayload, ts: number, eventName: string): VizEvent[] {
    const toolName = str(p.tool_name) ?? 'unknown';
    const toolUseId = str(p.tool_use_id);
    const input = obj(p.tool_input) ?? {};
    const response = obj(p.tool_response);
    const cwd = str(p.cwd);
    const phase: Phase =
      eventName === 'PreToolUse' ? 'pre' : eventName === 'PostToolUse' ? 'post' : 'fail';
    const denied = eventName === 'PermissionDenied';
    const finished = phase !== 'pre';

    const base = { toolName, toolUseId };
    const emit = (plan: ToolPlan): VizEvent => {
      const ev = this.#event(p, ts, {
        action: plan.action,
        phase,
        paths: plan.paths,
        outside: plan.outside,
        detail: denied ? 'denied' : plan.detail,
        secondary: plan.secondary,
        fromPaths: plan.fromPaths,
      });
      ev.toolName = base.toolName;
      if (base.toolUseId) ev.toolUseId = base.toolUseId;
      return ev;
    };

    switch (toolName) {
      case 'Read':
        return [emit({ action: 'read', ...this.#place([str(input.file_path)], cwd) })];
      case 'Edit':
      case 'MultiEdit':
        return [emit({ action: 'edit', ...this.#place([str(input.file_path)], cwd) })];
      case 'NotebookEdit':
        return [emit({ action: 'edit', ...this.#place([str(input.notebook_path)], cwd) })];
      case 'Write':
        return [emit(this.#write(input, response, cwd, phase, toolUseId, finished))];
      case 'Glob':
      case 'Grep':
        return [emit(this.#globGrep(input, response, cwd, phase))];
      case 'Bash':
        return this.#bash(input, response, cwd, phase, toolUseId, finished).map(emit);
      case 'Agent':
      case 'Task': {
        const desc = str(input.description);
        return [emit({ action: 'tool', paths: [], outside: [], detail: desc && shortDetail(desc) })];
      }
      default: {
        const filePath = str(input.file_path);
        const placed = filePath ? this.#place([filePath], cwd) : { paths: [], outside: [] };
        if (!filePath) {
          const generic = str(input.path);
          if (generic) placed.paths = this.#place([generic], cwd).paths;
        }
        return [emit({ action: 'tool', ...placed })];
      }
    }
  }

  #write(
    input: Record<string, unknown>,
    response: Record<string, unknown> | undefined,
    cwd: string | undefined,
    phase: Phase,
    toolUseId: string | undefined,
    finished: boolean,
  ): ToolPlan {
    const filePath = str(input.file_path);
    const placed = this.#place([filePath], cwd);
    let existed: boolean | undefined;
    if (phase === 'pre') {
      existed = filePath ? this.#fileExists(this.#resolver.resolve(filePath, cwd).abs) : false;
      if (toolUseId) this.#remember(this.#writeExisted, toolUseId, existed);
    } else {
      if (toolUseId) existed = this.#writeExisted.get(toolUseId);
      const type = response?.type;
      if (phase === 'post' && type === 'create') existed = false;
      else if (phase === 'post' && type === 'update') existed = true;
    }
    if (finished && toolUseId) this.#writeExisted.delete(toolUseId);
    return { action: existed === false ? 'create' : 'edit', ...placed };
  }

  #globGrep(
    input: Record<string, unknown>,
    response: Record<string, unknown> | undefined,
    cwd: string | undefined,
    phase: Phase,
  ): ToolPlan {
    const target = str(input.path);
    const placed = target ? this.#place([target], cwd) : this.#cwdPlace(cwd);
    const pattern = str(input.pattern);
    const plan: ToolPlan = { action: 'search', ...placed, detail: pattern && shortDetail(pattern) };
    if (phase === 'post' && Array.isArray(response?.filenames)) {
      const names = (response.filenames as unknown[]).filter((f): f is string => typeof f === 'string');
      plan.secondary = this.#indexed(names.slice(0, SECONDARY_MAX * 5), target ? this.#resolver.resolve(target, cwd).abs : cwd);
    }
    return plan;
  }

  #bash(
    input: Record<string, unknown>,
    response: Record<string, unknown> | undefined,
    cwd: string | undefined,
    phase: Phase,
    toolUseId: string | undefined,
    finished: boolean,
  ): ToolPlan[] {
    const command = str(input.command) ?? '';
    const detail = command ? bashDetail(command) : undefined;
    let cls = toolUseId ? this.#bashPre.get(toolUseId) : undefined;
    if (!cls) cls = classifyBash(command);
    if (phase === 'pre' && toolUseId) this.#remember(this.#bashPre, toolUseId, cls);
    if (finished && toolUseId) this.#bashPre.delete(toolUseId);

    const argBase = cls.cdDir !== undefined ? this.#resolver.resolve(cls.cdDir, cwd).abs : cwd;

    if (phase === 'post') {
      const diff = obj(response?.bashEditDiff);
      const files = Array.isArray(diff?.files) ? (diff.files as unknown[]).map(obj).filter((f) => f !== undefined) : [];
      if (files.length > 0) return this.#fromEditDiff(files, cwd, detail);
    }

    if (cls.kind === 'search') {
      const args = cls.pathArgs.filter((a) => !a.includes('$') && !a.includes('`')).map(globBase);
      const placed = args.length > 0 ? this.#place(args, cwd) : this.#cwdPlace(argBase);
      const plan: ToolPlan = { action: 'search', ...placed, detail };
      if (phase === 'post') {
        const stdout = typeof response?.stdout === 'string' ? response.stdout : '';
        plan.secondary = this.#indexed(extractPathsFromOutput(stdout, SECONDARY_MAX), argBase);
      }
      return [plan];
    }
    if (cls.kind === 'delete' || cls.kind === 'move') {
      let plans = phase !== 'pre' && toolUseId ? this.#bashPlans.get(toolUseId) : undefined;
      if (!plans) plans = cls.kind === 'delete' ? this.#deletePlans(cls, cwd) : this.#movePlans(cls, cwd);
      if (phase === 'pre' && toolUseId) this.#remember(this.#bashPlans, toolUseId, plans);
      if (finished && toolUseId) this.#bashPlans.delete(toolUseId);
      if (plans.length > 0) {
        return plans.map((pl) => {
          const copy: ToolPlan = { ...pl, paths: [...pl.paths], outside: [...pl.outside], detail };
          if (pl.fromPaths) copy.fromPaths = [...pl.fromPaths];
          return copy;
        });
      }
      // Nothing certain to point at (globs, find -delete, rm -rf .): the watcher reports
      // the real removals, so the command is shown as plain Bash on the dirs it works in.
      const hints = cls.pathArgs.filter((a) => !isDynamic(a)).map(globBase);
      const placed = hints.length > 0 ? this.#place(hints, cwd) : this.#cwdPlace(argBase);
      if (placed.paths.length === 0 && placed.outside.length === 0) return [{ action: 'bash', ...this.#cwdPlace(argBase), detail }];
      return [{ action: 'bash', ...placed, detail }];
    }
    return [{ action: 'bash', ...this.#cwdPlace(argBase), detail }];
  }

  /**
   * Heuristic delete targets: literal arguments only. Globs and `find` roots are not
   * what gets deleted, and the repo root is never deleted itself. [] = nothing certain.
   */
  #deletePlans(cls: BashClassification, cwd: string | undefined): ToolPlan[] {
    const bases = new Set(cls.bases ?? []);
    const targets = cls.pathArgs.filter((a) => !isDynamic(a) && !GLOB_RE.test(a) && !bases.has(a));
    const placed = this.#place(targets, cwd);
    placed.paths = placed.paths.filter((p) => p !== '');
    if (placed.paths.length === 0 && placed.outside.length === 0) return [];
    return [{ action: 'delete', ...placed }];
  }

  /**
   * Heuristic moves: `paths` are the new locations and `fromPaths` the old ones,
   * index-aligned. A destination that is a directory (before the command runs)
   * receives the source under its own name. A move into the repo from outside is a
   * create, and a move out of it a delete.
   */
  #movePlans(cls: BashClassification, cwd: string | undefined): ToolPlan[] {
    const to: string[] = [];
    const from: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    const outside: string[] = [];
    const createdFrom: string[] = [];
    const deletedTo: string[] = [];
    const inRepo = (r: { inside: boolean; rel?: string | undefined }): string | undefined =>
      r.inside && r.rel !== undefined && r.rel !== '' && !isAlwaysExcluded(r.rel) ? r.rel : undefined;
    const addOutside = (list: string[], r: { inside: boolean; abs: string }) => {
      const abs = toPosix(r.abs);
      if (!r.inside && !list.includes(abs)) list.push(abs);
    };
    for (const m of cls.moves ?? []) {
      if (isDynamic(m.dest) || GLOB_RE.test(m.dest)) continue;
      const dest = this.#resolver.resolve(m.dest, cwd);
      const into = m.intoDir || (dest.inside && dest.rel !== undefined && this.#index.kind(dest.rel) === 'dir');
      for (const s of m.sources) {
        if (isDynamic(s) || GLOB_RE.test(s)) continue;
        const src = this.#resolver.resolve(s, cwd);
        const target = into ? this.#resolver.resolve(path.join(dest.abs, path.basename(src.abs))) : dest;
        const fromRel = inRepo(src);
        const toRel = inRepo(target);
        if (fromRel !== undefined && toRel !== undefined) {
          if (fromRel === toRel) continue;
          to.push(toRel);
          from.push(fromRel);
        } else if (toRel !== undefined) {
          if (!created.includes(toRel)) created.push(toRel);
          addOutside(createdFrom, src);
        } else if (fromRel !== undefined) {
          if (!deleted.includes(fromRel)) deleted.push(fromRel);
          addOutside(deletedTo, target);
        } else {
          addOutside(outside, src);
          addOutside(outside, target);
        }
      }
    }
    const plans: ToolPlan[] = [];
    if (to.length > 0 || outside.length > 0) plans.push({ action: 'move', paths: to, fromPaths: from, outside });
    if (created.length > 0) plans.push({ action: 'create', paths: created, outside: createdFrom });
    if (deleted.length > 0) plans.push({ action: 'delete', paths: deleted, outside: deletedTo });
    return plans;
  }

  #fromEditDiff(files: Record<string, unknown>[], cwd: string | undefined, detail: string | undefined): ToolPlan[] {
    const created = files.filter((f) => f.created === true && str(f.filePath));
    const deleted = files.filter((f) => f.deleted === true && str(f.filePath));
    const plans: ToolPlan[] = [];
    const isMove = created.length === 1 && deleted.length === 1;
    if (isMove) {
      const to = this.#place([str(created[0]?.filePath)], cwd);
      const from = this.#place([str(deleted[0]?.filePath)], cwd);
      plans.push({
        action: 'move',
        paths: to.paths,
        fromPaths: from.paths,
        outside: [...to.outside, ...from.outside],
        detail,
      });
    }
    for (const f of files) {
      const fp = str(f.filePath);
      if (!fp) continue;
      if (isMove && (f.created === true || f.deleted === true)) continue;
      const action: Action = f.created === true ? 'create' : f.deleted === true ? 'delete' : 'edit';
      const placed = this.#place([fp], cwd);
      if (placed.paths.length === 0 && placed.outside.length === 0) continue;
      plans.push({ action, ...placed, detail });
    }
    return plans;
  }

  // ---------------------------------------------------------------- helpers

  #event(
    p: HookPayload,
    ts: number,
    f: {
      action: Action;
      phase: Phase;
      paths: string[];
      outside?: string[];
      detail?: string | undefined;
      secondary?: string[] | undefined;
      fromPaths?: string[] | undefined;
    },
    withAgent = true,
  ): VizEvent {
    const ev: VizEvent = {
      id: this.#newId(),
      ts,
      sessionId: p.session_id,
      phase: f.phase,
      action: f.action,
      paths: f.paths,
      source: 'hook',
    };
    const promptId = str(p.prompt_id);
    if (promptId) ev.promptId = promptId;
    const agentId = str(p.agent_id);
    if (withAgent && agentId) {
      ev.agentId = agentId;
      const agentType = str(p.agent_type);
      if (agentType) ev.agentType = agentType;
    }
    if (f.outside && f.outside.length > 0) ev.outsideRepo = f.outside;
    if (f.secondary && f.secondary.length > 0) ev.secondary = f.secondary;
    if (f.fromPaths && f.fromPaths.length > 0) ev.fromPaths = f.fromPaths;
    if (f.detail) ev.detail = f.detail;
    return ev;
  }

  /** Resolves candidate paths: inside -> rel (excluded dropped), outside -> absolute posix. */
  #place(inputs: (string | undefined)[], cwd: string | undefined): Placed {
    const paths: string[] = [];
    const outside: string[] = [];
    for (const input of inputs) {
      if (!input) continue;
      const r = this.#resolver.resolve(input, cwd);
      if (r.inside && r.rel !== undefined) {
        if (!isAlwaysExcluded(r.rel) && !paths.includes(r.rel)) paths.push(r.rel);
      } else if (!r.inside) {
        const abs = toPosix(r.abs);
        if (!outside.includes(abs)) outside.push(abs);
      }
    }
    return { paths, outside };
  }

  /** The Bash/tool working directory as a target: rel when inside, nothing otherwise. */
  #cwdPlace(dir: string | undefined): Placed {
    const r = this.#resolver.resolve('', dir);
    if (r.inside && r.rel !== undefined && !isAlwaysExcluded(r.rel)) return { paths: [r.rel], outside: [] };
    return { paths: [], outside: [] };
  }

  /** Resolves output paths against `base` and keeps those present in the tree index. */
  #indexed(candidates: string[], base: string | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      const r = this.#resolver.resolve(c, base);
      if (!r.inside || r.rel === undefined || r.rel === '' || seen.has(r.rel)) continue;
      if (isAlwaysExcluded(r.rel) || !this.#index.has(r.rel)) continue;
      seen.add(r.rel);
      out.push(r.rel);
      if (out.length >= SECONDARY_MAX) break;
    }
    return out;
  }

  #remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.set(key, value);
    if (map.size > PENDING_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
}
