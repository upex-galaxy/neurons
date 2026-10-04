// Timeline view: a Canvas 2D swimlane of the agent's path through the repo. X is time
// (long pauses shortened, see TimeAxis), rows are files in order of first touch grouped
// by folder, marks are events. Top bands show prompt turns and subagent lifetimes.
// Only what is on screen is drawn, and only when something changed (or the live cursor
// moved), so it stays smooth with thousands of events.
import { FAIL_COLOR, type VizEvent } from '../../src/shared/types.ts';
import { agentColor, shortId } from './agents.ts';
import { t, tn } from './i18n.ts';
import { actionLabel, failLabel, isDenied, phaseLabel, plainDetail } from './labels.ts';
import { formatClock } from './panel.ts';
import { BACKGROUND } from './renderer.ts';
import { sessionPalette } from './sessions.ts';
import {
  GAP_THRESHOLD_MS,
  OUTSIDE_GROUP,
  TOOLS_GROUP,
  baseName,
  ellipsizeMiddle,
  itemAt,
  layoutRows,
  lowerBound,
  upperBound,
  type AgentSpan,
  type LayoutItem,
  type TimeBreak,
  type TimelineMark,
  type TimelineModel,
  type TimelineRow,
  type TurnSpan,
} from './timelineModel.ts';

export interface TimelineHost {
  /** The event behind a mark (tooltips), or undefined once it left the buffer. */
  event(id: string): VizEvent | undefined;
  openEvent(id: string): void;
  openFile(path: string): void;
  /** Switches to the graph and frames the node. */
  showInGraph(path: string): void;
  repoName(): string;
  /** Epoch ms of "now": the wall clock live, the playback clock in replay. */
  now(): number;
  replaying(): boolean;
}

const AXIS_H = 22;
/** One lane of the turn band; overlapping turns of two sessions take two. */
const TURN_LANE_H = 18;
const AGENT_LANE_H = 13;
const GROUP_H = 22;
const ROW_H = 20;
const SUB_H = 9;
const LEFT_MIN = 150;
const LEFT_MAX = 270;
const RIGHT_PAD = 56;
const LEFT_PAD = 20;
const MARK_R = 4;
const SUB_R = 2.6;
const HIT_PX = 7;
const SLIDE_MS = 360;
/** Pixels per ms: 30 px per second by default, 0.4 to 600 px per second. */
const DEFAULT_PX_PER_MS = 0.03;
const MIN_PX_PER_MS = 0.0004;
const MAX_PX_PER_MS = 0.6;
const ZOOM_STEP = 1.25;
const TICK_STEPS = [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 144e5];
const TICK_MIN_PX = 92;
/** After a vertical scroll by hand, the view stops following the newest row for this long. */
const MANUAL_Y_MS = 6000;
const GRAPH_ICON_W = 22;

const C = {
  left: '#080b13',
  grid: 'rgba(99, 135, 190, 0.07)',
  line: 'rgba(99, 135, 190, 0.18)',
  group: 'rgba(30, 58, 95, 0.22)',
  groupText: '#93c5fd',
  rowText: '#cbd5e1',
  muted: '#64748b',
  hover: 'rgba(34, 211, 238, 0.07)',
  turnA: 'rgba(148, 163, 184, 0.05)',
  turnB: 'rgba(148, 163, 184, 0.025)',
  turnText: '#94a3b8',
  cursor: '#22d3ee',
  breakFill: 'rgba(100, 116, 139, 0.08)',
};

const MONO = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
const MONO_SMALL = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS_SMALL = '10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

type Hit =
  | { type: 'mark'; mark: TimelineMark; row: TimelineRow; x: number; y: number }
  | { type: 'row'; row: TimelineRow; graph: boolean }
  | { type: 'group'; item: LayoutItem }
  | { type: 'turn'; turn: TurnSpan }
  | { type: 'agent'; agent: AgentSpan }
  | { type: 'break'; brk: TimeBreak }
  | { type: 'idle'; ms: number };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "45 s", "3 min 12 s", "2 h 5 min". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('timeline.span.s', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('timeline.span.ms', { m, s: s % 60 });
  return t('timeline.span.hm', { h: Math.floor(m / 60), m: m % 60 });
}

function tickLabel(ts: number, step: number): string {
  const d = new Date(ts);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (step >= 60_000) return hm;
  const hms = `${hm}:${pad2(d.getSeconds())}`;
  return step < 1000 ? `${hms}.${Math.floor(d.getMilliseconds() / 100)}` : hms;
}

