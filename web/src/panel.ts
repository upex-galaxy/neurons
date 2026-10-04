// Side panel: live feed, counters, tools, filters, view toggle, live stream toggle, session
// tint and legend. Every visible string comes from the i18n dictionaries; relabel() redraws
// them after a language change.
import { ACTION_COLORS, EXTERNAL_COLOR, FAIL_COLOR, type Action } from '../../src/shared/types.ts';
import { agentColor, agentType, knownAgents, shortId } from './agents.ts';
import { formatNumber, t } from './i18n.ts';
import { EXTRA_COUNTER_ACTIONS, LEGEND_ACTIONS, actionLabel, failLabel, shownDetail } from './labels.ts';
import type { ViewKind } from './renderer.ts';
import { sessionPalette } from './sessions.ts';
import { FEED_LIMIT, type FeedItem, type Filters } from './state.ts';
import { MAIN_AGENT, pathTag } from './store.ts';
import { serverTotal, sortedCounts, type ToolTally } from './tools.ts';

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
  onView(kind: ViewKind): void;
  /** A feed row was activated: open its detail. */
  onOpen(eventId: string): void;
  onStream(on: boolean): void;
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

/** Agent text of a feed row: empty for the main agent, the subagent type otherwise. */
export function agentLabel(item: Pick<FeedItem, 'agentId' | 'agentType'>): string {
  if (!item.agentId) return '';
  return item.agentType || agentType(item.agentId) || t('feed.subagentShort', { id: shortId(item.agentId) });
}

function chipColor(item: FeedItem): string {
  if (item.phase === 'fail') return FAIL_COLOR;
  if (item.external) return EXTERNAL_COLOR;
  return ACTION_COLORS[item.action];
}

const TOOL_GROUPS = ['skills', 'mcp', 'cli', 'builtin'] as const;
type ToolGroup = (typeof TOOL_GROUPS)[number];

export class Panel {
  private readonly feed = el<HTMLUListElement>('feed');
  private readonly empty = el('feed-empty');
  private readonly sessionSel = el<HTMLSelectElement>('f-session');
  private readonly agentSel = el<HTMLSelectElement>('f-agent');
  private readonly externalBox = el<HTMLInputElement>('f-external');
  private readonly streamBox = el<HTMLInputElement>('f-stream');
  private readonly sessionDot = el('f-session-dot');
  private readonly sessionLegend = el('session-legend');
  private readonly sessionChips = el('session-chips');
  private readonly counterCells = new Map<string, HTMLElement>();
  private readonly counterLabels = new Map<string, HTMLElement>();
  private readonly toolLists = new Map<ToolGroup, HTMLElement>();
  private readonly toolTotals = new Map<ToolGroup, HTMLElement>();
  private pending: FeedItem[] = [];
  private queued = false;
  private filters: Filters;
  private lastSessions: SessionRow[] = [];
  private lastActive: readonly string[] = [];
  private lastTools: ToolTally | null = null;
  private selected: string | null = null;

