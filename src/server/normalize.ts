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

// --- Bash command -> detail and command
// A Bash command can carry the content it writes (heredoc bodies, `echo ... > f`,
// `{ echo ...; } > f`, `python -c "open(...).write(...)"`). `command` keeps the command's
// shape and drops that content; `detail` is the first line of it. Whether the command
// writes files or runs inline code is decided once for the whole command (heredoc bodies
// left out), never line by line: a redirect, a `tee` or a `done > f` on one line can write
// the literals of another (`{`, `do`, `then` groups, a line ending in `|`). When it does,
// every quoted literal becomes "…", and so do the arguments of echo/printf/yes wherever
// that word appears (also `/bin/echo`, `\echo`, after a redirect, inside `$( )`), the
// arguments an interpreter gets after its code and awk `-v` values. Values that look like
// secrets (`*_TOKEN=`, `--api-key`, an HTTP client's `Authorization:`, known token prefixes,
// URL passwords) are redacted in every command. Best effort: a filter on the command text,
// not a shell parser.

/** Before a command name: start, an operator, a group opener or a space. */
const CMD_AT = String.raw`(?:^|[\s|;&(!{}\x60])`;
/** A command name may come with its path (`/usr/bin/tee`) or a leading `\` (`\tee`, no alias). */
const CMD_PATH = String.raw`\\?(?:[^\s|;&()<>'"\x60]*/)?`;
const TEE_RE = new RegExp(String.raw`${CMD_AT}${CMD_PATH}tee(?:\s|$)`);
const SED_INPLACE_RE = new RegExp(String.raw`${CMD_AT}${CMD_PATH}g?sed\b[^|;&]*\s(?:-[A-Za-z]*i|--in-place)`);
/** Writers fed through a pipe or in place: `sponge f`, `dd of=f`, `sd from to f`. */
const PIPE_WRITER_RE = new RegExp(String.raw`${CMD_AT}${CMD_PATH}(?:sponge(?:\s|$)|sd\s|dd\b[^|;&]*\sof=)`);
/** Content that reaches a file through stdin or a process substitution (`cp /dev/stdin f`, `cp <(printf x) f`). */
const STDIN_FILE_RE = /(?:^|[\s=])\/dev\/(?:stdin|fd\/\d+)(?![\w./-])|<\(/;
/** Interpreters and editors that run code given on their command line or stdin. */
const INTERPRETERS = String.raw`python[\d.]*|pypy[\d.]*|py|node|nodejs|deno|bun|tsx|ts-node|perl|ruby|php|lua(?:jit)?|rscript|swift|julia|groovy|bash|sh|zsh|dash|ksh|fish|osascript|pwsh|powershell|cmd|vim?|nvim|ex`;
const INTERPRETER_NAME_RE = new RegExp(String.raw`^(?:${INTERPRETERS})(?:\.exe)?$`, 'i');
/** The flag (or subcommand) after which an interpreter's arguments are code: -c, -e, -pe, --eval, -Command, /c, eval. */
const CODE_FLAG_RE = /^(?:-(?:[a-z]*[cepr]|-?(?:eval|print|exec(?:ute)?)|-?[a-z]*command)|\/[ck]|eval)$/i;
/**
 * Interpreter with inline code: python -c, node -e/-p/--eval, perl -pe/-nE, php -r,
 * Rscript/lua/swift/julia -e, pwsh/powershell -c/-Command/-EncodedCommand, cmd /c,
 * bash -c, vim -c, ex -sc, deno eval... Flags in any case.
 */
const INLINE_CODE_RE = new RegExp(
  String.raw`(?:^|[\s|;&(/\\\x60])(?:(?:${INTERPRETERS})(?:\.exe)?\b[^|;&]*?\s(?:-(?:[a-z]*[cepr]\b|-?(?:eval|print|exec(?:ute)?)\b|-?[a-z]*command\b)|\/[ck]\b)|(?:deno|bun)\s+eval\b)`,
  'i',
);
/** Code piped into an interpreter that reads its program from stdin (`echo '...' | python3`, `| ed f`). */
const STDIN_CODE_RE = new RegExp(
  String.raw`\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?${CMD_PATH}(?:(?:${INTERPRETERS})(?:\.exe)?(?:\s+-[A-Za-z-]*)*\s*(?:$|[|;&)\n])|(?:ed|ex)\b)`,
  'i',
);

function runsInlineCode(s: string): boolean {
  return INLINE_CODE_RE.test(s) || STDIN_CODE_RE.test(s);
}
const REDACTED = '…';

/**
 * True when `s` sends output to a file: `>`, `>>`, `>|`, `&>`, `&>>`, `1>`, `>&file`, and a
 * `>` glued to a word (`PORT=3000>.env` writes `PORT=3000`), and `>&3` and up (a descriptor
 * opened on a file, `exec 3>f`). Not an fd of its own (`2>`, `3>>`), a duplication (`>&2`,
 * `2>&1`, `>&-`) or `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`.
 */
export function writesRedirect(s: string): boolean {
  for (let i = s.indexOf('>'); i !== -1; i = s.indexOf('>', i + 1)) {
    const prev = s[i - 1];
    if (prev === '>' || prev === '<') continue; // the second `>` of `>>`, or `<>` (stdin)
    let k = i;
    while (k > 0 && /\d/.test(s[k - 1] as string)) k--;
    // A whole word of digits is an fd number: only 1 is stdout.
    if (k < i && (k === 0 || /[\s;&|(){}]/.test(s[k - 1] as string)) && s.slice(k, i) !== '1') continue;
    let j = i + 1;
    if (s[j] === '>') j++;
    if (s[j] === '|') j++;
    if (s[j] === '&') {
      const fd = /^\d+/.exec(s.slice(j + 1, j + 12))?.[0];
      // >&2, >&-: a duplication. >&3 and up: a descriptor opened earlier (`exec 3>f`), so a file.
      if (fd !== undefined && Number(fd) >= 3) return true;
      if (fd !== undefined || s[j + 1] === '-') continue;
      j++;
    }
    while (s[j] === ' ' || s[j] === '\t') j++;
    const rest = s.slice(j);
    if (rest === '' || /^[\s&|;]/.test(rest)) continue;
    if (/^\/dev\/(?:null|stdout|stderr|tty)(?![\w./-])/.test(rest)) continue;
    return true;
  }
  return false;
}

function writesFiles(s: string): boolean {
  return writesRedirect(s) || TEE_RE.test(s) || SED_INPLACE_RE.test(s) || PIPE_WRITER_RE.test(s) || STDIN_FILE_RE.test(s);
}

/** Index of a quote that is never closed on this line, or -1 (`$'..'` honors `\'`). */
function unterminatedQuote(s: string): number {
  let quote: string | undefined;
  let ansi = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === undefined) {
      if (c === '\\') i++;
      else if (c === "'" || c === '"') {
        quote = c;
        ansi = c === "'" && s[i - 1] === '$';
        start = i;
      }
    } else if ((quote === '"' || ansi) && c === '\\') i++;
    else if (c === quote) quote = undefined;
  }
  return quote === undefined ? -1 : start;
}

