// Contract shared by the server (src/server) and the browser (web/src).
// Keep it free of Node or DOM imports.

export type Action =
  | 'read'
  | 'edit'
  | 'create'
  | 'delete'
  | 'move'
  | 'search'
  | 'bash'
  | 'context_load'
  | 'subagent_start'
  | 'subagent_stop'
  | 'turn_start'
  | 'turn_end'
  | 'session_start'
  | 'session_end'
  | 'batch_end'
  | 'compact'
  | 'tool'
  | 'skill'
  | 'mcp';

export type Phase = 'pre' | 'post' | 'fail' | 'info';

/** Actions that touch files and therefore light a path in the graph. */
export const FILE_ACTIONS: readonly Action[] = [
  'read',
  'edit',
  'create',
  'delete',
  'move',
  'search',
  'bash',
  'context_load',
  'mcp',
];

/** Which kind of tool a tool event comes from. */
export interface ToolInfo {
  /** builtin: Claude Code's own tools (Read, Bash, Agent...). mcp: `mcp__<server>__<tool>`. skill: the Skill tool. */
  kind: 'builtin' | 'mcp' | 'skill';
  /** builtin: tool_name. mcp: the tool part of `mcp__<server>__<tool>`. skill: tool_input.skill. */
  name: string;
  /** mcp only: the MCP server name. */
  server?: string;
}

export interface VizEvent {
  /** Server-generated id (crypto.randomUUID). */
  id: string;
  /** Epoch ms when the server received the hook or saw the disk change. */
  ts: number;
  sessionId: string;
  promptId?: string;
  /** Present only for events emitted inside a subagent. */
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
  toolName?: string;
  phase: Phase;
  action: Action;
  /** Paths relative to the observed repo root, always with "/" separators. "" is the root itself. */
  paths: string[];
  /** For "move": the previous paths, index-aligned with `paths` when known. */
  fromPaths?: string[];
  /** Absolute paths outside the repo (skills in ~/.claude, /tmp, ...). */
  outsideRepo?: string[];
  /** Search hits or trigger files, relative to the repo root: secondary flash. */
  secondary?: string[];
  /** Short metadata: search pattern, Bash command truncated to 120 chars, load_reason. Never file content. */
  detail?: string;
  source: 'hook' | 'watcher';
  /** Disk change seen by the watcher outside any Claude tool window. */
  external?: boolean;
  /**
   * Name of the Claude Code worktree (`<root>/.claude/worktrees/<name>/`, made for a subagent
   * with isolation "worktree") the paths came from. `paths`, `fromPaths` and `secondary` were
   * rewritten to the equivalent paths in the main repo; the event never changes the tree.
   */
  worktree?: string;
  /**
   * PermissionDenied: Claude Code was not allowed to run the call (phase "fail"). The viewer
   * names it in its own language; `detail` keeps what the call was about.
   */
  denied?: boolean;
  /** Every tool event (Pre/Post/Failure/PermissionDenied): which tool it is. */
  tool?: ToolInfo;
  /** Bash: distinct program names the command runs (git, npm, gh...), at most 8. */
  cli?: string[];
  /**
   * Bash: the command, at most 2000 chars, newlines kept, with heredoc bodies cut and
   * quoted literals redacted when it writes files or runs inline code. Never file content.
   */
  command?: string;
  /** Bash and Agent: tool_input.description (Claude's own explanation), at most 300 chars. */
  description?: string;
  /** PostToolUse / PostToolUseFailure: duration_ms. */
  durationMs?: number;
  /** PostToolUseFailure: the first line of the error, at most 200 chars. */
  error?: string;
  /** Searches: grep/rg pattern, find -name glob, Glob/Grep pattern. */
  pattern?: string;
}

export type NodeKind = 'dir' | 'file';

export interface TreeEntry {
  /** Relative path with "/" separators; "" for the root. */
  path: string;
  kind: NodeKind;
}

export interface TreeSnapshot {
  /** Absolute path of the observed repo (realpath). */
  root: string;
  /** Display name, basename of root. */
  name: string;
  /** Every dir and file except the root itself, sorted by path. */
  entries: TreeEntry[];
  /** True when the scan stopped at the file cap. */
  truncated: boolean;
}

export interface SessionInfo {
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  ended: boolean;
  /**
   * Ended by `/clear` (SessionEnd reason "clear"): Claude Code went on in the same window
   * under a new session id, so this one no longer counts as a separate active session.
   */
  cleared?: boolean;
  /** agentId -> agentType for subagents seen in this session. */
  agents: Record<string, string>;
}

export type ServerMessage =
  | {
      type: 'hello';
      mode: 'live' | 'replay';
      tree: TreeSnapshot;
      /** Most recent events (ring buffer, oldest first). */
      recent: VizEvent[];
      sessions: SessionInfo[];
    }
  | { type: 'event'; event: VizEvent }
  | { type: 'tree'; added: TreeEntry[]; removed: string[] }
  | { type: 'sessions'; sessions: SessionInfo[] };

/** Recorded line in .neurons/events.jsonl. */
export type LogLine =
  | { kind: 'tree'; ts: number; tree: TreeSnapshot }
  | { kind: 'event'; event: VizEvent }
  | { kind: 'treeDelta'; ts: number; added: TreeEntry[]; removed: string[] };

export const ACTION_COLORS: Record<Action, string> = {
  read: '#22d3ee',
  search: '#3b82f6',
  edit: '#f59e0b',
  create: '#22c55e',
  delete: '#ef4444',
  move: '#f472b6',
  context_load: '#a855f7',
  bash: '#e2e8f0',
  tool: '#94a3b8',
  subagent_start: '#fde047',
  subagent_stop: '#fde047',
  turn_start: '#64748b',
  turn_end: '#64748b',
  session_start: '#64748b',
  session_end: '#64748b',
  batch_end: '#64748b',
  compact: '#c084fc',
  skill: '#fb923c',
  mcp: '#2dd4bf',
};

export const FAIL_COLOR = '#6b7280';
export const EXTERNAL_COLOR = '#475569';

export const HOOK_QUERY_MARKER = 'src=neurons';
/** Per-repo state dir (events.jsonl, lock, install manifest and backup). */
export const STATE_DIR_NAME = '.neurons';
/** State dir of the versions named repo-synapse: read for replay and migrated, never written. */
export const LEGACY_STATE_DIR_NAME = '.repo-synapse';
export const DEFAULT_PORT = 7777;
