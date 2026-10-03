// Side panel (Spanish UI): live feed, counters, filters, view toggle, session tint and legend.
import { ACTION_COLORS, EXTERNAL_COLOR, FAIL_COLOR, type Action } from '../../src/shared/types.ts';
import { agentColor, agentType, knownAgents, shortId } from './agents.ts';
import { ACTION_LABELS, EXTRA_COUNTER_ACTIONS, FAIL_LABEL, LEGEND_ACTIONS, MAIN_AGENT_LABEL } from './labels.ts';
import type { RendererKind } from './renderer.ts';
import { sessionPalette } from './sessions.ts';
import { FEED_LIMIT, type FeedItem, type Filters } from './state.ts';
import { MAIN_AGENT } from './store.ts';

export interface SessionRow {
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  ended: boolean;
  /** Ended by /clear (see SessionInfo.cleared). */
  cleared?: boolean;
}

export interface PanelHandlers {
  onFilters(f: Filters): void;
  onRenderer(kind: RendererKind): void;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** HH:MM:SS.mmm in local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function agentLabel(item: Pick<FeedItem, 'agentId' | 'agentType'>): string {
  if (!item.agentId) return MAIN_AGENT_LABEL;
  return item.agentType || agentType(item.agentId) || `subagente ${shortId(item.agentId)}`;
}

function chipColor(item: FeedItem): string {
  if (item.phase === 'fail') return FAIL_COLOR;
  if (item.external) return EXTERNAL_COLOR;
  return ACTION_COLORS[item.action];
}

export class Panel {
  private readonly feed = el<HTMLUListElement>('feed');
  private readonly empty = el('feed-empty');
  private readonly sessionSel = el<HTMLSelectElement>('f-session');
  private readonly agentSel = el<HTMLSelectElement>('f-agent');
  private readonly externalBox = el<HTMLInputElement>('f-external');
  private readonly sessionDot = el('f-session-dot');
  private readonly sessionLegend = el('session-legend');
  private readonly sessionChips = el('session-chips');
  private readonly counterCells = new Map<string, HTMLElement>();
  private pending: FeedItem[] = [];
  private queued = false;
  private filters: Filters;

