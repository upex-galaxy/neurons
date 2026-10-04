// Claude Code hook payload -> VizEvent[].
// Only paths and short metadata leave this module: file contents, diffs, stdout
// text and tool responses are read (for paths) and dropped.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Action, Phase, SessionInfo, ToolInfo, VizEvent } from '../shared/types.ts';
import { bashPrograms, classifyBash, extractPathsFromOutput, type BashClassification } from './bash.ts';
import { splitWorktreeRel, toPosix, type PathResolver, type ResolvedPath } from './paths.ts';
import { isAlwaysExcluded, type TreeIndex } from './tree.ts';
import { t } from '../i18n.ts';

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
const COMMAND_MAX = 2000;
const DESCRIPTION_MAX = 300;
const ERROR_MAX = 200;
const PATTERN_MAX = 200;
/** Cap for per-tool_use_id memory (Pre seen, Post never arrived). */
const PENDING_MAX = 2000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Collapses whitespace to one line and truncates to `max` chars (default 120). */
export function shortDetail(s: string, max = DETAIL_MAX): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/**
 * The first non-empty line of a tool error, without Claude Code's wrapper tags
 * (`<tool_use_error>`), at most 200 chars. The lines after it (stderr, the string an Edit
 * did not find) never leave the server.
 */
export function errorLine(error: string): string | undefined {
  for (const raw of error.split(/\r?\n/)) {
    const line = raw.replace(/<\/?[a-z][a-z0-9_-]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    if (line !== '') return line.length > ERROR_MAX ? line.slice(0, ERROR_MAX - 1) + '…' : line;
  }
  return undefined;
}

/**
 * Tool identity from tool_name: `Skill` (with tool_input.skill), `mcp__<server>__<tool>`
 * (server from the payload's mcp_server.name when present, since tool names carry it
 * normalized), or a builtin.
 */
export function toolInfo(toolName: string, input: Record<string, unknown>, mcpServer: unknown): ToolInfo {
  // "?" (no word, so no language) when the payload does not name the skill, as for MCP servers.
  if (toolName === 'Skill') return { kind: 'skill', name: str(input.skill) ?? '?' };
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const named = str(obj(mcpServer)?.name);
    if (named) {
      const prefix = named.replace(/[^A-Za-z0-9_-]/g, '_') + '__';
      const sep = rest.indexOf('__');
      const name = rest.startsWith(prefix) ? rest.slice(prefix.length) : sep > 0 ? rest.slice(sep + 2) : rest;
      return { kind: 'mcp', name: name || rest, server: named };
    }
    const sep = rest.indexOf('__');
    if (sep > 0) return { kind: 'mcp', name: rest.slice(sep + 2) || rest, server: rest.slice(0, sep) };
    return { kind: 'mcp', name: rest, server: rest };
  }
  return { kind: 'builtin', name: toolName };
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
 * label in the server's language (src/i18n), never their raw text. A typed prompt keeps its first 120 chars without tags.
 */
export function promptDetail(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  const injected = INJECTED_PROMPT_RE.exec(trimmed);
  if (injected) return t(injected[1] === 'task-notification' ? 'event.taskNotification' : 'event.systemNotification');
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

// --- Bash command -> command (multi-line)
// The full command for the detail panel, under the same rule as bashDetail: heredoc bodies
// are cut (a "…" line stands for each), and in a statement that writes files or runs
// inline code every quoted literal becomes "…", echo/printf arguments too. Statements are
// split at newlines outside quotes and $( ), so a literal spanning lines is judged with
// the redirect that follows it. A literal never closed is cut at its opening quote.

type ShellCtx = "'" | '"' | '$(' | '(' | '`';

/** End (exclusive) of the double-quoted literal that opens at `i`. */
function skipDouble(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === '"') return j + 1;
    else if (c === '$' && s[j + 1] === '(') j = skipParen(s, j + 1);
    else if (c === '`') {
      j++;
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
      j++;
    } else j++;
  }
  return s.length;
}