/**
 * A Bash command reduced to a one-line detail without the content it may write: the first
 * line of bashCommand (so the same whole-command redaction), a literal that goes on past
 * that line cut at its quote, and "…" when more lines follow.
 */
export function bashDetail(command: string): string {
  let s = bashCommand(command).replace(/\\\n/g, ' ');
  let dropped = false;
  const nl = s.indexOf('\n');
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
  return shortDetail(dropped ? `${s} ${REDACTED}` : s);
}

// --- Bash command -> command (multi-line)
// The full command for the detail panel: heredoc bodies are cut (a "…" line stands for
// each), statements are split at newlines outside quotes and $( ) only to cut a literal
// never closed at its opening quote, and the write / inline-code decision covers the whole
// command (see above).

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

/** Commands whose arguments are the text they print. */
const PRINTERS = new Set(['echo', 'printf', 'yes']);
/** Redirect operator at a word start, with an fd (`2>`) or `{var}` before it; not `<(`/`>(`. */
const REDIRECT_RE = /(?:\d+|\{[A-Za-z_]\w*\})?(?:&>>?|>>|>\||>&|<<<|<<-?|<&|<>|>|<)(?!\()/y;
/** Control operators (a `&` before `>` is the `&>` redirect). */
const OPERATOR_RE = /\|\||&&|;;|\|&|[|;\n)]|&(?!>)/y;

/** The command name a word stands for: no leading `\`, no directory (`/bin/echo` is echo). */
function commandName(word: string): string {
  const w = word.startsWith('\\') ? word.slice(1) : word;
  return w.slice(w.lastIndexOf('/') + 1);
}

/** A literal redactQuoted already reduced to its quotes. */
function isRedactedLiteral(word: string): boolean {
  return word === `'${REDACTED}'` || word === `"${REDACTED}"` || word === `$'${REDACTED}'`;
}

/**
 * Reads one shell word at `i` (quotes, `$( )`, `<( )`, backticks, `${ }` and escapes
 * included). `inner` is the word with the commands inside its substitutions redacted too.
 */
