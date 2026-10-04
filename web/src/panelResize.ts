// Resizable side panel: a drag handle on its left edge (mouse, touch or ←/→ when focused),
// width kept in localStorage and applied through the --panel-w CSS variable, so the stage
// and the graph canvas (ResizeObserver) follow. Below the narrow breakpoint the panel is a
// sheet over the stage and the handle is hidden.
import { t } from './i18n.ts';

export const PANEL_MIN = 280;
export const PANEL_MAX = 720;
/** The panel never takes more than this share of the viewport. */
export const PANEL_MAX_VW = 0.6;
export const PANEL_DEFAULT = 360;
export const PANEL_STEP = 16;
export const PANEL_WIDTH_KEY = 'neurons.panelWidth';
export const NARROW_QUERY = '(max-width: 760px)';

/** Clamps to [280, min(720, 60vw)]; the minimum wins on viewports too small for both. */
export function clampPanelWidth(px: number, viewport: number): number {
  const max = Math.min(PANEL_MAX, Math.floor(viewport * PANEL_MAX_VW));
  const v = Number.isFinite(px) ? Math.round(px) : PANEL_DEFAULT;
  return Math.max(PANEL_MIN, Math.min(v, max));
}

function readStored(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function store(px: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(px));
  } catch {
    // Storage blocked: the width lasts for this page only.
  }
}

export class PanelResizer {
  private width: number;
  /** What the user asked for; re-clamped against the viewport on window resize. */
  private wanted: number;

  constructor(
    private readonly handle: HTMLElement,
    private readonly onChange: (px: number) => void,
  ) {
    this.wanted = readStored() ?? PANEL_DEFAULT;
    this.width = clampPanelWidth(this.wanted, window.innerWidth);
    this.apply(false);

    handle.addEventListener('pointerdown', (ev) => this.drag(ev));
    handle.addEventListener('dblclick', () => this.set(PANEL_DEFAULT));
    handle.addEventListener('keydown', (ev) => {
      // The handle sits on the left edge: moving it left widens the panel.
      if (ev.key === 'ArrowLeft') this.set(this.width + PANEL_STEP);
      else if (ev.key === 'ArrowRight') this.set(this.width - PANEL_STEP);
      else if (ev.key === 'Home') this.set(PANEL_MIN);
      else if (ev.key === 'End') this.set(PANEL_MAX);
      else if (ev.key === 'Enter') this.set(PANEL_DEFAULT);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
    window.addEventListener('resize', () => {
      const next = clampPanelWidth(this.wanted, window.innerWidth);
      if (next !== this.width) {
        this.width = next;
        this.apply(false);
      }
    });
    this.relabel();
  }

  get value(): number {
    return this.width;
  }

  set(px: number): void {
    this.wanted = clampPanelWidth(px, window.innerWidth);
    this.width = this.wanted;
    this.apply(true);
  }

  relabel(): void {
    this.handle.setAttribute('aria-label', t('panel.resize'));
    this.handle.title = t('panel.resizeTitle');
  }

  private apply(persist: boolean): void {
    document.documentElement.style.setProperty('--panel-w', `${this.width}px`);
    this.handle.setAttribute('aria-valuenow', String(this.width));
    this.handle.setAttribute('aria-valuemin', String(PANEL_MIN));
    this.handle.setAttribute('aria-valuemax', String(clampPanelWidth(PANEL_MAX, window.innerWidth)));
    if (persist) store(this.width);
    this.onChange(this.width);
  }

  private drag(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = this.width;
    this.handle.setPointerCapture(ev.pointerId);
    document.body.classList.add('resizing');
    let raf = 0;
    let next = startW;
    const move = (e: PointerEvent): void => {
      next = startW + (startX - e.clientX);
      // One layout per frame: the canvas resize is the expensive part.
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.wanted = clampPanelWidth(next, window.innerWidth);
        this.width = this.wanted;
        this.apply(false);
      });
    };
    const up = (e: PointerEvent): void => {
      this.handle.releasePointerCapture(e.pointerId);
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
      this.handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      if (raf) cancelAnimationFrame(raf);
      this.set(next);
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
  }
}