/** End (exclusive) of the parenthesized group that opens at `i` (s[i] === '('). */
function skipParen(s: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === "'") {
      const k = s.indexOf("'", j + 1);
      j = k === -1 ? s.length : k + 1;
      continue;
    }
    if (c === '"') {
      j = skipDouble(s, j);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return s.length;
}

/** End (exclusive) of the single-quoted literal at `i`; `ansi` for $'...' (backslash escapes). */
function skipSingle(s: string, i: number, ansi: boolean): number {
  let j = i + 1;
  while (j < s.length) {
    if (ansi && s[j] === '\\') j += 2;
    else if (s[j] === "'") return j + 1;
    else j++;
  }
  return s.length;
}

/** Every quoted literal ('...', $'...', "...", across lines) reduced to its quotes around "…". */
function redactQuoted(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
    } else if (c === "'") {
      i = skipSingle(s, i, out.endsWith('$'));
      out += `'${REDACTED}'`;
    } else if (c === '"') {
      i = skipDouble(s, i);
      out += `"${REDACTED}"`;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `cmd <<< word`: the word (quoted or not) is stdin content. */
function redactHereStrings(s: string): string {
  let out = '';
  let i = 0;
  for (let k = s.indexOf('<<<', i); k !== -1; k = s.indexOf('<<<', i)) {
    out += s.slice(i, k) + `<<< ${REDACTED}`;
    let j = k + 3;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] === "'") j = skipSingle(s, j, s[j - 1] === '$');
    else if (s[j] === '"') j = skipDouble(s, j);
    else if (s[j] === '$' && s[j + 1] === "'") j = skipSingle(s, j + 1, true);
    else while (j < s.length && !/\s/.test(s[j] as string)) j++;
    i = j;
  }
  return out + s.slice(i);
}

function redactStatement(stmt: string): string {
  let s = stmt;
  const flat = s.replace(/\\\n/g, ' ');
  const writes = WRITE_REDIRECT_RE.test(flat) || TEE_RE.test(flat) || SED_INPLACE_RE.test(flat);
  if (writes || INLINE_CODE_RE.test(flat)) s = redactQuoted(s);
  s = redactHereStrings(s);
  if (writes) {
    s = s
      .split(/(\|\||&&|[|;&])/)
      .map((seg) =>
        seg.replace(/^(\s*(?:sudo\s+)?(?:echo|printf))((?:[ \t]+[^\s<>|;&]+)+)/, (_m, cmd: string) => `${cmd} ${REDACTED}`),
      )
      .join('');
  }
  return s;
}

