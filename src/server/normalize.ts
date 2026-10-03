// Claude Code hook payload -> VizEvent[].
// Only paths and short metadata leave this module: file contents, diffs, stdout
// text and tool responses are read (for paths) and dropped.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Action, Phase, SessionInfo, VizEvent } from '../shared/types.ts';
import { classifyBash, extractPathsFromOutput, type BashClassification } from './bash.ts';
import { splitWorktreeRel, toPosix, type PathResolver, type ResolvedPath } from './paths.ts';
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

/**
 * A prompt that opens with a hyphenated XML-like tag (`<task-notification>`,
 * `<system-reminder>`, `<command-message>`) was written by Claude Code, not typed. Its tags
 * always have a `-` or `_`; a typed prompt that opens with `<div>` or `<Button>` is not one.
 */
const INJECTED_PROMPT_RE = /^<([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)(?:\s[^<>]*)?>/;
/** Whole tags only (`<x>`, `</x>`, `<x a="1">`, `<x/>`). `a<b` or `si a<b y c>d` is not a tag. */
const TAG_FRAGMENT_RE = /<\/?[a-z][a-z0-9_-]*(?:\s+[\w:.-]+=(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/gi;

/**
 * The turn_start detail for a UserPromptSubmit prompt. Claude Code also submits prompts of
 * its own (`<task-notification>` when a background subagent finishes): those get a fixed
 * label, never their raw text. A typed prompt keeps its first 120 chars without tags.
 */
export function promptDetail(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  const injected = INJECTED_PROMPT_RE.exec(trimmed);
  if (injected) return injected[1] === 'task-notification' ? 'notificación de tarea en segundo plano' : 'notificación del sistema';
  const detail = shortDetail(trimmed.replace(TAG_FRAGMENT_RE, ' '));
  return detail === '' ? undefined : detail;
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
  /** Set when a path was inside a Claude Code worktree (and rewritten to the main repo). */
  worktree?: string;
}

type ToolPlan = {
  action: Action;
  paths: string[];
  outside: string[];
  detail?: string | undefined;
  secondary?: string[];
  fromPaths?: string[];
  worktree?: string | undefined;
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
            worktree: placed.worktree,
          }),
        );
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = str(p.prompt);
        out.push(this.#event(p, ts, { action: 'turn_start', phase: 'info', paths: [], detail: prompt && promptDetail(prompt) }));
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
        worktree: plan.worktree,
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
        let placed: Placed = filePath ? this.#place([filePath], cwd) : { paths: [], outside: [] };
        if (!filePath) {
          const generic = str(input.path);
          if (generic) placed = { ...this.#place([generic], cwd), outside: [] };
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
      const groups = args.length > 0 ? this.#placeGroups(args, cwd) : [this.#cwdPlace(argBase)];
      const plans: ToolPlan[] = groups.map((g) => ({ action: 'search', ...g, detail }));
      const first = plans[0];
      if (phase === 'post' && first) {
        const stdout = typeof response?.stdout === 'string' ? response.stdout : '';
        first.secondary = this.#indexed(extractPathsFromOutput(stdout, SECONDARY_MAX), argBase);
      }
      return plans;
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
      const groups = hints.length > 0 ? this.#placeGroups(hints, cwd) : [this.#cwdPlace(argBase)];
      if (groups.every((g) => g.paths.length === 0 && g.outside.length === 0)) return [{ action: 'bash', ...this.#cwdPlace(argBase), detail }];
      return groups.map((g) => ({ action: 'bash', ...g, detail }));
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
    const plans: ToolPlan[] = [];
    for (const g of this.#placeGroups(targets, cwd)) {
      g.paths = g.paths.filter((p) => p !== '');
      if (g.paths.length > 0 || g.outside.length > 0) plans.push({ action: 'delete', ...g });
    }
    return plans;
  }

  /**
   * Heuristic moves: `paths` are the new locations and `fromPaths` the old ones,
   * index-aligned. A destination that is a directory (before the command runs)
   * receives the source under its own name. A move into the repo from outside is a
   * create, and a move out of it a delete.
   */
  #movePlans(cls: BashClassification, cwd: string | undefined): ToolPlan[] {
    // One bucket per tree: the main repo ('') and each worktree a path came from. A move
    // across the boundary is a delete on one side and a create on the other.
    interface Bucket {
      to: string[];
      from: string[];
      created: string[];
      createdFrom: string[];
      deleted: string[];
      deletedTo: string[];
    }
    const buckets = new Map<string, Bucket>();
    const bucket = (wt: string | undefined): Bucket => {
      const key = wt ?? '';
      let b = buckets.get(key);
      if (!b) {
        b = { to: [], from: [], created: [], createdFrom: [], deleted: [], deletedTo: [] };
        buckets.set(key, b);
      }
      return b;
    };
    bucket(undefined);
    const outside: string[] = [];
    const inRepo = (r: ResolvedPath): { rel: string; worktree?: string } | undefined => {
      const m = this.#repoRel(r);
      return m && m.rel !== '' ? m : undefined;
    };
    const addOutside = (list: string[], r: { inside: boolean; abs: string }) => {
      const abs = toPosix(r.abs);
      if (!r.inside && !list.includes(abs)) list.push(abs);
    };
    const addUnique = (list: string[], v: string) => {
      if (!list.includes(v)) list.push(v);
    };
    for (const m of cls.moves ?? []) {
      if (isDynamic(m.dest) || GLOB_RE.test(m.dest)) continue;
      const dest = this.#resolver.resolve(m.dest, cwd);
      const destRel = this.#repoRel(dest)?.rel;
      const into = m.intoDir || (destRel !== undefined && this.#index.kind(destRel) === 'dir');
      for (const s of m.sources) {
        if (isDynamic(s) || GLOB_RE.test(s)) continue;
        const src = this.#resolver.resolve(s, cwd);
        const target = into ? this.#resolver.resolve(path.join(dest.abs, path.basename(src.abs))) : dest;
        const fromM = inRepo(src);
        const toM = inRepo(target);
        if (fromM && toM && fromM.worktree === toM.worktree) {
          if (fromM.rel === toM.rel) continue;
          const b = bucket(toM.worktree);
          b.to.push(toM.rel);
          b.from.push(fromM.rel);
        } else if (fromM && toM) {
          addUnique(bucket(fromM.worktree).deleted, fromM.rel);
          addUnique(bucket(toM.worktree).created, toM.rel);
        } else if (toM) {
          const b = bucket(toM.worktree);
          addUnique(b.created, toM.rel);
          addOutside(b.createdFrom, src);
        } else if (fromM) {
          const b = bucket(fromM.worktree);
          addUnique(b.deleted, fromM.rel);
          addOutside(b.deletedTo, target);
        } else {
          addOutside(outside, src);
          addOutside(outside, target);
        }
      }
    }
    const plans: ToolPlan[] = [];
    for (const [key, b] of buckets) {
      const worktree = key === '' ? undefined : key;
      const out = key === '' ? outside : [];
      const tag = (pl: ToolPlan): ToolPlan => (worktree === undefined ? pl : { ...pl, worktree });
      if (b.to.length > 0 || out.length > 0) plans.push(tag({ action: 'move', paths: b.to, fromPaths: b.from, outside: out }));
      if (b.created.length > 0) plans.push(tag({ action: 'create', paths: b.created, outside: b.createdFrom }));
      if (b.deleted.length > 0) plans.push(tag({ action: 'delete', paths: b.deleted, outside: b.deletedTo }));
    }
    return plans;
  }

  #fromEditDiff(files: Record<string, unknown>[], cwd: string | undefined, detail: string | undefined): ToolPlan[] {
    const created = files.filter((f) => f.created === true && str(f.filePath));
    const deleted = files.filter((f) => f.deleted === true && str(f.filePath));
    const plans: ToolPlan[] = [];
    let isMove = created.length === 1 && deleted.length === 1;
    if (isMove) {
      const to = this.#place([str(created[0]?.filePath)], cwd);
      const from = this.#place([str(deleted[0]?.filePath)], cwd);
      // Between a worktree and the main repo: a delete on one side and a create on the other.
      isMove = to.worktree === from.worktree;
    }
    if (isMove) {
      const to = this.#place([str(created[0]?.filePath)], cwd);
      const from = this.#place([str(deleted[0]?.filePath)], cwd);
      plans.push({
        action: 'move',
        paths: to.paths,
        fromPaths: from.paths,
        outside: [...to.outside, ...from.outside],
        detail,
        worktree: to.worktree,
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
      worktree?: string | undefined;
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
    if (f.worktree) ev.worktree = f.worktree;
    return ev;
  }

  /**
   * The repo-relative path of an inside path, or undefined when it is outside or excluded.
   * A path in a Claude Code worktree (`.claude/worktrees/<name>/rest`) becomes `rest`, the
   * same file in the main repo, and says which worktree it came from.
   */
  #repoRel(r: ResolvedPath): { rel: string; worktree?: string } | undefined {
    if (!r.inside || r.rel === undefined) return undefined;
    const wt = splitWorktreeRel(r.rel);
    if (wt) return isAlwaysExcluded(wt.rel) ? undefined : { rel: wt.rel, worktree: wt.worktree };
    return isAlwaysExcluded(r.rel) ? undefined : { rel: r.rel };
  }

  /** Resolves candidate paths: inside -> rel (excluded dropped), outside -> absolute posix. */
  #place(inputs: (string | undefined)[], cwd: string | undefined): Placed {
    const placed: Placed = { paths: [], outside: [] };
    for (const input of inputs) {
      if (!input) continue;
      const r = this.#resolver.resolve(input, cwd);
      if (r.inside) {
        const m = this.#repoRel(r);
        if (!m) continue;
        if (!placed.paths.includes(m.rel)) placed.paths.push(m.rel);
        if (m.worktree !== undefined) placed.worktree ??= m.worktree;
      } else {
        const abs = toPosix(r.abs);
        if (!placed.outside.includes(abs)) placed.outside.push(abs);
      }
    }
    return placed;
  }

  /**
   * Like #place, split by tree: one Placed for the main repo and one per worktree, in order
   * of first appearance (main first), so a command that mixes both never tags a main-repo
   * path as a worktree one. Outside paths go with the first group. Never empty.
   */
  #placeGroups(inputs: (string | undefined)[], cwd: string | undefined): Placed[] {
    const groups = new Map<string, Placed>();
    const outside: string[] = [];
    for (const input of inputs) {
      if (!input) continue;
      const r = this.#resolver.resolve(input, cwd);
      if (!r.inside) {
        const abs = toPosix(r.abs);
        if (!outside.includes(abs)) outside.push(abs);
        continue;
      }
      const m = this.#repoRel(r);
      if (!m) continue;
      const key = m.worktree ?? '';
      let g = groups.get(key);
      if (!g) {
        g = m.worktree !== undefined ? { paths: [], outside: [], worktree: m.worktree } : { paths: [], outside: [] };
        groups.set(key, g);
      }
      if (!g.paths.includes(m.rel)) g.paths.push(m.rel);
    }
    const list = [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0)).map(([, g]) => g);
    const first = list[0];
    if (first) first.outside = outside;
    else list.push({ paths: [], outside });
    return list;
  }

  /** The Bash/tool working directory as a target: rel when inside, nothing otherwise. */
  #cwdPlace(dir: string | undefined): Placed {
    const m = this.#repoRel(this.#resolver.resolve('', dir));
    if (!m) return { paths: [], outside: [] };
    return m.worktree !== undefined ? { paths: [m.rel], outside: [], worktree: m.worktree } : { paths: [m.rel], outside: [] };
  }

  /** Resolves output paths against `base` and keeps those present in the tree index. */
  #indexed(candidates: string[], base: string | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      const m = this.#repoRel(this.#resolver.resolve(c, base));
      if (!m || m.rel === '' || seen.has(m.rel) || !this.#index.has(m.rel)) continue;
      seen.add(m.rel);
      out.push(m.rel);
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
