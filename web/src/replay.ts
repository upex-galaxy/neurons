// Replay controller: loads /api/log, rebuilds the tree of the chosen segment and plays
// events and tree deltas on a compressed clock scaled by speed (1x/2x/5x).
import type { LogLine, TreeEntry, TreeSnapshot, VizEvent } from '../../src/shared/types.ts';
import { t, tn, type Params } from './i18n.ts';
import { formatClock } from './panel.ts';
import { MAX_GAP_MS, buildTimeline, indexAt, segmentStarts, type Timeline } from './replayTimeline.ts';
import { vizState } from './state.ts';

export const SPEEDS = [1, 2, 5] as const;
/** Longest frame step the clock accepts, so a hidden tab does not dump a burst on return. */
const MAX_STEP_MS = 250;

export interface ReplayHost {
  /** Resets model, feed and counters to `tree` (not rendered until commit). */
  begin(tree: TreeSnapshot): void;
  event(e: VizEvent, animate: boolean): void;
  delta(added: TreeEntry[], removed: string[], animate: boolean): void;
  /** A later 'tree' line in the log: replace the tree, keep feed and counters. */
  snapshot(tree: TreeSnapshot, animate: boolean): void;
  /** Renders after begin() and any silent items. */
  commit(): void;
  /** Leaves replay (live mode only). */
  exit(): void;
  /** Tree to use when the log has no 'tree' line. */
  fallbackTree(): TreeSnapshot | null;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class ReplayController {
  private lines: LogLine[] = [];
  private timeline: Timeline | null = null;
  private playhead = 0;
  private index = 0;
  private playing = false;
  private speed = 1;
  private segment = 0;
  private raf = 0;
  private last = 0;
  private canExit = true;
  /** Message key and params, kept so a language change can redraw it. */
  private message: { key: string; params?: Params } | null = null;

  private readonly bar = el('replay-bar');
  private readonly playBtn = el<HTMLButtonElement>('rp-play');
  private readonly restartBtn = el<HTMLButtonElement>('rp-restart');
  private readonly exitBtn = el<HTMLButtonElement>('rp-exit');
  private readonly progress = el('rp-progress');
  private readonly fill = el('rp-fill');
  private readonly time = el('rp-time');
  private readonly clock = el('rp-clock');
  private readonly note = el('rp-note');
  private readonly segSel = el<HTMLSelectElement>('rp-segment');
  private readonly msg = el('rp-msg');

  constructor(private readonly host: ReplayHost) {
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    this.restartBtn.addEventListener('click', () => this.restart());
    this.exitBtn.addEventListener('click', () => this.exit());
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.addEventListener('click', () => this.setSpeed(Number(btn.dataset.speed)));
    }
    this.progress.addEventListener('click', (ev) => {
      const r = this.progress.getBoundingClientRect();
      if (r.width > 0) this.seek((ev.clientX - r.left) / r.width);
    });
    this.progress.addEventListener('keydown', (ev) => {
      const d = this.timeline?.durationMs ?? 0;
      if (!d) return;
      if (ev.key === 'ArrowRight') this.seek((this.playhead + 5000) / d);
      else if (ev.key === 'ArrowLeft') this.seek((this.playhead - 5000) / d);
    });
    this.segSel.addEventListener('change', () => {
      this.segment = Number(this.segSel.value);
      this.rebuild();
      this.play();
    });
  }

  get active(): boolean {
    return vizState.replay.active;
  }

  /**
   * Original epoch ms at the playhead: the last applied line's time plus the playhead's
   * progress since, never past the next line. Null without a loaded timeline.
   */
  get clockTs(): number | null {
    const tl = this.timeline;
    if (!tl) return null;
    const cur = this.index > 0 ? tl.items[this.index - 1] : undefined;
    const next = tl.items[this.index];
    const base = cur ? cur.ts : tl.startTs;
    const ts = base + Math.max(0, this.playhead - (cur?.t ?? 0));
    return next ? Math.min(ts, Math.max(base, next.ts)) : ts;
  }