  constructor(
    filters: Filters,
    private readonly handlers: PanelHandlers,
  ) {
    this.filters = { ...filters };
    this.buildCounters();
    this.buildLegend();
    this.externalBox.checked = filters.showExternal;
    this.sessionSel.addEventListener('change', () => this.emitFilters());
    this.agentSel.addEventListener('change', () => this.emitFilters());
    this.externalBox.addEventListener('change', () => this.emitFilters());
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      btn.addEventListener('click', () => this.handlers.onRenderer(btn.dataset.view === '2d' ? '2d' : '3d'));
    }
    const toggle = el<HTMLButtonElement>('panel-toggle');
    const small = window.matchMedia('(max-width: 760px)');
    const setOpen = (open: boolean): void => {
      document.body.classList.toggle('panel-closed', !open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    setOpen(!small.matches);
    toggle.addEventListener('click', () => setOpen(document.body.classList.contains('panel-closed')));
    this.setSessions([]);
    this.refreshAgents();
  }

  private emitFilters(): void {
    this.filters = {
      session: this.sessionSel.value,
      agent: this.agentSel.value,
      showExternal: this.externalBox.checked,
    };
    this.syncSessionMarks();
    this.handlers.onFilters({ ...this.filters });
  }

  /** Programmatic filter change (tests); does not fire onFilters. */
  showFilters(f: Filters): void {
    this.filters = { ...f };
    this.ensureOption(this.sessionSel, f.session, f.session ? shortId(f.session) : '');
    this.ensureOption(this.agentSel, f.agent, f.agent);
    this.sessionSel.value = f.session;
    this.agentSel.value = f.agent;
    this.externalBox.checked = f.showExternal;
    this.syncSessionMarks();
  }

  private ensureOption(sel: HTMLSelectElement, value: string, text: string): void {
    if (!value) return;
    if ([...sel.options].some((o) => o.value === value)) return;
    sel.append(new Option(text, value));
  }

  setRenderer(kind: RendererKind): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === kind));
    }
  }

  /**
   * Rebuilds the session filter. `active` lists the sessions that count for the tint: with
   * two or more, options get a colored dot, feed rows a border in the session hue and the
   * "Sesiones" line shows. With one, the panel looks as before.
   */
  setSessions(sessions: SessionRow[], active: readonly string[] = []): void {
    const multi = active.length >= 2;
    document.body.classList.toggle('multi-session', multi);
    const current = this.filters.session;
    const opts = [new Option('Todas las sesiones', '')];
    const sorted = [...sessions].sort((a, b) => b.firstSeen - a.firstSeen);
    for (const s of sorted) {
      const d = new Date(s.firstSeen);
      const color = multi ? sessionPalette.peek(s.sessionId) : undefined;
      const text = `${color ? '● ' : ''}${shortId(s.sessionId)} · ${pad(d.getHours())}:${pad(d.getMinutes())}${s.ended ? ' · terminada' : ''}`;
      const opt = new Option(text, s.sessionId);
      if (color) opt.style.color = color;
      opts.push(opt);
    }
    if (current && !sorted.some((s) => s.sessionId === current)) opts.push(new Option(shortId(current), current));
    this.sessionSel.replaceChildren(...opts);
    this.sessionSel.value = current;

    const chips: HTMLButtonElement[] = [];
    if (multi) {
      // Palette order (first appearance), so the line does not reshuffle as sessions talk.
      const shown = new Set(active);
      for (const id of sessionPalette.ids()) {
        if (!shown.has(id)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sess-chip';
        btn.dataset.session = id;
        btn.style.setProperty('--s', sessionPalette.peek(id) ?? 'transparent');
        btn.textContent = shortId(id);
        btn.addEventListener('click', () => {
          this.sessionSel.value = this.filters.session === id ? '' : id;
          this.emitFilters();
        });
        chips.push(btn);
      }
    }
    this.sessionChips.replaceChildren(...chips);
    this.sessionLegend.hidden = !multi;
    this.syncSessionMarks();
  }

  /** Dot next to the session select and pressed state of the "Sesiones" chips. */
  private syncSessionMarks(): void {
    const current = this.filters.session;
    const multi = document.body.classList.contains('multi-session');
    const color = multi && current ? sessionPalette.peek(current) : undefined;
    this.sessionDot.hidden = !color;
    if (color) this.sessionDot.style.setProperty('--s', color);
    for (const btn of this.sessionChips.querySelectorAll<HTMLButtonElement>('.sess-chip')) {
      const on = btn.dataset.session === current;
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? `Sesión ${btn.dataset.session}: clic para ver todas` : `Sesión ${btn.dataset.session}: clic para filtrar`;
    }
  }

  refreshAgents(): void {
    const current = this.filters.agent;
    const opts = [new Option('Todos los agentes', ''), new Option('Principal', MAIN_AGENT)];
    for (const id of knownAgents()) {
      const type = agentType(id);
      opts.push(new Option(`${type || 'subagente'} · ${shortId(id)}`, id));
    }
    this.agentSel.replaceChildren(...opts);
    this.agentSel.value = current;
    if (this.agentSel.value !== current) this.agentSel.value = '';
  }

  // ---------- feed ----------

  /** Queues a row (already filtered) for the next frame. */
  push(item: FeedItem): void {
    this.pending.push(item);
    if (this.pending.length > FEED_LIMIT) this.pending.splice(0, this.pending.length - FEED_LIMIT);
    this.schedule();
  }

  /** Replaces every row (oldest first in, newest shown on top). */
  rebuild(items: FeedItem[]): void {
    this.pending = [];
    this.feed.replaceChildren();
    this.pending = items.slice(-FEED_LIMIT);
    this.schedule();
  }

  get shown(): number {
    return this.feed.childElementCount + this.pending.length;
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.pending.length) {
      const frag = document.createDocumentFragment();
      // Newest on top: prepend in reverse arrival order.
      for (let i = this.pending.length - 1; i >= 0; i--) frag.append(this.row(this.pending[i]!));
      this.pending = [];
      this.feed.prepend(frag);
      while (this.feed.childElementCount > FEED_LIMIT) this.feed.lastElementChild?.remove();
    }
    this.empty.hidden = this.feed.childElementCount > 0;
  }

  private row(item: FeedItem): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `row phase-${item.phase}${item.external ? ' external' : ''}`;
    li.style.setProperty('--c', chipColor(item));
    // Session hue for the left border; CSS only shows it while several sessions are active.
    const sessionHue = item.external ? undefined : sessionPalette.peek(item.sessionId);
    if (sessionHue) {
      li.style.setProperty('--s', sessionHue);
      li.classList.add('tinted');
    }

    const time = document.createElement('time');
    time.dateTime = new Date(item.ts).toISOString();
    time.textContent = formatClock(item.ts);

    const chip = document.createElement('span');
    chip.className = 'chip-action';
    const label = ACTION_LABELS[item.action];
    chip.textContent = item.phase === 'fail' ? FAIL_LABEL : item.external ? `${label} ext.` : label;
    chip.title =
      item.phase === 'fail' ? `${label}: falló` : item.phase === 'pre' ? `${label} (antes de ejecutar)` : label;

    const agent = document.createElement('span');
    agent.className = 'agent';
    agent.textContent = agentLabel(item);
    if (item.agentId) {
      agent.style.setProperty('--a', agentColor(item.agentId));
      agent.classList.add('sub');
    }

    const sess = document.createElement('span');
    sess.className = 'sess';
    sess.textContent = shortId(item.sessionId);
    sess.title = `Sesión ${item.sessionId}`;

    const path = document.createElement('span');
    path.className = 'path';
    // The column is rtl so long paths lose their start, not their file name; the LRM marks
    // keep a leading or trailing "/" where it belongs.
    path.textContent = `\u200e${item.path || item.detail || ''}\u200e`;
    path.title = item.detail && item.path ? `${item.path}\n${item.detail}` : item.path || item.detail || '';

    li.append(time, chip, agent, sess, path);
    return li;
  }

  // ---------- counters and legend ----------

  private buildCounters(): void {
    const list = el('counters');
    const add = (key: string, text: string, color: string): void => {
      const li = document.createElement('li');
      li.style.setProperty('--c', color);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = text;
      const count = document.createElement('span');
      count.className = 'count';
      count.dataset.counter = key;
      count.textContent = '0';
      li.append(label, count);
      list.append(li);
      this.counterCells.set(key, count);
    };
    for (const a of [...LEGEND_ACTIONS, ...EXTRA_COUNTER_ACTIONS]) add(a, ACTION_LABELS[a], ACTION_COLORS[a]);
    add('fail', FAIL_LABEL, FAIL_COLOR);
  }

  setCounters(counters: Partial<Record<Action, number>>, fails: number): void {
    for (const [key, cell] of this.counterCells) {
      const v = key === 'fail' ? fails : (counters[key as Action] ?? 0);
      const text = v.toLocaleString('es');
      if (cell.textContent !== text) cell.textContent = text;
    }
  }

  private buildLegend(): void {
    const legend = el('legend');
    const item = (color: string, text: string, cls = ''): void => {
      const li = document.createElement('li');
      li.style.setProperty('--c', color);
      if (cls) li.className = cls;
      li.textContent = text;
      legend.append(li);
    };
    for (const a of LEGEND_ACTIONS) item(ACTION_COLORS[a], ACTION_LABELS[a]);
    item(ACTION_COLORS.subagent_start, 'subagente');
    item(FAIL_COLOR, 'fallo');
    item(EXTERNAL_COLOR, 'cambio externo (gris tenue)', 'dim');
    item('#38bdf8', 'anillo de color: subagente (un tono por agente)', 'ring');
    item('#e9a17a', 'anillo fino: sesión (con 2 o más sesiones activas)', 'ring thin');
    item('#fdba74', 'brillo residual: archivos más tocados', 'heat');
    item('#5b4a8a', 'fuera del repo (~/.claude, /tmp…)');
    item('#2f5d8f', 'carpeta colapsada: clic para abrir', 'big');
  }
}
