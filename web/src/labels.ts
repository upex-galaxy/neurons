// UI labels looked up in the i18n dictionaries, plus which actions the panel lists.
import type { Action, Phase } from '../../src/shared/types.ts';
import { t } from './i18n.ts';
import type { ConnectionStatus } from './ws.ts';

/** Chip label for the feed, counters and legend. */
export function actionLabel(action: Action): string {
  return t(`action.${action}`);
}

export function failLabel(): string {
  return t('feed.fail');
}

/** Tag next to a feed path that a subagent touched in its own worktree. */
export function worktreeLabel(): string {
  return t('feed.worktree');
}

type DetailFields = { detail?: string | undefined; denied?: boolean | undefined; phase: Phase };

/**
 * True for a PermissionDenied call: the `denied` flag, or, in logs written before 0.3, a
 * failure whose `detail` is the fixed word "denied".
 */
export function isDenied(e: DetailFields): boolean {
  return !!e.denied || (e.phase === 'fail' && e.detail === 'denied');
}

/** `detail` without the old fixed "denied" word (logs written before 0.3). */
export function plainDetail(e: DetailFields): string | undefined {
  return e.phase === 'fail' && e.detail === 'denied' ? undefined : e.detail;
}

/** The detail as the feed shows it: "denied · <detail>" for a refused call, in the UI language. */
export function shownDetail(e: DetailFields): string | undefined {
  const detail = plainDetail(e);
  if (!isDenied(e)) return detail;
  return detail ? t('feed.deniedDetail', { detail }) : t('feed.denied');
}

export function phaseLabel(phase: Phase): string {
  return t(`phase.${phase}`);
}

export function statusLabel(status: ConnectionStatus): string {
  return t(`status.${status}`);
}

/** Actions shown in the legend and the counters grid. */
export const LEGEND_ACTIONS: Action[] = ['read', 'search', 'edit', 'create', 'delete', 'move', 'bash', 'context_load', 'skill', 'mcp'];
/** Extra counters (the legend shows them too). */
export const EXTRA_COUNTER_ACTIONS: Action[] = ['subagent_start', 'turn_start'];

/** Actions that add a line to the floating "now" stream. */
export const STREAM_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'read',
  'edit',
  'create',
  'delete',
  'move',
  'search',
  'context_load',
  'skill',
  'mcp',
]);