function readWord(s: string, i: number, inline: boolean): { end: number; inner: string } {
  let j = i;
  let inner = '';
  while (j < s.length) {
    const c = s[j] as string;
    const next = s[j + 1];
    if (c === ' ' || c === '\t' || c === '\n' || c === '|' || c === ';' || c === '&' || c === ')') break;
    if ((c === '<' || c === '>') && next !== '(') break;
    if (c === '\\') {
      if (next === '\n') break; // a line continuation separates words
      inner += s.slice(j, j + 2);
      j += 2;
    } else if (c === "'") {
      const k = skipSingle(s, j, s[j - 1] === '$');
      inner += s.slice(j, k);
      j = k;
    } else if (c === '"') {
      const k = skipDouble(s, j);
      inner += s.slice(j, k);
      j = k;
    } else if (c === '`') {
      let k = j + 1;
      while (k < s.length && s[k] !== '`') k += s[k] === '\\' ? 2 : 1;
      inner += '`' + redactArgs(s.slice(j + 1, Math.min(k, s.length)), inline) + (k < s.length ? '`' : '');
      j = k + 1;
    } else if (next === '(' && (c === '$' || c === '<' || c === '>')) {
      const k = skipParen(s, j + 1);
      const closed = s[k - 1] === ')';
      inner += c + '(' + redactArgs(s.slice(j + 2, closed ? k - 1 : k), inline) + (closed ? ')' : '');
      j = k;
    } else if (c === '(') {
      const k = skipParen(s, j);
      inner += s.slice(j, k);
      j = k;
    } else if (c === '$' && next === '{') {
      const k = s.indexOf('}', j);
      const stop = k === -1 ? s.length : k + 1;
      inner += s.slice(j, stop);
      j = stop;
    } else {
      inner += c;
      j++;
    }
  }
  return { end: j, inner };
}

/**
 * In a command that writes files or runs inline code: the arguments of echo/printf/yes
 * (wherever that word appears, `/bin/echo` and `\echo` too) up to the next operator, the
 * arguments an interpreter gets after its code (`python3 -c '…' f DATA`, `sh -c '…' _ DATA`)
 * when `inline`, and `-v name=value` values (awk). Redirects and their targets stay; a run
 * of redacted words becomes one "…". Commands inside `$( )`, `<( )` and backticks get the
 * same treatment.
 */
function redactArgs(s: string, inline: boolean): string {
  let out = '';
  let ws = '';
  let i = 0;
  /** none: a command or its plain args; print: printer args; interp: an interpreter's options; code: after its code flag. */
  let mode: 'none' | 'print' | 'interp' | 'code' = 'none';
  let lastRedacted = false;
  let prevWord = '';
  const emit = (text: string, redacted: boolean): void => {
    if (redacted && lastRedacted) {
      ws = '';
      return;
    }
    out += ws + text;
    ws = '';
    lastRedacted = redacted;
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (c === ' ' || c === '\t') {
      ws += c;
      i++;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      ws += '\\\n';
      i += 2;
      continue;
    }
    REDIRECT_RE.lastIndex = i;
    const redirect = REDIRECT_RE.exec(s);
    if (redirect) {
      // The operator and its target stay as typed.
      emit(redirect[0], false);
      i = REDIRECT_RE.lastIndex;
      while (s[i] === ' ' || s[i] === '\t') ws += s[i++];
      OPERATOR_RE.lastIndex = i;
      if (i < s.length && !OPERATOR_RE.test(s)) {
        const w = readWord(s, i, inline);
        emit(w.inner, false);
        i = w.end;
      }
      continue;
    }
    OPERATOR_RE.lastIndex = i;
    const op = OPERATOR_RE.exec(s);
    if (op) {
      emit(op[0], false);
      i = OPERATOR_RE.lastIndex;
      mode = 'none';
      prevWord = '';
      continue;
    }
    if (c === '(') {
      // A subshell: a command starts inside it.
      emit('(', false);
      i++;
      mode = 'none';
      prevWord = '';
      continue;
    }
    const raw = readWord(s, i, inline);
    if (raw.end === i) {
      // Not a word start (never expected): keep the char and move on.
      emit(c, false);
      i++;
      continue;
    }
    const word = s.slice(i, raw.end);
    i = raw.end;
    if (mode === 'print') {
      emit(REDACTED, true);
    } else if (mode === 'code') {
      if (isRedactedLiteral(word)) emit(word, false);
      else emit(REDACTED, true);
    } else {
      const assign = /^(-v|--assign)$/.test(prevWord) ? /^([A-Za-z_]\w*=)./.exec(word) : null;
      emit(assign ? `${assign[1]}${REDACTED}` : raw.inner, false);
      const name = commandName(word);
      if (PRINTERS.has(name)) mode = 'print';
      else if (mode === 'interp' && CODE_FLAG_RE.test(word)) mode = 'code';
      else if (inline && INTERPRETER_NAME_RE.test(name)) mode = 'interp';
    }
    prevWord = word;
  }
  return out + ws;
}

