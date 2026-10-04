// Detail drawer: slides over the graph from the panel side (a bottom sheet on narrow
// screens). Shows one event (time, session, agent, action, tool, paths, command, Claude's
// description, pattern, duration, error, secondary hits, worktree) or the list of events of
// one file. Esc / X close it, ← and → move to the previous / next event of the feed.
import { ACTION_COLORS, EXTERNAL_COLOR, FAIL_COLOR, type VizEvent } from '../../src/shared/types.ts';
import { agentColor, agentType, shortId } from './agents.ts';
import { formatRelative, getLang, t, tn } from './i18n.ts';
import { actionLabel, failLabel, isDenied, phaseLabel, plainDetail } from './labels.ts';
import { formatClock } from './panel.ts';
import { sessionPalette } from './sessions.ts';
import type { EventRecord } from './store.ts';
import { toolOf } from './tools.ts';

const MAX_SECONDARY_SHOWN = 20;
const FILE_EVENTS_LIMIT = 200;

export interface DetailHost {
  record(id: string): EventRecord | undefined;
  /** Previous (-1, older) or next (+1, newer) event id under the current filter. */
  neighbor(id: string, dir: -1 | 1): string | undefined;
  /** Newest first, under the current filter. */
  forPath(path: string, limit: number): EventRecord[];
  /** Reveals, frames and pulses the node; false when it is not in the graph. */
  showInGraph(path: string): boolean;
  copy(text: string): void;
  onChange(eventId: string | null, path: string | null): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chipColor(e: VizEvent): string {
  if (e.phase === 'fail') return FAIL_COLOR;
  if (e.external) return EXTERNAL_COLOR;
  return ACTION_COLORS[e.action];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return t('detail.ms', { ms: Math.round(ms) });
  return t('detail.seconds', { s: (Math.round(ms / 100) / 10).toFixed(1) });
}

export class DetailDrawer {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;
  private eventId: string | null = null;
  private path: string | null = null;
  /** File list the current event was opened from (the back button returns to it). */
  private fromPath: string | null = null;
  private opener: HTMLElement | null = null;
  /** What the file view shows now (language, path, event ids), to skip re-renders that change nothing. */
  private fileView: string | null = null;

  constructor(private readonly host: DetailHost) {
    this.root = document.getElementById('detail')!;
    this.title = document.getElementById('detail-title')!;
    this.body = document.getElementById('detail-body')!;
    this.prevBtn = document.getElementById('detail-prev') as HTMLButtonElement;
    this.nextBtn = document.getElementById('detail-next') as HTMLButtonElement;
    this.backBtn = document.getElementById('detail-back') as HTMLButtonElement;
    document.getElementById('detail-close')!.addEventListener('click', () => this.close());
    this.prevBtn.addEventListener('click', () => this.step(-1));
    this.nextBtn.addEventListener('click', () => this.step(1));
    this.backBtn.addEventListener('click', () => {
      if (this.fromPath) this.openFile(this.fromPath);
    });
    document.addEventListener('keydown', (ev) => this.onKey(ev));
    this.setOpen(false);
  }

  get openEvent(): string | null {
    return this.eventId;
  }

  get openPath(): string | null {
    return this.path;
  }

  get isOpen(): boolean {
    return this.eventId !== null || this.path !== null;
  }

  open(id: string, opts: { fromPath?: string } = {}): void {
    this.rememberOpener();
    this.eventId = id;
    this.path = null;
    this.fromPath = opts.fromPath ?? null;
    this.render();
    this.setOpen(true);
  }

