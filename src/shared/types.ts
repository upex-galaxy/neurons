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
  | 'tool';

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
];

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
};

export const FAIL_COLOR = '#6b7280';
export const EXTERNAL_COLOR = '#475569';

export const HOOK_QUERY_MARKER = 'src=neurons';
/** Per-repo state dir (events.jsonl, lock, install manifest and backup). */
export const STATE_DIR_NAME = '.neurons';
/** State dir of the versions named repo-synapse: read for replay and migrated, never written. */
export const LEGACY_STATE_DIR_NAME = '.repo-synapse';
export const DEFAULT_PORT = 7777;