export class TimelineView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tip: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly emptyTitle: HTMLElement;
  private readonly emptyBody: HTMLElement;
  private readonly followBtn: HTMLButtonElement;
  private active = false;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private pxPerMs = DEFAULT_PX_PER_MS;
  /** Axis position at the right edge of the plot. */
  private viewEnd = 0;
  private scrollY = 0;
  private following = true;
  private manualYUntil = 0;
  private items: LayoutItem[] = [];
  private itemByRow = new Map<TimelineRow, LayoutItem>();
  /** Group -> top of the next group's header (pushes the sticky header up). */
  private nextHeaderY = new Map<unknown, number>();
  private contentH = 0;
  private layoutVersion = -1;
  private drawnRevision = -1;
  private drawnCursorX = NaN;
  private dirty = true;
  private raf = 0;
  private hover: Hit | null = null;
  private pointer: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; end: number; scroll: number; moved: boolean; id: number } | null = null;
  private readonly fitCache = new Map<string, string>();
  /** True while the model is filtered (the empty state then says so). */
  private filtered = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly model: TimelineModel,
    private readonly host: TimelineHost,
  ) {
    this.canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = root.querySelector<HTMLElement>('.tl-tip')!;
    this.empty = root.querySelector<HTMLElement>('.tl-empty')!;
    this.emptyTitle = this.empty.querySelector<HTMLElement>('.tl-empty-title')!;
    this.emptyBody = this.empty.querySelector<HTMLElement>('.tl-empty-body')!;
    this.followBtn = root.querySelector<HTMLButtonElement>('[data-tl="follow"]')!;
    this.followBtn.addEventListener('click', () => this.follow());
    root.querySelector('[data-tl="zoom-in"]')!.addEventListener('click', () => this.zoomBy(ZOOM_STEP, null));
    root.querySelector('[data-tl="zoom-out"]')!.addEventListener('click', () => this.zoomBy(1 / ZOOM_STEP, null));
    new ResizeObserver(() => this.resize()).observe(root);
    this.canvas.addEventListener('pointerdown', (ev) => this.onDown(ev));
    this.canvas.addEventListener('pointermove', (ev) => this.onMove(ev));
    this.canvas.addEventListener('pointerup', (ev) => this.onUp(ev));
    this.canvas.addEventListener('pointercancel', () => (this.drag = null));
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.setHover(null);
    });
    this.canvas.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    this.canvas.addEventListener('keydown', (ev) => this.onKey(ev));
    this.relabel();
  }

  get isActive(): boolean {
    return this.active;
  }

  get isFollowing(): boolean {
    return this.following;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.root.hidden = !on;
    if (on) {
      this.resize();
      this.dirty = true;
      this.loop();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.setHover(null);
    }
  }

  /** The model changed (new events). */
  invalidate(): void {
    this.dirty = true;
  }

  /** The model was rebuilt (reset, filter): back to the top and to "now". */
  reset(filtered = this.filtered): void {
    this.filtered = filtered;
    this.scrollY = 0;
    this.manualYUntil = 0;
    this.setFollowing(true);
    this.setHover(null);
    this.dirty = true;
  }

  relabel(): void {
    this.fitCache.clear();
    this.followBtn.textContent = t(this.host.replaying() ? 'timeline.followReplay' : 'timeline.follow');
    this.canvas.setAttribute('aria-label', t('timeline.aria'));
    this.canvas.title = t('timeline.hint');
    this.syncEmpty();
    if (this.hover) this.showTip(this.hover);
    this.dirty = true;
  }

  // ---------- geometry ----------

  private get leftW(): number {
    return Math.round(Math.max(LEFT_MIN, Math.min(LEFT_MAX, this.width * 0.26)));
  }

  private get turnH(): number {
    return Math.max(1, this.model.turnLanes) * TURN_LANE_H + 4;
  }

  private get topH(): number {
    const lanes = this.model.agentLanes;
    return AXIS_H + this.turnH + (lanes ? lanes * AGENT_LANE_H + 6 : 0);
  }

  private get plotW(): number {
    return Math.max(10, this.width - this.leftW);
  }

  private get plotH(): number {
    return Math.max(10, this.height - this.topH);
  }

  private x(ts: number): number {
    return this.xCt(this.model.axis.toCt(ts));
  }

  private xCt(ct: number): number {
    return this.width - (this.viewEnd - ct) * this.pxPerMs;
  }

  private ctAtX(x: number): number {
    return this.viewEnd - (this.width - x) / this.pxPerMs;
  }

  private nowCt(): number {
    return this.model.axis.nowCt(this.host.now());
  }

  /** Right edge while following: the cursor sits RIGHT_PAD from it, content starts at the left. */
  private followEnd(): number {
    const minEnd = (this.plotW - LEFT_PAD) / this.pxPerMs;
    return Math.max(this.nowCt() + RIGHT_PAD / this.pxPerMs, minEnd);
  }

  private maxScroll(): number {
    return Math.max(0, this.contentH - this.plotH + 8);
  }

  private resize(): void {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.fitCache.clear();
    this.dirty = true;
  }

  // ---------- frame loop ----------

  private loop = (): void => {
    if (!this.active) return;
    this.frame(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  private frame(now: number): void {
    if (this.width === 0 || this.height === 0) return;
    const m = this.model;
    let animating = false;
    if (m.version !== this.layoutVersion) {
      this.layoutVersion = m.version;
      const lay = layoutRows(m.groups, { groupH: GROUP_H, rowH: ROW_H, subH: SUB_H });
      this.items = lay.items;
      this.contentH = lay.height;
      this.itemByRow = new Map(lay.items.filter((i) => i.row).map((i) => [i.row!, i]));
      this.nextHeaderY = new Map();
      let prev: LayoutItem | null = null;
      for (const it of lay.items) {
        if (it.type !== 'group') continue;
        if (prev) this.nextHeaderY.set(prev.group, it.y);
        prev = it;
      }
      this.syncEmpty();
      this.dirty = true;
    }
    if (m.revision !== this.drawnRevision) {
      this.drawnRevision = m.revision;
      this.dirty = true;
      this.followNewestRow(now);
    }
    if (this.following) {
      const target = this.followEnd();
      const diff = target - this.viewEnd;
      // Glide over jumps (a pause got shortened), track the clock exactly otherwise.
      if (Math.abs(diff * this.pxPerMs) > 2) {
        this.viewEnd += diff * 0.22;
        animating = true;
      } else {
        this.viewEnd = target;
      }
    }
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY));
    const cursorX = Math.round(this.xCt(this.nowCt()) * 2) / 2;
    if (cursorX !== this.drawnCursorX) this.dirty = true;
    if (now - m.lastAddedAt < SLIDE_MS) animating = true;
    if (!this.dirty && !animating) return;
    this.dirty = false;
    this.drawnCursorX = cursorX;
    this.draw(now);
  }

  /** While following, scrolls so the row that just got a mark is on screen. */
  private followNewestRow(now: number): void {
    const row = this.model.lastRow;
    if (!this.following || !row || now < this.manualYUntil) return;
    if (this.layoutVersion !== this.model.version) return;
    const it = this.itemByRow.get(row);
    if (!it) return;
    if (it.y < this.scrollY) this.scrollY = Math.max(0, it.y - GROUP_H);
    else if (it.y + it.h > this.scrollY + this.plotH) this.scrollY = it.y + it.h - this.plotH + 8;
  }

  // ---------- drawing ----------

  private draw(now: number): void {
    const { ctx, width: w, height: h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);
    const left = this.leftW;
    const top = this.topH;
    const tsA = this.model.axis.toTs(this.ctAtX(left - 12));
    const tsB = this.model.axis.toTs(this.ctAtX(w + 12));
    const nowTs = this.host.now();

    // Plot: turns and pauses span the band area too; rows are clipped below it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, AXIS_H, w - left, h - AXIS_H);
    ctx.clip();
    this.drawTurnBands(tsA, tsB, nowTs, top);
    this.drawBreaks(top);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, w - left, h - top);
    ctx.clip();
    this.drawRows(now, tsA, tsB, left, top);
    ctx.restore();
    this.drawCursor(top);
    ctx.restore();

    // Top: axis, turn labels, subagent lanes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, w - left, top);
    ctx.clip();
    this.drawAxis(tsA, tsB);
    this.drawTurnLabels(tsA, tsB, nowTs);
    this.drawAgents(tsA, tsB, nowTs);
    this.drawIdle(nowTs);
    ctx.restore();

    // Left column.
    this.drawLeft(now, left, top);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top - 0.5);
    ctx.lineTo(w, top - 0.5);
    ctx.moveTo(left - 0.5, 0);
    ctx.lineTo(left - 0.5, h);
    ctx.stroke();
  }

  /** First layout item that reaches below vertical offset y. */
  private firstItem(y: number): number {
    return Math.max(0, upperBound(this.items, y, (it) => it.y) - 1);
  }

  private drawTurnBands(tsA: number, tsB: number, nowTs: number, top: number): void {
    const { ctx } = this;
    const turns = this.model.turns;
    // Turns are sorted by start; the ones that start after the view are skipped.
    const hi = upperBound(turns, tsB, (tu) => tu.startTs);
    for (let i = 0; i < hi; i++) {
      const tu = turns[i]!;
      const end = tu.endTs ?? nowTs;
      if (end < tsA) continue;
      const x0 = this.x(tu.startTs);
      const x1 = Math.max(x0 + 2, this.x(end));
      ctx.fillStyle = tu.index % 2 ? C.turnA : C.turnB;
      ctx.fillRect(x0, AXIS_H, x1 - x0, this.height);
      ctx.fillStyle = C.line;
      ctx.fillRect(Math.round(x0), top, 1, this.height - top);
    }
  }

  private drawTurnLabels(tsA: number, tsB: number, nowTs: number): void {
    const { ctx } = this;
    const turns = this.model.turns;
    const hi = upperBound(turns, tsB, (tu) => tu.startTs);
    ctx.font = SANS_SMALL;
    ctx.textBaseline = 'middle';
    const multi = this.model.multiSession;
    for (let i = 0; i < hi; i++) {
      const tu = turns[i]!;
      const end = tu.endTs ?? nowTs;
      if (end < tsA) continue;
      const x0 = this.x(tu.startTs);
      const x1 = Math.max(x0 + 2, this.x(end));
      const y = AXIS_H + 3 + tu.lane * TURN_LANE_H;
      const ph = TURN_LANE_H - 4;
      const hovered = this.hover?.type === 'turn' && this.hover.turn === tu;
      ctx.fillStyle = hovered ? 'rgba(148, 163, 184, 0.24)' : 'rgba(148, 163, 184, 0.13)';
      roundRect(ctx, x0 + 1, y, Math.max(2, x1 - x0 - 2), ph, 4);
      ctx.fill();
      let lx = Math.max(x0 + 6, this.leftW + 6);
      // Several sessions: a dot in the session's hue starts the pill.
      const tint = multi ? sessionPalette.peek(tu.sessionId) : undefined;
      if (tint && x1 - lx > 10) {
        ctx.fillStyle = tint;
        ctx.beginPath();
        ctx.arc(lx + 2.5, y + ph / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        lx += 9;
      }
      if (tu.fail) {
        ctx.fillStyle = FAIL_COLOR;
        ctx.fillRect(x1 - 3, y, 2, ph);
      }
      // Keep the label on screen while the turn starts left of the view.
      const room = x1 - lx - 6;
      if (room > 18) {
        ctx.fillStyle = C.turnText;
        ctx.fillText(this.fit(t('timeline.turn', { n: tu.index }), room, SANS_SMALL), lx, y + ph / 2 + 0.5);
      }
    }
  }

  private drawAgents(tsA: number, tsB: number, nowTs: number): void {
    const { ctx } = this;
    const agents = this.model.agents;
    if (!agents.length) return;
    ctx.font = MONO_SMALL;
    ctx.textBaseline = 'middle';
    const base = AXIS_H + this.turnH + 3;
    for (const a of agents) {
      const end = a.endTs ?? nowTs;
      if (a.startTs > tsB || end < tsA) continue;
      const x0 = this.x(a.startTs);
      const x1 = Math.max(x0 + 4, this.x(end));
      const y = base + a.lane * AGENT_LANE_H;
      const color = agentColor(a.agentId);
      const hovered = this.hover?.type === 'agent' && this.hover.agent === a;
      ctx.globalAlpha = hovered ? 1 : 0.78;
      ctx.fillStyle = color;
      roundRect(ctx, x0, y, x1 - x0, AGENT_LANE_H - 3, 3);
      ctx.fill();
      if (a.endTs === null) {
        // Still running: a soft fade at the open end.
        const g = ctx.createLinearGradient(x1 - 14, 0, x1, 0);
        g.addColorStop(0, 'rgba(5, 6, 10, 0)');
        g.addColorStop(1, 'rgba(5, 6, 10, 0.55)');
        ctx.fillStyle = g;
        ctx.fillRect(x1 - 14, y, 14, AGENT_LANE_H - 3);
      }
      ctx.globalAlpha = 1;
      const lx = Math.max(x0 + 4, this.leftW + 4);
      if (x1 - lx > 24) {
        ctx.fillStyle = '#05060a';
        ctx.fillText(this.fit(a.agentType || shortId(a.agentId), x1 - lx - 4, MONO_SMALL), lx, y + (AGENT_LANE_H - 3) / 2 + 0.5);
      }
    }
  }

  private drawAxis(tsA: number, tsB: number): void {
    const { ctx } = this;
    const axis = this.model.axis;
    if (axis.empty) return;
    let step = TICK_STEPS[TICK_STEPS.length - 1]!;
    for (const s of TICK_STEPS) {
      if (s * this.pxPerMs >= TICK_MIN_PX) {
        step = s;
        break;
      }
    }
    ctx.font = MONO_SMALL;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.muted;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    let tsTick = Math.ceil(tsA / step) * step;
    let guard = 0;
    let lastX = -Infinity;
    while (tsTick <= tsB && guard++ < 400) {
      const brk = axis.breakContaining(tsTick);
      if (brk) {
        tsTick = Math.ceil(brk.toTs / step) * step;
        continue;
      }
      const x = Math.round(this.x(tsTick)) + 0.5;
      if (x - lastX >= TICK_MIN_PX * 0.6) {
        ctx.beginPath();
        ctx.moveTo(x, AXIS_H - 5);
        ctx.lineTo(x, AXIS_H);
        ctx.stroke();
        ctx.fillText(tickLabel(tsTick, step), x + 4, AXIS_H / 2);
        lastX = x;
      }
      tsTick += step;
    }
  }

  private drawBreaks(top: number): void {
    const { ctx } = this;
    const breaks = this.model.axis.breaks;
    if (!breaks.length) return;
    const ctA = this.ctAtX(this.leftW);
    const ctB = this.ctAtX(this.width);
    const lo = Math.max(0, upperBound(breaks, ctA, (b) => b.toCt) - 1);
    for (let i = lo; i < breaks.length; i++) {
      const b = breaks[i]!;
      if (b.fromCt > ctB) break;
      const x0 = this.xCt(b.fromCt);
      const x1 = this.xCt(b.toCt);
      const hovered = this.hover?.type === 'break' && this.hover.brk === b;
      ctx.fillStyle = hovered ? 'rgba(100, 116, 139, 0.16)' : C.breakFill;
      ctx.fillRect(x0, AXIS_H, x1 - x0, this.height);
      // Zigzag "torn" edge in the axis strip.
      const mid = (x0 + x1) / 2;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 1;
      for (const dx of [-2, 2]) {
        ctx.beginPath();
        for (let y = AXIS_H, k = 0; y <= top; y += 4, k++) {
          const xx = mid + dx + (k % 2 ? 2 : -2);
          if (k === 0) ctx.moveTo(xx, y);
          else ctx.lineTo(xx, y);
        }
        ctx.stroke();
      }
    }
  }

  private drawIdle(nowTs: number): void {
    const axis = this.model.axis;
    if (axis.empty) return;
    const idle = nowTs - axis.lastTs;
    if (idle <= GAP_THRESHOLD_MS) return;
    const { ctx } = this;
    const x = this.xCt(this.nowCt());
    ctx.font = SANS_SMALL;
    ctx.textBaseline = 'middle';
    const label = t('timeline.idle', { time: formatSpan(idle) });
    const wText = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(5, 6, 10, 0.8)';
    ctx.fillRect(x - wText - 10, 3, wText + 8, AXIS_H - 6);
    ctx.fillStyle = C.turnText;
    ctx.fillText(label, x - wText - 6, AXIS_H / 2);
  }

  private drawCursor(top: number): void {
    const axis = this.model.axis;
    if (axis.empty) return;
    const { ctx } = this;
    const x = this.drawnCursorX;
    const g = ctx.createLinearGradient(x - 36, 0, x, 0);
    g.addColorStop(0, 'rgba(34, 211, 238, 0)');
    g.addColorStop(1, 'rgba(34, 211, 238, 0.09)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 36, top, 36, this.height - top);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.55)';
    ctx.fillRect(x - 0.5, AXIS_H, 1, this.height - AXIS_H);
  }

  private drawRows(now: number, tsA: number, tsB: number, left: number, top: number): void {
    const { ctx } = this;
    const items = this.items;
    if (!items.length) return;
    const y0 = this.scrollY;
    const y1 = this.scrollY + this.plotH;
    let i = this.firstItem(y0);
    const hoverRow = this.hover && 'row' in this.hover ? this.hover.row : null;
    for (; i < items.length; i++) {
      const it = items[i]!;
      if (it.y > y1) break;
      const y = top + it.y - y0;
      if (it.type === 'group') {
        ctx.fillStyle = C.group;
        ctx.fillRect(left, y, this.width - left, it.h);
        continue;
      }
      const row = it.row!;
      const p = row.addedAt ? Math.min(1, (now - row.addedAt) / SLIDE_MS) : 1;
      if (row === hoverRow) {
        ctx.fillStyle = C.hover;
        ctx.fillRect(left, y, this.width - left, it.h);
      }
      ctx.fillStyle = C.grid;
      ctx.fillRect(left, y + it.h - 1, this.width - left, 1);
      if (row.hasSub) {
        ctx.fillStyle = 'rgba(253, 224, 71, 0.03)';
        ctx.fillRect(left, y + ROW_H, this.width - left, SUB_H);
      }
      ctx.globalAlpha = easeOut(p);
      this.drawMarks(row, y, tsA, tsB);
      ctx.globalAlpha = 1;
    }
  }

  private drawMarks(row: TimelineRow, y: number, tsA: number, tsB: number): void {
    const { ctx } = this;
    const marks = row.marks;
    const margin = (MARK_R + 2) / this.pxPerMs;
    let lo = lowerBound(marks, tsA - margin, (m) => m.ts);
    const hi = Math.min(marks.length, upperBound(marks, tsB + margin, (m) => m.ts) + 1);
    if (lo > 0) lo--;
    const yMain = y + ROW_H / 2;
    const ySub = y + ROW_H + SUB_H / 2;
    // Joining lines first (Pre -> Post of the same call).
    for (let i = lo; i < hi; i++) {
      const m = marks[i]!;
      if (m.startTs === undefined) continue;
      const xa = this.x(m.startTs);
      const xb = this.x(m.ts);
      if (xb - xa < 3) continue;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha *= 0.4;
      ctx.lineWidth = m.agentId ? 1.5 : 2;
      ctx.beginPath();
      const yy = m.agentId ? ySub : yMain;
      ctx.moveTo(xa, yy);
      ctx.lineTo(xb, yy);
      ctx.stroke();
      ctx.globalAlpha /= 0.4;
    }
    let lastX = -Infinity;
    let lastKey = '';
    const hoverMark = this.hover?.type === 'mark' ? this.hover.mark : null;
    for (let i = lo; i < hi; i++) {
      const m = marks[i]!;
      const x = this.x(m.ts);
      const key = `${m.color}${m.filled}${m.agentId ?? ''}`;
      // Zoomed far out: marks closer than a pixel to an identical one add nothing.
      if (x - lastX < 0.8 && key === lastKey && m !== hoverMark) continue;
      lastX = x;
      lastKey = key;
      if (m.agentId) {
        ctx.strokeStyle = agentColor(m.agentId);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, ySub, SUB_R + 2, 0, Math.PI * 2);
        ctx.stroke();
        drawShape(ctx, m, x, ySub, SUB_R);
      } else {
        drawShape(ctx, m, x, yMain, MARK_R);
      }
      if (m === hoverMark) {
        ctx.strokeStyle = '#e0f2fe';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, m.agentId ? ySub : yMain, (m.agentId ? SUB_R : MARK_R) + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawLeft(now: number, left: number, top: number): void {
    const { ctx } = this;
    ctx.fillStyle = C.left;
    ctx.fillRect(0, 0, left, this.height);
    ctx.fillStyle = C.muted;
    ctx.font = SANS_SMALL;
    ctx.textBaseline = 'middle';
    const c = this.model.counts;
    if (c.rows) ctx.fillText(this.fit(t('timeline.rowsCount', { rows: tn('timeline.rows', c.rows), marks: tn('timeline.marks', c.marks) }), left - 20, SANS_SMALL), 12, AXIS_H / 2 + 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, left, this.height - top);
    ctx.clip();
    const items = this.items;
    const y0 = this.scrollY;
    const y1 = this.scrollY + this.plotH;
    const multi = this.model.multiSession;
    const hoverRow = this.hover?.type === 'row' || this.hover?.type === 'mark' ? this.hover.row : null;
    for (let i = this.firstItem(y0); i < items.length; i++) {
      const it = items[i]!;
      if (it.y > y1) break;
      const y = top + it.y - y0;
      if (it.type === 'group') {
        ctx.fillStyle = 'rgba(30, 58, 95, 0.32)';
        ctx.fillRect(0, y, left, it.h);
        ctx.font = MONO;
        ctx.fillStyle = C.groupText;
        ctx.fillText(this.fit(this.groupLabel(it.group.key), left - 22, MONO), 10, y + it.h / 2 + 1);
        continue;
      }
      const row = it.row!;
      const p = row.addedAt ? easeOut(Math.min(1, (now - row.addedAt) / SLIDE_MS)) : 1;
      const hovered = row === hoverRow;
      if (hovered) {
        ctx.fillStyle = C.hover;
        ctx.fillRect(0, y, left, it.h);
      }
      if (multi && row.sessions.length) {
        const segH = ROW_H / row.sessions.length;
        row.sessions.forEach((sid, k) => {
          ctx.fillStyle = sessionPalette.peek(sid) ?? C.muted;
          ctx.fillRect(0, y + k * segH, 3, segH);
        });
      }
      ctx.globalAlpha = p;
      ctx.font = MONO;
      ctx.fillStyle = row.kind === 'outside' || row.kind === 'skill' || row.kind === 'mcp' ? '#c4b5fd' : C.rowText;
      const graphable = this.graphable(row);
      const room = left - 30 - (hovered && graphable ? GRAPH_ICON_W : 0);
      ctx.fillText(this.fit(this.rowLabel(row), room, MONO), 20 - (1 - p) * 12, y + ROW_H / 2 + 1);
      if (row.hasSub) {
        ctx.font = SANS_SMALL;
        ctx.fillStyle = C.muted;
        ctx.fillText(t('timeline.subLane'), 28, y + ROW_H + SUB_H / 2);
      }
      ctx.globalAlpha = 1;
      if (hovered && graphable) {
        const graphHover = this.hover?.type === 'row' && this.hover.graph;
        drawTarget(ctx, left - GRAPH_ICON_W / 2 - 6, y + ROW_H / 2, graphHover ? '#a5f3fc' : C.turnText);
      }
    }
    // Sticky folder header: the group of the first visible row stays named at the top.
    const first = items[this.firstItem(y0)];
    if (first && y0 > 0 && !(first.type === 'group' && first.y >= y0)) {
      const next = this.nextHeaderY.get(first.group) ?? Infinity;
      const y = top + Math.min(0, next - y0 - GROUP_H);
      ctx.fillStyle = C.left;
      ctx.fillRect(0, y, left, GROUP_H);
      ctx.fillStyle = 'rgba(30, 58, 95, 0.42)';
      ctx.fillRect(0, y, left, GROUP_H);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(0, y + GROUP_H, left, 2);
      ctx.font = MONO;
      ctx.fillStyle = C.groupText;
      ctx.fillText(this.fit(this.groupLabel(first.group.key), left - 22, MONO), 10, y + GROUP_H / 2 + 1);
    }
    ctx.restore();
  }

  private graphable(row: TimelineRow): boolean {
    return row.kind === 'file' || row.kind === 'dir' || row.kind === 'outside';
  }

  private groupLabel(key: string): string {
    if (key === '') return t('timeline.rootGroup', { name: this.host.repoName() });
    if (key === OUTSIDE_GROUP) return t('timeline.outsideGroup');
    if (key === TOOLS_GROUP) return t('timeline.toolsGroup');
    return `${key}/`;
  }

  private rowLabel(row: TimelineRow): string {
    switch (row.kind) {
      case 'dir':
        return row.path === '' ? './' : `${baseName(row.path)}/`;
      case 'file':
        return baseName(row.path);
      case 'skill':
        return t('timeline.skillRow', { name: row.path });
      default:
        return row.path;
    }
  }

  private fullPath(row: TimelineRow): string {
    if (row.kind === 'dir') return row.path === '' ? `${this.host.repoName()}/` : `${row.path}/`;
    return row.path;
  }

  /** Middle-ellipsized text, cached (labels repeat every frame). */
  private fit(text: string, max: number, font: string): string {
    if (max <= 8) return '';
    const key = `${font}|${Math.round(max)}|${text}`;
    let out = this.fitCache.get(key);
    if (out === undefined) {
      if (this.fitCache.size > 4000) this.fitCache.clear();
      const ctx = this.ctx;
      const prev = ctx.font;
      ctx.font = font;
      out = ellipsizeMiddle(text, max, (s) => ctx.measureText(s).width);
      ctx.font = prev;
      this.fitCache.set(key, out);
    }
    return out;
  }

  private syncEmpty(): void {
    const show = this.model.isEmpty;
    this.empty.hidden = !show;
    if (!show) return;
    this.emptyTitle.textContent = t(this.filtered ? 'timeline.emptyFilteredTitle' : 'timeline.emptyTitle');
    this.emptyBody.textContent = t(this.filtered ? 'timeline.emptyFiltered' : 'timeline.emptyBody');
  }

  // ---------- interaction ----------

  private setFollowing(on: boolean): void {
    this.following = on;
    this.followBtn.setAttribute('aria-pressed', String(on));
  }

  follow(): void {
    this.setFollowing(true);
    this.manualYUntil = 0;
    this.dirty = true;
  }

  private zoomBy(factor: number, anchorX: number | null): void {
    const next = Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, this.pxPerMs * factor));
    if (next === this.pxPerMs) return;
    // Keep the time under the pointer (or the middle of the plot) in place.
    const ax = anchorX ?? this.leftW + this.plotW / 2;
    const ct = this.ctAtX(ax);
    this.pxPerMs = next;
    if (this.following) {
      // Live zoom stays live: "now" keeps its place at the right edge.
      this.viewEnd = this.followEnd();
    } else {
      this.viewEnd = ct + (this.width - ax) / this.pxPerMs;
      this.clampView();
    }
    this.dirty = true;
  }

  private panX(dxPx: number): void {
    if (dxPx === 0) return;
    this.setFollowing(false);
    this.viewEnd -= dxPx / this.pxPerMs;
    this.clampView();
    this.dirty = true;
  }

  private scrollBy(dyPx: number): void {
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dyPx));
    this.manualYUntil = performance.now() + MANUAL_Y_MS;
    this.dirty = true;
  }

  /**
   * No panning into the void: the first event stays at or left of its resting place and
   * "now" at or right of the right edge. Reaching "now" by hand turns following back on.
   */
  private clampView(): void {
    const minEnd = (this.plotW - LEFT_PAD) / this.pxPerMs;
    const maxEnd = Math.max(minEnd, this.followEnd());
    this.viewEnd = Math.max(minEnd, Math.min(maxEnd, this.viewEnd));
    if (!this.following && maxEnd - this.viewEnd < 1 / this.pxPerMs) this.setFollowing(true);
  }

  private local(ev: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private onDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const p = this.local(ev);
    this.drag = { x: p.x, y: p.y, end: this.viewEnd, scroll: this.scrollY, moved: false, id: ev.pointerId };
  }

  private onMove(ev: PointerEvent): void {
    const p = this.local(ev);
    this.pointer = p;
    const d = this.drag;
    if (d && d.id === ev.pointerId) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        this.canvas.setPointerCapture(ev.pointerId);
        this.canvas.classList.add('dragging');
        this.setHover(null);
      }
      if (d.moved) {
        if (d.x > this.leftW && Math.abs(dx) > 0) {
          this.setFollowing(false);
          this.viewEnd = d.end - dx / this.pxPerMs;
          this.clampView();
        }
        if (dy !== 0) {
          this.scrollY = Math.max(0, Math.min(this.maxScroll(), d.scroll - dy));
          this.manualYUntil = performance.now() + MANUAL_Y_MS;
        }
        this.dirty = true;
      }
      return;
    }
    this.setHover(this.hitAt(p.x, p.y));
  }

  private onUp(ev: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvas.classList.remove('dragging');
    if (!d || d.id !== ev.pointerId) return;
    if (d.moved) return;
    const p = this.local(ev);
    this.activate(this.hitAt(p.x, p.y));
  }

  private activate(hit: Hit | null): void {
    if (!hit) return;
    switch (hit.type) {
      case 'mark':
        this.host.openEvent(hit.mark.id);
        break;
      case 'row':
        if (hit.graph && this.graphable(hit.row)) this.host.showInGraph(hit.row.path);
        else if (this.graphable(hit.row)) this.host.openFile(hit.row.path);
        else {
          const last = hit.row.marks[hit.row.marks.length - 1];
          if (last) this.host.openEvent(last.id);
        }
        break;
      case 'turn':
        this.host.openEvent(hit.turn.eventId);
        break;
      case 'agent':
        if (hit.agent.eventId) this.host.openEvent(hit.agent.eventId);
        break;
      default:
        break;
    }
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const p = this.local(ev);
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? this.height : 1;
    const dx = ev.deltaX * unit;
    const dy = ev.deltaY * unit;
    if (p.x < this.leftW) {
      this.scrollBy(dy || dx);
      return;
    }
    if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      // Shift+wheel: rows. (Some systems turn it into deltaX already.)
      this.scrollBy(dy || dx);
      return;
    }
    if (!ev.ctrlKey && !ev.metaKey && Math.abs(dx) > Math.abs(dy)) {
      this.panX(-dx);
      return;
    }
    // Vertical wheel and pinch (ctrlKey wheel): zoom around the pointer.
    this.zoomBy(Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0025)), p.x);
  }

  private onKey(ev: KeyboardEvent): void {
    let handled = true;
    switch (ev.key) {
      case 'ArrowLeft':
        this.panX(80);
        break;
      case 'ArrowRight':
        this.panX(-80);
        break;
      case 'ArrowUp':
        this.scrollBy(-ROW_H * 2);
        break;
      case 'ArrowDown':
        this.scrollBy(ROW_H * 2);
        break;
      case '+':
      case '=':
        this.zoomBy(ZOOM_STEP, null);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / ZOOM_STEP, null);
        break;
      case 'f':
      case 'F':
      case 'End':
        this.follow();
        break;
      default:
        handled = false;
    }
    if (handled) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  private hitAt(x: number, y: number): Hit | null {
    if (this.width === 0) return null;
    const left = this.leftW;
    const top = this.topH;
    const axis = this.model.axis;
    if (y < top) {
      if (x < left) return null;
      const ts = axis.toTs(this.ctAtX(x));
      const nowTs = this.host.now();
      if (y < AXIS_H) {
        const brk = axis.breakAtCt(this.ctAtX(x));
        if (brk) return { type: 'break', brk };
        const idle = nowTs - axis.lastTs;
        const cx = this.xCt(this.nowCt());
        if (!axis.empty && idle > GAP_THRESHOLD_MS && x <= cx && x > cx - 140) return { type: 'idle', ms: idle };
        return null;
      }
      if (y < AXIS_H + this.turnH) {
        const lane = Math.min(Math.max(0, this.model.turnLanes - 1), Math.floor((y - AXIS_H - 3) / TURN_LANE_H));
        const turns = this.model.turns;
        for (let i = upperBound(turns, ts, (tu) => tu.startTs) - 1; i >= 0; i--) {
          const tu = turns[i]!;
          if (tu.lane !== lane) continue;
          return ts <= (tu.endTs ?? nowTs) ? { type: 'turn', turn: tu } : null;
        }
        return null;
      }
      const lane = Math.floor((y - AXIS_H - this.turnH - 3) / AGENT_LANE_H);
      for (const a of this.model.agents) {
        if (a.lane !== lane) continue;
        const x0 = this.x(a.startTs);
        const x1 = Math.max(x0 + 4, this.x(a.endTs ?? nowTs));
        if (x >= x0 - 2 && x <= x1 + 2) return { type: 'agent', agent: a };
      }
      return null;
    }
    const idx = itemAt(this.items, y - top + this.scrollY);
    if (idx < 0) return null;
    const it = this.items[idx]!;
    if (it.type === 'group') return x < left ? { type: 'group', item: it } : null;
    const row = it.row!;
    if (x < left) return { type: 'row', row, graph: this.graphable(row) && x >= left - GRAPH_ICON_W - 10 };
    const rowTop = top + it.y - this.scrollY;
    const sub = row.hasSub && y >= rowTop + ROW_H;
    const yLane = sub ? rowTop + ROW_H + SUB_H / 2 : rowTop + ROW_H / 2;
    const ts = axis.toTs(this.ctAtX(x));
    const span = (HIT_PX + 2) / this.pxPerMs;
    const marks = row.marks;
    let best: TimelineMark | null = null;
    let bestD = HIT_PX;
    for (let i = lowerBound(marks, ts - span * 4, (m) => m.ts); i < marks.length; i++) {
      const m = marks[i]!;
      if (m.ts > ts + span * 4) break;
      if (!!m.agentId !== sub) continue;
      // A Pre under its Post: the Post wins a near tie (it has the duration and the result).
      const d = Math.abs(this.x(m.ts) - x) + (m.phase === 'pre' ? 1.5 : 0);
      if (d <= bestD) {
        best = m;
        bestD = d;
      }
    }
    if (best) return { type: 'mark', mark: best, row, x: this.x(best.ts), y: yLane };
    return { type: 'row', row, graph: false };
  }

  private setHover(hit: Hit | null): void {
    const same =
      hit === this.hover ||
      (hit &&
        this.hover &&
        hit.type === this.hover.type &&
        ((hit.type === 'mark' && this.hover.type === 'mark' && hit.mark === this.hover.mark) ||
          (hit.type === 'row' && this.hover.type === 'row' && hit.row === this.hover.row && hit.graph === this.hover.graph) ||
          (hit.type === 'turn' && this.hover.type === 'turn' && hit.turn === this.hover.turn) ||
          (hit.type === 'agent' && this.hover.type === 'agent' && hit.agent === this.hover.agent) ||
          (hit.type === 'break' && this.hover.type === 'break' && hit.brk === this.hover.brk) ||
          (hit.type === 'group' && this.hover.type === 'group' && hit.item.group === this.hover.item.group) ||
          hit.type === 'idle'));
    if (same) {
      if (hit) this.placeTip();
      return;
    }
    this.hover = hit;
    this.dirty = true;
    const clickable = !!hit && (hit.type === 'mark' || hit.type === 'row' || hit.type === 'turn' || (hit.type === 'agent' && !!hit.agent.eventId));
    this.canvas.classList.toggle('clickable', clickable);
    if (hit) this.showTip(hit);
    else this.tip.hidden = true;
  }

  private showTip(hit: Hit): void {
    const lines: Array<{ text: string; cls?: string; color?: string }> = [];
    switch (hit.type) {
      case 'mark': {
        const m = hit.mark;
        const e = this.host.event(m.id);
        const label = m.phase === 'fail' ? `${actionLabel(m.action)} · ${failLabel()}` : `${actionLabel(m.action)} · ${phaseLabel(m.phase)}`;
        lines.push({ text: label, cls: 'tl-tip-head', color: m.color });
        lines.push({ text: this.fullPath(hit.row), cls: 'mono' });
        let when = formatClock(m.ts);
        if (m.startTs !== undefined) when += ` · ${t('timeline.took', { time: formatSpanShort(m.ts - m.startTs) })}`;
        lines.push({ text: when, cls: 'mono muted' });
        if (m.agentId) lines.push({ text: t('timeline.agent', { name: e?.agentType || shortId(m.agentId) }), color: agentColor(m.agentId) });
        if (e && isDenied(e)) lines.push({ text: t('feed.denied'), cls: 'fail' });
        const extra = e?.pattern ?? e?.description ?? (e && plainDetail(e));
        if (extra) lines.push({ text: extra.length > 120 ? `${extra.slice(0, 119)}…` : extra, cls: 'mono muted' });
        if (e?.error) lines.push({ text: e.error, cls: 'mono fail' });
        lines.push({ text: t('timeline.markHint'), cls: 'hint' });
        break;
      }
      case 'row':
        lines.push({ text: this.fullPath(hit.row), cls: 'mono' });
        lines.push({ text: tn('timeline.rowMarks', hit.row.marks.length, { time: formatClock(hit.row.firstTs).slice(0, 8) }), cls: 'muted' });
        if (this.graphable(hit.row)) lines.push({ text: hit.graph ? t('detail.showInGraph') : t('timeline.rowHint'), cls: 'hint' });
        else lines.push({ text: t('timeline.markHint'), cls: 'hint' });
        break;
      case 'group':
        lines.push({ text: this.groupLabel(hit.item.group.key), cls: 'mono' });
        lines.push({ text: tn('timeline.groupRows', hit.item.group.rows.length), cls: 'muted' });
        break;
      case 'turn': {
        const tu = hit.turn;
        lines.push({ text: t('timeline.turn', { n: tu.index }), cls: 'tl-tip-head' });
        if (tu.detail) lines.push({ text: tu.detail, cls: 'muted' });
        const dur = tu.endTs === null ? t('timeline.running') : formatSpan(tu.endTs - tu.startTs);
        lines.push({ text: `${formatClock(tu.startTs).slice(0, 8)} · ${dur}`, cls: 'mono muted' });
        if (tu.fail) lines.push({ text: failLabel(), cls: 'fail' });
        lines.push({ text: t('timeline.markHint'), cls: 'hint' });
        break;
      }
      case 'agent': {
        const a = hit.agent;
        lines.push({ text: t('timeline.agent', { name: a.agentType || shortId(a.agentId) }), cls: 'tl-tip-head', color: agentColor(a.agentId) });
        lines.push({ text: shortId(a.agentId, 10), cls: 'mono muted' });
        const dur = a.endTs === null ? t('timeline.running') : formatSpan(a.endTs - a.startTs);
        lines.push({ text: `${formatClock(a.startTs).slice(0, 8)} · ${dur}`, cls: 'mono muted' });
        break;
      }
      case 'break':
        lines.push({ text: t('timeline.gap', { time: formatSpan(hit.brk.toTs - hit.brk.fromTs) }) });
        break;
      case 'idle':
        lines.push({ text: t('timeline.idle', { time: formatSpan(hit.ms) }) });
        break;
    }
    this.tip.replaceChildren(
      ...lines.map((l) => {
        const div = document.createElement('div');
        if (l.cls) div.className = l.cls;
        if (l.color) div.style.setProperty('--c', l.color);
        div.textContent = l.text;
        return div;
      }),
    );
    this.tip.hidden = false;
    this.placeTip();
  }

  private placeTip(): void {
    const p = this.pointer;
    if (!p || this.tip.hidden) return;
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let x = p.x + 14;
    let y = p.y + 16;
    if (x + tw > this.width - 8) x = Math.max(8, p.x - tw - 14);
    if (y + th > this.height - 8) y = Math.max(8, p.y - th - 12);
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

/** Short duration for a single tool call ("320 ms", "4.2 s", "1 min 3 s"). */
function formatSpanShort(ms: number): string {
  if (ms < 1000) return t('detail.ms', { ms: Math.round(ms) });
  if (ms < 60_000) return t('detail.seconds', { s: (Math.round(ms / 100) / 10).toFixed(1) });
  return formatSpan(ms);
}

function easeOut(p: number): number {
  return 1 - (1 - p) ** 3;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
}

/** Small crosshair target: the "Show in graph" affordance on a hovered row. */
function drawTarget(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.moveTo(x - 8, y);
  ctx.lineTo(x - 3, y);
  ctx.moveTo(x + 3, y);
  ctx.lineTo(x + 8, y);
  ctx.moveTo(x, y - 8);
  ctx.lineTo(x, y - 3);
  ctx.moveTo(x, y + 3);
  ctx.lineTo(x, y + 8);
  ctx.stroke();
}

/** One mark: shape by action, filled for post/info, outlined for pre. */
function drawShape(ctx: CanvasRenderingContext2D, m: TimelineMark, x: number, y: number, r: number): void {
  ctx.fillStyle = m.color;
  ctx.strokeStyle = m.color;
  ctx.lineWidth = m.filled ? 1.8 : 1.2;
  const fillOrStroke = (): void => {
    if (m.filled) ctx.fill();
    else ctx.stroke();
  };
  switch (m.shape) {
    case 'dot':
      ctx.beginPath();
      ctx.arc(x, y, m.filled ? r : r - 0.6, 0, Math.PI * 2);
      fillOrStroke();
      break;
    case 'bar': {
      const bw = Math.max(3, r * 0.95);
      const bh = r * 2.7;
      if (m.filled) ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
      else ctx.strokeRect(x - bw / 2 + 0.5, y - bh / 2 + 0.5, bw - 1, bh - 1);
      break;
    }
    case 'ring':
      ctx.lineWidth = m.filled ? 2.2 : 1.1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'plus':
      ctx.lineWidth = m.filled ? 2.4 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x - r - 0.5, y);
      ctx.lineTo(x + r + 0.5, y);
      ctx.moveTo(x, y - r - 0.5);
      ctx.lineTo(x, y + r + 0.5);
      ctx.stroke();
      break;
    case 'cross':
      ctx.lineWidth = m.filled ? 2.4 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.stroke();
      break;
    case 'arrow':
      ctx.beginPath();
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r + 1, y);
      ctx.lineTo(x - r, y + r);
      ctx.lineTo(x - r * 0.35, y);
      ctx.closePath();
      fillOrStroke();
      break;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(x, y - r - 0.5);
      ctx.lineTo(x + r + 0.5, y);
      ctx.lineTo(x, y + r + 0.5);
      ctx.lineTo(x - r - 0.5, y);
      ctx.closePath();
      fillOrStroke();
      break;
    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(x, y - r - 1);
      ctx.lineTo(x + r + 0.5, y + r * 0.8);
      ctx.lineTo(x - r - 0.5, y + r * 0.8);
      ctx.closePath();
      fillOrStroke();
      break;
    case 'square':
      if (m.filled) ctx.fillRect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
      else ctx.strokeRect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
      break;
    case 'tick':
      ctx.lineWidth = m.filled ? 2 : 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y - r - 1);
      ctx.lineTo(x, y + r + 1);
      ctx.stroke();
      break;
  }
}
