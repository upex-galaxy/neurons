// Spanish UI labels.
import type { Action } from '../../src/shared/types.ts';

/** Chip labels for the feed, counters and legend. */
export const ACTION_LABELS: Record<Action, string> = {
  read: 'lectura',
  search: 'búsqueda',
  edit: 'edición',
  create: 'creación',
  delete: 'borrado',
  move: 'movimiento',
  context_load: 'contexto',
  bash: 'comando',
  tool: 'herramienta',
  subagent_start: 'subagente',
  subagent_stop: 'fin de subagente',
  turn_start: 'turno',
  turn_end: 'fin de turno',
  session_start: 'sesión',
  session_end: 'fin de sesión',
  batch_end: 'lote',
  compact: 'compactación',
};

export const FAIL_LABEL = 'fallo';
export const MAIN_AGENT_LABEL = 'principal';

/** Actions shown in the legend and the counters grid. */
export const LEGEND_ACTIONS: Action[] = ['read', 'search', 'edit', 'create', 'delete', 'move', 'bash', 'context_load'];
/** Extra counters (the legend shows them too). */
export const EXTRA_COUNTER_ACTIONS: Action[] = ['subagent_start', 'turn_start'];

export const STATUS_LABELS = {
  connecting: 'Conectando…',
  open: 'Conectado',
  closed: 'Sin conexión, reintentando…',
} as const;
