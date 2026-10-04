// Tool counters of the panel's "Tools" section: skills, MCP servers and their tools, CLI
// programs run through Bash and Claude's built-in tools. Pure (no DOM) for unit tests.
import type { VizEvent } from '../../src/shared/types.ts';

export type ToolKind = 'builtin' | 'mcp' | 'skill';

export interface ToolRef {
  kind: ToolKind;
  name: string;
  server?: string;
}

/** mcp__<server>__<tool>; the server name may itself contain "_" but never "__". */
const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * The tool an event came from: `event.tool` when the server sent it, otherwise derived from
 * `toolName` (older logs). Undefined for events that are not tool calls (watcher, turns).
 */
export function toolOf(event: Pick<VizEvent, 'tool' | 'toolName' | 'detail' | 'action'>): ToolRef | undefined {
  if (event.tool?.name) return event.tool;
  const name = event.toolName;
  if (!name) return undefined;
  const m = MCP_NAME.exec(name);
  if (m) return { kind: 'mcp', server: m[1]!, name: m[2]! };
  if (name === 'Skill') return event.detail ? { kind: 'skill', name: event.detail } : undefined;
  return { kind: 'builtin', name };
}

export interface ToolTally {
  skills: Map<string, number>;
  /** server -> tool -> count. */
  mcp: Map<string, Map<string, number>>;
  cli: Map<string, number>;
  builtin: Map<string, number>;
  /**
   * Calls already counted (`session:toolUseId`), oldest first. The server splits one call
   * into several events (one per file of a multi-file Bash, one per worktree), and they all
   * carry the same tool: the call counts once. Bounded, since those events arrive together.
   */
  seen: Set<string>;
}

/** How many counted call ids a tally remembers. */
export const SEEN_CALLS_LIMIT = 4096;

export function emptyTally(): ToolTally {
  return { skills: new Map(), mcp: new Map(), cli: new Map(), builtin: new Map(), seen: new Set() };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Counts finished calls only (post and fail): a pre is always followed by one of them. */
export function countsTool(event: Pick<VizEvent, 'phase'>): boolean {
  return event.phase === 'post' || event.phase === 'fail';
}

/** True the first time a call shows up; events without a toolUseId always count. */
function firstOfCall(tally: ToolTally, event: VizEvent): boolean {
  if (!event.toolUseId) return true;
  const key = `${event.sessionId}:${event.toolUseId}`;
  if (tally.seen.has(key)) return false;
  tally.seen.add(key);
  if (tally.seen.size > SEEN_CALLS_LIMIT) tally.seen.delete(tally.seen.values().next().value as string);
  return true;
}

export function tallyEvent(tally: ToolTally, event: VizEvent): void {
  if (!countsTool(event) || !firstOfCall(tally, event)) return;
  const tool = toolOf(event);
  if (tool) {
    if (tool.kind === 'skill') bump(tally.skills, tool.name);
    else if (tool.kind === 'mcp') {
      const server = tool.server || '?';
      let tools = tally.mcp.get(server);
      if (!tools) {
        tools = new Map();
        tally.mcp.set(server, tools);
      }
      bump(tools, tool.name);
    } else bump(tally.builtin, tool.name);
  }
  for (const prog of new Set(event.cli ?? [])) bump(tally.cli, prog);
}

export interface ToolsSnapshot {
  skills: Record<string, number>;
  mcp: Record<string, Record<string, number>>;
  cli: Record<string, number>;
  builtin: Record<string, number>;
}

export function snapshotTally(tally: ToolTally): ToolsSnapshot {
  const mcp: Record<string, Record<string, number>> = {};
  for (const [server, tools] of tally.mcp) mcp[server] = Object.fromEntries(tools);
  return {
    skills: Object.fromEntries(tally.skills),
    mcp,
    cli: Object.fromEntries(tally.cli),
    builtin: Object.fromEntries(tally.builtin),
  };
}

/** Entries by count (desc), then name, for display. */
export function sortedCounts(map: ReadonlyMap<string, number>): Array<[string, number]> {
  return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Total of a server's tools. */
export function serverTotal(tools: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const v of tools.values()) n += v;
  return n;
}