/** A variable name that says secret (GITHUB_TOKEN, DB_PASSWORD, STRIPE_KEY, api_key). */
const SECRET_VAR = String.raw`[A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pwd|api_?key|_key|credentials?|auth(?!or))[A-Za-z0-9_]*`;
/** A flag name that says secret (--api-key, --auth-token, --password); `--primary-key` and `--sort-key` do not. */
const SECRET_FLAG = String.raw`[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|(?:access|secret|client|app|master|license|signing|encryption|service|account|session)[_-]key|credentials?|auth(?!or))[A-Za-z0-9_-]*`;
const SECRET_VALUE = String.raw`(?:\$'(?:[^'\\]|\\.)*'|'[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|<>()'"]+)+`;
/** NAME=value whose name says secret (GITHUB_TOKEN=, DB_PASSWORD=, ?api_key=). */
const SECRET_ASSIGN_RE = new RegExp(String.raw`(^|[\s;&|(?"'\x60])(${SECRET_VAR})=${SECRET_VALUE}`, 'gi');
/** --name=value whose name says secret (--api-key=, --password=). */
const SECRET_FLAG_ASSIGN_RE = new RegExp(String.raw`((?:^|\s)--?${SECRET_FLAG})=${SECRET_VALUE}`, 'gi');
/** --token value, -password value. */
const SECRET_FLAG_RE = new RegExp(String.raw`((?:^|\s)--?${SECRET_FLAG})([ \t]+)(?!-)${SECRET_VALUE}`, 'gi');
/** An HTTP client at a command position: only its arguments carry request headers. */
const HTTP_CLIENT_RE = new RegExp(String.raw`(?:^|[|;&(\n\x60]|\$\()\s*(?:(?:sudo|time|command|exec|xargs|env)\s+(?:-\S+\s+|\w+=\S*\s+)*)*${CMD_PATH}(?:curl|wget|xh|xhs|https?|httpie|grpcurl|aria2c)(?:\s|$)`);
/** Authorization: Bearer x, X-Api-Key: x, Cookie: x (to the end of the literal), in an HTTP client's arguments. */
const SECRET_HEADER_RE = /\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|private-token|cookie)(\s*:\s*)[^"'\n]+/gi;
/** `Bearer <token>` / `Basic <base64>` anywhere; the value must look like one (a digit or symbol, not a plain word). */
const BEARER_RE = /\b(bearer|basic)(\s+)(?=[A-Za-z._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi;
/** scheme://user:password@host */
const URL_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:)[^\s@/"']+@/gi;
/** curl -u user:password */
const USER_PASSWORD_RE = /((?:^|\s)(?:-u|--user)\s+[^\s:"']+:)[^\s"']+/g;
/** Well-known token shapes (GitHub, OpenAI/Anthropic, Stripe, Slack, AWS, Google, GitLab). */
const TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,})/g;

/** Values that look like secrets, in any command (best effort). */
export function redactSecrets(s: string): string {
  let out = s
    .replace(SECRET_ASSIGN_RE, (_m, pre: string, name: string) => `${pre}${name}=${REDACTED}`)
    .replace(SECRET_FLAG_ASSIGN_RE, (_m, flag: string) => `${flag}=${REDACTED}`)
    .replace(SECRET_FLAG_RE, (_m, flag: string, sp: string) => `${flag}${sp}${REDACTED}`);
  if (HTTP_CLIENT_RE.test(out)) out = out.replace(SECRET_HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  return out
    .replace(BEARER_RE, (_m, word: string, sp: string) => `${word}${sp}${REDACTED}`)
    .replace(URL_PASSWORD_RE, (_m, pre: string) => `${pre}${REDACTED}@`)
    .replace(USER_PASSWORD_RE, (_m, pre: string) => `${pre}${REDACTED}`)
    .replace(TOKEN_RE, REDACTED);
}

function redactStatement(stmt: string, writes: boolean, inline: boolean): string {
  let s = stmt;
  if (writes || inline) s = redactQuoted(s);
  s = redactHereStrings(s);
  if (writes || inline) s = redactArgs(s, inline);
  return redactSecrets(s);
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
    parts.push(buf);
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
  // One decision for the whole command (heredoc bodies are already "…").
  const flat = parts.join('\n').replace(/\\\n/g, ' ');
  const writes = writesFiles(flat);
  const inline = runsInlineCode(flat);
  const out = parts
    .map((part) => redactStatement(part, writes, inline))
    .join('\n')
    .replace(/^\n+|\s+$/g, '');
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