/** A Bash command for display: newlines kept, at most 2000 chars, without the content it writes. */
export function bashCommand(command: string): string {
  const s = command.replace(/\r\n?/g, '\n');
  const parts: string[] = [];
  /** `ansi`: a $'...' literal, where a backslash escapes the next char (even a quote). */
  const stack: { ctx: ShellCtx; at: number; ansi?: boolean }[] = [];
  const heredocs: { delim: string; strip: boolean }[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    const open = stack[0];
    // A literal or substitution never closed swallows the rest: keep only its opener.
    if (open) buf = buf.slice(0, open.at + open.ctx.length) + REDACTED;
    parts.push(redactStatement(buf));
    buf = '';
    stack.length = 0;
  };
  while (i < s.length) {
    const c = s[i] as string;
    const next = s[i + 1];
    const top = stack.at(-1)?.ctx;
    if (c === '\n') {
      buf += '\n';
      i++;
      // Heredoc bodies start on the next line, wherever the operator was (even inside "$( )").
      for (const doc of heredocs.splice(0)) {
        let closed = false;
        while (i < s.length) {
          const end = s.indexOf('\n', i);
          const line = s.slice(i, end === -1 ? s.length : end);
          i = end === -1 ? s.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) {
            buf += `${REDACTED}\n${line}\n`;
            closed = true;
            break;
          }
        }
        if (!closed) buf += `${REDACTED}\n`;
      }
      if (stack.length === 0) {
        buf = buf.replace(/\n+$/, '');
        flush();
      }
      continue;
    }
    if (top === "'") {
      if (c === '\\' && stack.at(-1)?.ansi) {
        buf += c + (next ?? '');
        i += 2;
        continue;
      }
      buf += c;
      i++;
      if (c === "'") stack.pop();
      continue;
    }
    if (c === '\\') {
      buf += c + (next ?? '');
      i += 2;
      continue;
    }
    if (top === '"') {
      if (c === '"') stack.pop();
      else if (c === '$' && next === '(') {
        stack.push({ ctx: '$(', at: buf.length });
        buf += '$(';
        i += 2;
        continue;
      } else if (c === '`') stack.push({ ctx: '`', at: buf.length });
      buf += c;
      i++;
      continue;
    }
    if (c === '#' && (buf === '' || /[\s;&|()]$/.test(buf))) {
      // A comment runs to the end of the line; its quotes are not quotes.
      const end = s.indexOf('\n', i);
      const stop = end === -1 ? s.length : end;
      buf += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'") {
      stack.push(buf.endsWith('$') ? { ctx: c, at: buf.length, ansi: true } : { ctx: c, at: buf.length });
    } else if (c === '"') {
      stack.push({ ctx: c, at: buf.length });
    } else if (c === '`') {
      if (top === '`') stack.pop();
      else stack.push({ ctx: '`', at: buf.length });
    } else if (c === '$' && next === '(') {
      stack.push({ ctx: '$(', at: buf.length });
      buf += '$(';
      i += 2;
      continue;
    } else if (c === '(') {
      stack.push({ ctx: '(', at: buf.length });
    } else if (c === ')') {
      if (top === '(' || top === '$(') stack.pop();
    } else if (c === '<' && next === '<' && s[i + 2] !== '<') {
      // Heredoc operator: << or <<-, then the delimiter word (quotes removed).
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let delim = '';
      while (j < s.length && !/[\s;&|<>()]/.test(s[j] as string)) {
        const d = s[j] as string;
        if (d === "'" || d === '"') {
          const k = s.indexOf(d, j + 1);
          const end = k === -1 ? s.length : k;
          delim += s.slice(j + 1, end);
          j = end + 1;
        } else if (d === '\\') {
          delim += s[j + 1] ?? '';
          j += 2;
        } else {
          delim += d;
          j++;
        }
      }
      if (delim !== '') heredocs.push({ delim, strip });
      buf += s.slice(i, Math.min(j, s.length));
      i = j;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf !== '' || stack.length > 0) flush();
  const out = parts.join('\n').replace(/^\n+|\s+$/g, '');
  return out.length > COMMAND_MAX ? out.slice(0, COMMAND_MAX - 1) + '…' : out;
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
    const toolName = str(p.tool_name) ?? '?';
    const toolUseId = str(p.tool_use_id);
    const input = obj(p.tool_input) ?? {};
    const response = obj(p.tool_response);
    const cwd = str(p.cwd);
    const phase: Phase =
      eventName === 'PreToolUse' ? 'pre' : eventName === 'PostToolUse' ? 'post' : 'fail';
    const denied = eventName === 'PermissionDenied';
    const finished = phase !== 'pre';
    const tool = toolInfo(toolName, input, p.mcp_server);

    // Metadata shared by every event of this payload. Never file content: the command is
    // redacted, the error keeps its first line only.
    const extra: Pick<VizEvent, 'cli' | 'command' | 'description' | 'durationMs' | 'error' | 'pattern'> = {};
    const duration = p.duration_ms;
    if (finished && !denied && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      extra.durationMs = Math.round(duration);
    }
    if (eventName === 'PostToolUseFailure' && typeof p.error === 'string') {
      const line = errorLine(p.error);
      if (line) extra.error = line;
    }

    const base = { toolName, toolUseId };
    const emit = (plan: ToolPlan): VizEvent => {
      const ev = this.#event(p, ts, {
        action: plan.action,
        phase,
        paths: plan.paths,
        outside: plan.outside,
        detail: plan.detail,
        secondary: plan.secondary,
        fromPaths: plan.fromPaths,
        worktree: plan.worktree,
      });
      ev.toolName = base.toolName;
      if (base.toolUseId) ev.toolUseId = base.toolUseId;
      // The viewer words it in its own language (never a fixed English word in `detail`).
      if (denied) ev.denied = true;
      ev.tool = { ...tool };
      if (extra.cli) ev.cli = [...extra.cli];
      if (extra.command !== undefined) ev.command = extra.command;
      if (extra.description !== undefined) ev.description = extra.description;
      if (extra.pattern !== undefined) ev.pattern = extra.pattern;
      if (extra.durationMs !== undefined) ev.durationMs = extra.durationMs;
      if (extra.error !== undefined) ev.error = extra.error;
      return ev;
    };
    const describe = (): void => {
      const desc = str(input.description);
      const d = desc && shortDetail(desc, DESCRIPTION_MAX);
      if (d) extra.description = d;
    };
    const searchPattern = (pattern: string | undefined): void => {
      const pat = pattern && shortDetail(pattern, PATTERN_MAX);
      if (pat) extra.pattern = pat;
    };

    if (tool.kind === 'skill') {
      return [emit({ action: 'skill', paths: [], outside: [], detail: shortDetail(tool.name) })];
    }
    if (tool.kind === 'mcp') {
      const placed = this.#genericPlace(input, cwd);
      return [emit({ action: 'mcp', ...placed, detail: shortDetail(`${tool.server ?? '?'}/${tool.name}`) })];
    }

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
        searchPattern(str(input.pattern));
        return [emit(this.#globGrep(input, response, cwd, phase))];
      case 'Bash': {
        const command = str(input.command);
        if (command) {
          const programs = bashPrograms(command);
          if (programs.length > 0) extra.cli = programs;
          const shown = bashCommand(command);
          if (shown !== '') extra.command = shown;
        }
        describe();
        const { plans, cls } = this.#bash(input, response, cwd, phase, toolUseId, finished);
        if (cls.kind === 'search' || cls.kind === 'delete') searchPattern(cls.pattern);
        return plans.map(emit);
      }
      case 'Agent':
      case 'Task': {
        describe();
        const desc = str(input.description);
        return [emit({ action: 'tool', paths: [], outside: [], detail: desc && shortDetail(desc) })];
      }
      default:
        return [emit({ action: 'tool', ...this.#genericPlace(input, cwd) })];
    }
  }

  /** file_path (inside or outside the repo) or, failing that, a `path` inside it. */
  #genericPlace(input: Record<string, unknown>, cwd: string | undefined): Placed {
    const filePath = str(input.file_path);
    if (filePath) return this.#place([filePath], cwd);
    const generic = str(input.path);
    return generic ? { ...this.#place([generic], cwd), outside: [] } : { paths: [], outside: [] };
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
  ): { plans: ToolPlan[]; cls: BashClassification } {
    const command = str(input.command) ?? '';
    let cls = toolUseId ? this.#bashPre.get(toolUseId) : undefined;
    if (!cls) cls = classifyBash(command);
    if (phase === 'pre' && toolUseId) this.#remember(this.#bashPre, toolUseId, cls);
    if (finished && toolUseId) this.#bashPre.delete(toolUseId);
    return { plans: this.#bashPlansFor(cls, command, response, cwd, phase, toolUseId, finished), cls };
  }

  #bashPlansFor(
    cls: BashClassification,
    command: string,
    response: Record<string, unknown> | undefined,
    cwd: string | undefined,
    phase: Phase,
    toolUseId: string | undefined,
    finished: boolean,
  ): ToolPlan[] {
    const detail = command ? bashDetail(command) : undefined;

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