  openFile(path: string): void {
    this.rememberOpener();
    this.eventId = null;
    this.path = path;
    this.fromPath = null;
    this.fileView = null;
    this.render();
    this.setOpen(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.eventId = null;
    this.path = null;
    this.fromPath = null;
    this.setOpen(false);
    this.host.onChange(null, null);
    const back = this.opener;
    this.opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  /** Re-renders (language change, new events for an open file). */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  private rememberOpener(): void {
    if (this.isOpen) return;
    const active = document.activeElement;
    this.opener = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  private setOpen(open: boolean): void {
    this.root.classList.toggle('open', open);
    this.root.setAttribute('aria-hidden', String(!open));
    this.root.inert = !open;
    document.body.classList.toggle('detail-open', open);
    if (open) {
      this.host.onChange(this.eventId, this.path);
      this.root.focus({ preventScroll: true });
    }
  }

  private step(dir: -1 | 1): void {
    if (!this.eventId) return;
    const next = this.host.neighbor(this.eventId, dir);
    if (next) this.open(next, this.fromPath ? { fromPath: this.fromPath } : {});
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.isOpen || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const target = ev.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [role="slider"], [role="separator"]')) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.close();
    } else if (ev.key === 'ArrowLeft' && this.eventId) {
      ev.preventDefault();
      this.step(-1);
    } else if (ev.key === 'ArrowRight' && this.eventId) {
      ev.preventDefault();
      this.step(1);
    }
  }

  /**
   * Swaps the body, keeping the keyboard focus: a re-render (new events for the open file, a
   * language change) must not drop a focused button to <body>. The focus goes back to the
   * element with the same data-focus-key, or to the drawer itself.
   */
  private replaceBody(...nodes: Node[]): void {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && this.body.contains(active) ? (active.dataset.focusKey ?? '') : null;
    this.body.replaceChildren(...nodes);
    if (key === null) return;
    const again = key ? this.body.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null;
    (again ?? this.root).focus({ preventScroll: true });
  }

  private render(): void {
    this.backBtn.hidden = !this.fromPath;
    if (this.path !== null) {
      this.renderFile(this.path);
      return;
    }
    this.fileView = null;
    const rec = this.eventId ? this.host.record(this.eventId) : undefined;
    const hasPrev = !!(this.eventId && this.host.neighbor(this.eventId, -1));
    const hasNext = !!(this.eventId && this.host.neighbor(this.eventId, 1));
    this.prevBtn.disabled = !hasPrev;
    this.nextBtn.disabled = !hasNext;
    this.prevBtn.hidden = false;
    this.nextBtn.hidden = false;
    this.title.textContent = t('detail.title');
    if (!rec) {
      this.replaceBody(el('p', 'empty', t('detail.notFound')));
      return;
    }
    this.replaceBody(...this.eventView(rec.event));
  }

  private renderFile(path: string): void {
    this.prevBtn.hidden = true;
    this.nextBtn.hidden = true;
    this.title.textContent = t('detail.fileTitle');
    // One more than shown, to know whether the list was cut.
    const found = this.host.forPath(path, FILE_EVENTS_LIMIT + 1);
    const capped = found.length > FILE_EVENTS_LIMIT;
    const recs = capped ? found.slice(0, FILE_EVENTS_LIMIT) : found;
    // Nothing new for this file (same events, same language): keep the list as it is.
    const view = `${getLang()}\n${path}\n${capped}\n${recs.map((r) => r.event.id).join(',')}`;
    if (view === this.fileView) return;
    this.fileView = view;
    const head = el('div', 'detail-file');
    head.append(this.pathLine(path), this.graphButton(path));
    const count = el('p', 'detail-count', capped ? t('detail.fileCountCapped', { count: FILE_EVENTS_LIMIT }) : tn('detail.fileCount', recs.length));
    if (!recs.length) {
      this.replaceBody(head, el('p', 'empty', t('detail.fileEmpty')));
      return;
    }
    const list = el('ol', 'detail-events');
    for (const rec of recs) {
      const e = rec.event;
      const li = el('li');
      const btn = el('button', 'detail-event');
      btn.type = 'button';
      btn.style.setProperty('--c', chipColor(e));
      btn.append(
        el('time', 'mono', formatClock(e.ts)),
        el('span', 'chip-action', e.phase === 'fail' ? failLabel() : actionLabel(e.action)),
        el('span', 'detail-event-meta', this.agentText(e)),
      );
      btn.title = t('feed.rowTitle');
      btn.dataset.focusKey = `event:${e.id}`;
      btn.addEventListener('click', () => this.open(e.id, { fromPath: path }));
      li.append(btn);
      list.append(li);
    }
    this.replaceBody(head, count, list);
  }

  private agentText(e: VizEvent): string {
    if (!e.agentId) return t('detail.main');
    return `${e.agentType || agentType(e.agentId) || t('filter.subagent')} · ${shortId(e.agentId)}`;
  }

  private eventView(e: VizEvent): HTMLElement[] {
    const dl = el('dl', 'detail-grid');
    const row = (label: string, ...value: Array<Node | string>): void => {
      const dt = el('dt', '', label);
      const dd = el('dd');
      dd.append(...value);
      dl.append(dt, dd);
    };

    // Time with ms, and how long ago.
    const time = el('span', 'mono', formatClock(e.ts));
    const rel = el('span', 'muted', ` · ${formatRelative(Date.now() - e.ts)}`);
    row(t('detail.time'), time, rel);

    // Session: hue dot + short id (full id on hover).
    const sess = el('span', 'detail-sess mono', shortId(e.sessionId));
    sess.title = e.sessionId;
    const hue = e.external ? undefined : sessionPalette.peek(e.sessionId);
    if (hue) sess.style.setProperty('--s', hue);
    sess.classList.toggle('tinted', !!hue);
    row(t('detail.session'), sess);

    // Agent: main, or subagent type with its halo color.
    const agent = el('span', 'detail-agent', this.agentText(e));
    if (e.agentId) {
      agent.classList.add('sub');
      agent.style.setProperty('--a', agentColor(e.agentId));
    }
    row(t('detail.agent'), agent);

    // Action + phase.
    const chip = el('span', 'chip-action', actionLabel(e.action));
    chip.style.setProperty('--c', chipColor(e));
    const phase = el('span', `chip-phase phase-${e.phase}`, phaseLabel(e.phase));
    const action = el('span', 'detail-chips');
    action.append(chip, phase);
    if (e.external) action.append(el('span', 'chip-phase', t('detail.external')));
    if (isDenied(e)) {
      const denied = el('span', 'chip-phase phase-fail', t('feed.denied'));
      denied.title = t('feed.deniedTitle');
      action.append(denied);
    }
    if (e.worktree) {
      const wt = el('span', 'wt-tag', t('feed.worktree'));
      wt.title = t('feed.worktreeTitle', { name: e.worktree });
      action.append(wt);
    }
    row(t('detail.action'), action);

    const tool = toolOf(e);
    if (tool) {
      const kind = el('span', 'chip-phase', t(`tool.kind.${tool.kind}`));
      const name = el('span', 'mono', tool.server ? `${tool.server} / ${tool.name}` : tool.name);
      const box = el('span', 'detail-chips');
      box.append(kind, name);
      row(t('detail.tool'), box);
    }

    if (e.cli?.length) {
      const box = el('span', 'detail-chips');
      box.append(...e.cli.map((prog) => el('span', 'chip-phase mono', prog)));
      row(t('detail.cli'), box);
    }

    if (e.worktree) row(t('detail.worktree'), el('span', 'mono', `.claude/worktrees/${e.worktree}/`));

    const views: HTMLElement[] = [dl];
    const section = (label: string, ...content: HTMLElement[]): void => {
      const s = el('section', 'detail-section');
      s.append(el('h3', '', label), ...content);
      views.push(s);
    };

    if (e.paths.length) section(t('detail.paths'), ...e.paths.map((p) => this.pathLine(p)));
    if (e.fromPaths?.length) section(t('detail.fromPaths'), ...e.fromPaths.map((p) => this.pathLine(p)));
    if (e.outsideRepo?.length) section(t('detail.outside'), ...e.outsideRepo.map((p) => this.pathLine(p)));

    if (e.command) section(t('detail.command'), this.codeBlock(e.command));
    if (e.description) section(t('detail.description'), el('p', 'detail-desc', e.description));
    if (e.pattern) section(t('detail.pattern'), this.codeBlock(e.pattern, true));
    // `detail` repeats the command, the skill or "server/tool" for most events; show it
    // when it says something else (load reason, turn prompt...).
    const detail = plainDetail(e);
    if (detail && !e.command && detail !== tool?.name && detail !== `${tool?.server}/${tool?.name}` && !e.paths.includes(detail)) {
      section(t('detail.detailField'), el('p', 'detail-desc mono', detail));
    }
    if (e.durationMs !== undefined) section(t('detail.duration'), el('p', 'mono', formatDuration(e.durationMs)));
    if (e.phase === 'fail' && e.error) section(t('detail.error'), el('p', 'detail-error mono', e.error));

    if (e.secondary?.length) {
      const shown = e.secondary.slice(0, MAX_SECONDARY_SHOWN).map((p) => this.pathLine(p));
      const more = e.secondary.length - shown.length;
      const extra = more > 0 ? [el('p', 'muted', t('detail.moreSecondary', { count: more }))] : [];
      section(tn('detail.secondary', e.secondary.length), ...shown, ...extra);
    }

    const target = e.paths[0] ?? e.outsideRepo?.[0] ?? e.secondary?.[0];
    if (target !== undefined) {
      const actions = el('div', 'detail-actions');
      actions.append(this.graphButton(target));
      views.push(actions);
    }
    return views;
  }

  private graphButton(path: string | undefined): HTMLButtonElement {
    const btn = el('button', 'btn primary', t('detail.showInGraph'));
    btn.type = 'button';
    btn.dataset.focusKey = 'graph';
    btn.disabled = path === undefined;
    btn.addEventListener('click', () => {
      if (path !== undefined && !this.host.showInGraph(path)) btn.disabled = true;
    });
    return btn;
  }

  private copyButton(text: string, label: string): HTMLButtonElement {
    const btn = el('button', 'icon-btn copy-btn');
    btn.type = 'button';
    btn.dataset.focusKey = `copy:${text}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => this.host.copy(text));
    return btn;
  }

  private pathLine(path: string): HTMLElement {
    const line = el('div', 'detail-path');
    const code = el('code', 'mono', path || '/');
    code.title = path;
    line.append(code, this.copyButton(path, t('detail.copyPath')));
    return line;
  }

  private codeBlock(text: string, inline = false): HTMLElement {
    const box = el('div', inline ? 'detail-code inline' : 'detail-code');
    const pre = el('pre', 'mono', text);
    box.append(pre, this.copyButton(text, t('detail.copy')));
    return box;
  }
}