  /** Loads the log and starts playing from the first segment. */
  async start(opts: { canExit: boolean }): Promise<void> {
    this.canExit = opts.canExit;
    this.exitBtn.hidden = !opts.canExit;
    this.bar.hidden = false;
    document.body.classList.add('replaying');
    vizState.replay.active = true;
    vizState.mode = 'replay';
    this.setMessage('replay.loading');
    let lines: LogLine[];
    try {
      const res = await fetch('./api/log', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error(t('replay.badFormat'));
      lines = body as LogLine[];
    } catch (err) {
      this.setMessage('replay.loadError', { error: err instanceof Error ? err.message : String(err) });
      this.updateUi();
      return;
    }
    this.lines = lines;
    const starts = segmentStarts(lines);
    this.fillSegments();
    this.segSel.hidden = starts.length < 2;
    this.segment = 0;
    this.segSel.value = '0';
    vizState.replay.segments = Math.max(1, starts.length);
    if (!this.rebuild()) return;
    this.setMessage(lines.length ? '' : 'replay.empty');
    this.play();
  }

  /** Resets to the segment's tree at t = 0. */
  private rebuild(): boolean {
    const tl = buildTimeline(this.lines, this.segment, this.host.fallbackTree());
    if (!tl) {
      this.setMessage('replay.noTree');
      this.timeline = null;
      this.updateUi();
      return false;
    }
    this.timeline = tl;
    this.playhead = 0;
    this.index = 0;
    this.host.begin(tl.tree);
    this.host.commit();
    this.renderNote();
    vizState.replay.segment = this.segment;
    vizState.replay.compressedGaps = tl.compressedGaps;
    this.updateUi();
    return true;
  }

  play(): void {
    if (!this.timeline) return;
    if (this.index >= this.timeline.items.length && this.playhead >= this.timeline.durationMs) this.rebuild();
    this.playing = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.updateUi();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.updateUi();
  }

  /** Back to t = 0 and plays. */
  restart(): void {
    if (!this.timeline) return;
    this.pause();
    this.rebuild();
    this.play();
  }

  setSpeed(speed: number): void {
    if (!SPEEDS.includes(speed as (typeof SPEEDS)[number])) return;
    this.speed = speed;
    this.updateUi();
  }

  /** Jumps to a fraction of the timeline: rebuilds silently up to that point. */
  seek(fraction: number): void {
    const tl = this.timeline;
    if (!tl) return;
    const target = Math.max(0, Math.min(1, fraction)) * tl.durationMs;
    this.host.begin(tl.tree);
    const upto = indexAt(tl.items, target);
    for (let i = 0; i < upto; i++) this.dispatch(i, false);
    this.index = upto;
    this.playhead = target;
    this.host.commit();
    this.last = performance.now();
    this.updateUi();
  }

  exit(): void {
    if (!this.canExit) return;
    this.pause();
    this.timeline = null;
    this.lines = [];
    this.bar.hidden = true;
    document.body.classList.remove('replaying');
    Object.assign(vizState.replay, { active: false, playing: false, index: 0, total: 0, elapsedMs: 0, durationMs: 0 });
    this.host.exit();
  }

  private readonly tick = (now: number): void => {
    const tl = this.timeline;
    if (!this.playing || !tl) return;
    const dt = Math.min(MAX_STEP_MS, Math.max(0, now - this.last));
    this.last = now;
    this.playhead = Math.min(tl.durationMs, this.playhead + dt * this.speed);
    while (this.index < tl.items.length && tl.items[this.index]!.t <= this.playhead) {
      this.dispatch(this.index, true);
      this.index++;
    }
    if (this.index >= tl.items.length && this.playhead >= tl.durationMs) {
      this.playing = false;
      this.updateUi();
      return;
    }
    this.updateUi();
    this.raf = requestAnimationFrame(this.tick);
  };

  private dispatch(i: number, animate: boolean): void {
    const item = this.timeline?.items[i];
    if (!item) return;
    const line = item.line;
    switch (line.kind) {
      case 'event':
        this.host.event(line.event, animate);
        break;
      case 'treeDelta':
        this.host.delta(line.added, line.removed, animate);
        break;
      case 'tree':
        this.host.snapshot(line.tree, animate);
        break;
    }
  }

  private setMessage(key: string, params?: Params): void {
    this.message = key ? { key, ...(params ? { params } : {}) } : null;
    const text = key ? t(key, params) : '';
    this.msg.textContent = text;
    this.msg.hidden = !text;
  }

  private fillSegments(): void {
    const lines = this.lines;
    const starts = segmentStarts(lines);
    this.segSel.replaceChildren(
      ...starts.map((idx, i) => {
        const line = lines[idx] as Extract<LogLine, { kind: 'tree' }>;
        return new Option(t('replay.segment', { n: i + 1, time: formatClock(line.ts).slice(0, 8) }), String(i));
      }),
    );
    this.segSel.value = String(this.segment);
  }

  private renderNote(): void {
    const tl = this.timeline;
    const gaps = tl?.compressedGaps ?? 0;
    this.note.hidden = gaps === 0;
    this.note.textContent =
      gaps === 0 || !tl ? '' : tn('replay.gaps', gaps, { max: MAX_GAP_MS / 1000, saved: mmss(tl.savedMs) });
  }

  /** Redraws the generated strings after a language change. */
  relabel(): void {
    if (this.message) this.setMessage(this.message.key, this.message.params);
    if (this.lines.length) this.fillSegments();
    this.renderNote();
    this.updateUi();
  }

  private updateUi(): void {
    const tl = this.timeline;
    const total = tl?.items.length ?? 0;
    const duration = tl?.durationMs ?? 0;
    Object.assign(vizState.replay, {
      playing: this.playing,
      speed: this.speed,
      index: this.index,
      total,
      elapsedMs: Math.round(this.playhead),
      durationMs: duration,
    });
    const frac = duration > 0 ? this.playhead / duration : total > 0 && this.index >= total ? 1 : 0;
    this.fill.style.transform = `scaleX(${frac.toFixed(4)})`;
    this.progress.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    const timeText = `${mmss(this.playhead)} / ${mmss(duration)}`;
    if (this.time.textContent !== timeText) this.time.textContent = timeText;
    const cur = tl?.items[Math.max(0, this.index - 1)];
    const c = cur ? formatClock(cur.ts).slice(0, 8) : tl ? formatClock(tl.startTs).slice(0, 8) : '';
    if (this.clock.textContent !== c) this.clock.textContent = c;
    const label = t(this.playing ? 'replay.pause' : 'replay.play');
    if (this.playBtn.textContent !== label) this.playBtn.textContent = label;
    this.playBtn.setAttribute('aria-pressed', String(this.playing));
    for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.speed) === this.speed));
    }
  }
}