  constructor(
    filters: Filters,
    private readonly handlers: PanelHandlers,
  ) {
    this.filters = { ...filters };
    this.buildCounters();
    this.buildTools();
    this.buildLegend();
    this.externalBox.checked = filters.showExternal;
    this.sessionSel.addEventListener('change', () => this.emitFilters());
    this.agentSel.addEventListener('change', () => this.emitFilters());
    this.externalBox.addEventListener('change', () => this.emitFilters());
    this.streamBox.addEventListener('change', () => this.handlers.onStream(this.streamBox.checked));
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      const v = btn.dataset.view;
      btn.addEventListener('click', () => this.handlers.onView(v === 'timeline' ? 'timeline' : v === '2d' ? '2d' : '3d'));
    }
    // Rows are buttons: one delegated listener for click, Enter and Space.
    this.feed.addEventListener('click', (ev) => this.activate(ev.target));
    this.feed.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      this.activate(ev.target);
    });
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

  private activate(target: EventTarget | null): void {
    const row = (target as HTMLElement | null)?.closest<HTMLElement>('.row[data-id]');
    if (row?.dataset.id) this.handlers.onOpen(row.dataset.id);
  }

  setStream(on: boolean): void {
    this.streamBox.checked = on;
  }

  /** Marks the feed row of the event open in the detail drawer. */
  select(id: string | null): void {
    this.selected = id;
    for (const row of this.feed.querySelectorAll<HTMLElement>('.row.selected')) {
      row.classList.remove('selected');
      row.removeAttribute('aria-current');
    }
    if (!id) return;
    const row = this.feed.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) {
      row.classList.add('selected');
      row.setAttribute('aria-current', 'true');
    }
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

  setView(kind: ViewKind): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === kind));
    }
  }

  /** Redraws every generated string after a language change. */
  relabel(items: FeedItem[]): void {
    for (const [key, label] of this.counterLabels) label.textContent = key === 'fail' ? failLabel() : actionLabel(key as Action);
    el('legend').replaceChildren();
    this.buildLegend();
    this.setSessions(this.lastSessions, this.lastActive);
    this.refreshAgents();
    if (this.lastTools) this.setTools(this.lastTools);
    this.rebuild(items);
  }

  /**
   * Rebuilds the session filter. `active` lists the sessions that count for the tint: with
   * two or more, options get a colored dot, feed rows a border in the session hue and the
   * "Sessions" line shows. With one, the panel looks as before.
   */
  setSessions(sessions: SessionRow[], active: readonly string[] = []): void {
    this.lastSessions = sessions;
    this.lastActive = active;
    const multi = active.length >= 2;
    document.body.classList.toggle('multi-session', multi);
    const current = this.filters.session;
    const opts = [new Option(t('filter.allSessions'), '')];
    const sorted = [...sessions].sort((a, b) => b.firstSeen - a.firstSeen);
    for (const s of sorted) {
      const d = new Date(s.firstSeen);
      const color = multi ? sessionPalette.peek(s.sessionId) : undefined;
      const text = `${color ? '● ' : ''}${shortId(s.sessionId)} · ${pad(d.getHours())}:${pad(d.getMinutes())}${s.ended ? ` · ${t('filter.ended')}` : ''}`;
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

  /** Dot next to the session select and pressed state of the "Sessions" chips. */
  private syncSessionMarks(): void {
    const current = this.filters.session;
    const multi = document.body.classList.contains('multi-session');
    const color = multi && current ? sessionPalette.peek(current) : undefined;
    this.sessionDot.hidden = !color;
    if (color) this.sessionDot.style.setProperty('--s', color);
    for (const btn of this.sessionChips.querySelectorAll<HTMLButtonElement>('.sess-chip')) {
      const on = btn.dataset.session === current;
      btn.setAttribute('aria-pressed', String(on));
      btn.title = t(on ? 'filter.chipOn' : 'filter.chipOff', { id: btn.dataset.session ?? '' });
    }
  }

  refreshAgents(): void {
    const current = this.filters.agent;
    const opts = [new Option(t('filter.allAgents'), ''), new Option(t('filter.main'), MAIN_AGENT)];
    for (const id of knownAgents()) {
      const type = agentType(id);
      opts.push(new Option(`${type || t('filter.subagent')} · ${shortId(id)}`, id));
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
    li.dataset.id = item.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.style.setProperty('--c', chipColor(item));
    if (item.id === this.selected) {
      li.classList.add('selected');
      li.setAttribute('aria-current', 'true');
    }
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
    const label = actionLabel(item.action);
    chip.textContent = item.phase === 'fail' ? failLabel() : item.external ? t('feed.ext', { label }) : label;
    chip.title =
      item.phase === 'fail' ? t('feed.failedTitle', { label }) : item.phase === 'pre' ? t('feed.preTitle', { label }) : label;

    // Main agent: no label (it is the default); subagents show their type and halo color.
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
    sess.title = t('feed.sessionTitle', { id: item.sessionId });

    const path = document.createElement('span');
    path.className = 'path';
    // The column is rtl so long paths lose their start, not their file name; the LRM marks
    // keep a leading or trailing "/" where it belongs.
    const detail = shownDetail(item);
    path.textContent = `‎${item.path || detail || ''}‎`;
    // Nothing to name (a batch end): no empty second line.
    path.hidden = !(item.path || detail);
    path.title = detail && item.path ? `${item.path}\n${detail}` : item.path || detail || '';

    li.setAttribute('aria-label', `${formatClock(item.ts)} ${chip.textContent} ${item.path || detail || ''}. ${t('feed.rowTitle')}`);
    li.append(time, chip, agent, sess, path);
    const tag = pathTag(item);
    if (tag) {
      const wt = document.createElement('span');
      wt.className = 'wt-tag';
      wt.textContent = tag.text;
      wt.title = tag.title;
      path.classList.add('tagged');
      li.append(wt);
    }
    return li;
  }

  // ---------- counters, tools and legend ----------

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
      this.counterLabels.set(key, label);
    };
    for (const a of [...LEGEND_ACTIONS, ...EXTRA_COUNTER_ACTIONS]) add(a, actionLabel(a), ACTION_COLORS[a]);
    add('fail', failLabel(), FAIL_COLOR);
  }

  setCounters(counters: Partial<Record<Action, number>>, fails: number): void {
    for (const [key, cell] of this.counterCells) {
      const v = key === 'fail' ? fails : (counters[key as Action] ?? 0);
      const text = formatNumber(v);
      if (cell.textContent !== text) cell.textContent = text;
    }
  }

  private buildTools(): void {
    for (const group of TOOL_GROUPS) {
      const box = document.querySelector<HTMLElement>(`[data-tools="${group}"]`);
      if (!box) continue;
      const list = box.querySelector<HTMLElement>('.tool-list');
      const total = box.querySelector<HTMLElement>('.tool-total');
      if (list) this.toolLists.set(group, list);
      if (total) this.toolTotals.set(group, total);
    }
  }

  /** Redraws the four tool groups (called at most 10 times a second, only when dirty). */
  setTools(tally: ToolTally): void {
    this.lastTools = tally;
    const flat: Record<Exclude<ToolGroup, 'mcp'>, Map<string, number>> = {
      skills: tally.skills,
      cli: tally.cli,
      builtin: tally.builtin,
    };
    for (const group of TOOL_GROUPS) {
      const list = this.toolLists.get(group);
      if (!list) continue;
      const items: HTMLElement[] = [];
      let total = 0;
      if (group === 'mcp') {
        const servers = [...tally.mcp].sort((a, b) => serverTotal(b[1]) - serverTotal(a[1]) || a[0].localeCompare(b[0]));
        for (const [server, tools] of servers) {
          const n = serverTotal(tools);
          total += n;
          const li = this.toolItem(server, n, 'tool-server');
          li.dataset.tool = server;
          const sub = document.createElement('ul');
          sub.className = 'tool-sublist';
          for (const [name, c] of sortedCounts(tools)) {
            const item = this.toolItem(name, c);
            item.dataset.tool = `${server}/${name}`;
            sub.append(item);
          }
          li.append(sub);
          items.push(li);
        }
      } else {
        for (const [name, c] of sortedCounts(flat[group])) {
          total += c;
          const item = this.toolItem(name, c);
          item.dataset.tool = name;
          items.push(item);
        }
      }
      if (!items.length) {
        const empty = document.createElement('li');
        empty.className = 'tool-empty';
        empty.textContent = t(`tools.empty.${group}`);
        items.push(empty);
      }
      list.replaceChildren(...items);
      const totalEl = this.toolTotals.get(group);
      if (totalEl) totalEl.textContent = formatNumber(total);
    }
  }

  private toolItem(name: string, count: number, cls = ''): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `tool-item ${cls}`.trim();
    const row = document.createElement('span');
    row.className = 'tool-row';
    const label = document.createElement('span');
    label.className = 'tool-name';
    label.textContent = name;
    label.title = name;
    const num = document.createElement('span');
    num.className = 'count';
    num.textContent = formatNumber(count);
    row.append(label, num);
    li.append(row);
    return li;
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
    for (const a of LEGEND_ACTIONS) item(ACTION_COLORS[a], actionLabel(a));
    item(ACTION_COLORS.subagent_start, t('legend.subagent'));
    item(FAIL_COLOR, t('legend.fail'));
    item(EXTERNAL_COLOR, t('legend.external'), 'dim wide');
    item('#38bdf8', t('legend.agentRing'), 'ring wide');
    item('#e9a17a', t('legend.sessionRing'), 'ring thin wide');
    item('#fdba74', t('legend.heat'), 'heat wide');
    item(ACTION_COLORS.edit, t('legend.trail'), 'trail wide');
    item('#5b4a8a', t('legend.outside'), 'wide');
    item('#2f5d8f', t('legend.collapsed'), 'big wide');
  }
}
