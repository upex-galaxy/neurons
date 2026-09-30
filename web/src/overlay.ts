// Always-on labels for a handful of nodes (root, top-level dirs, outside hub): a light HTML
// overlay repositioned each frame. Every other node only has a hover label.
import type { Renderer } from './renderer.ts';
import type { VizNode } from './treeModel.ts';

export const MAX_OVERLAY_LABELS = 30;
/** Rough monospace metrics of .node-label, for overlap checks without measuring the DOM. */
const LABEL_CHAR_PX = 6.7;
const LABEL_LINE_PX = 14;

export interface OverlayItem {
  node: VizNode;
  text: string;
  kind: 'root' | 'dir' | 'hub';
}

interface Placed {
  item: OverlayItem;
  el: HTMLDivElement;
  x: number;
  y: number;
  shown: boolean;
}

export class LabelOverlay {
  private readonly layer: HTMLDivElement;
  private placed: Placed[] = [];
  private raf = 0;
  private dirty = false;

  constructor(
    parent: HTMLElement,
    private readonly view: () => Renderer | null,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'label-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    parent.append(this.layer);
    const tick = (): void => {
      this.position();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  set(items: OverlayItem[]): void {
    const byId = new Map(this.placed.map((p) => [p.item.node.id, p]));
    const next: Placed[] = [];
    for (const item of items.slice(0, MAX_OVERLAY_LABELS)) {
      let p = byId.get(item.node.id);
      if (p) {
        byId.delete(item.node.id);
        p.item = item;
      } else {
        const el = document.createElement('div');
        p = { item, el, x: -1, y: -1, shown: false };
        el.style.visibility = 'hidden';
        this.layer.append(el);
      }
      p.el.className = `node-label ${item.kind}${item.node.collapsed ? ' collapsed' : ''}`;
      if (p.el.textContent !== item.text) p.el.textContent = item.text;
      next.push(p);
    }
    for (const gone of byId.values()) gone.el.remove();
    this.placed = next;
    this.dirty = true;
  }

  private position(): void {
    const view = this.view();
    if (!view) return;
    let moved = false;
    for (const p of this.placed) {
      const c = view.screenCoords(p.item.node);
      if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
        if (p.x !== -1e6) moved = true;
        p.x = -1e6;
        continue;
      }
      // Skip sub-pixel moves to keep style writes down once the layout settles.
      if (Math.abs(c.x - p.x) < 0.5 && Math.abs(c.y - p.y) < 0.5) continue;
      p.x = c.x;
      p.y = c.y;
      p.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
      moved = true;
    }
    if (moved || this.dirty) {
      this.dirty = false;
      this.declutter();
    }
  }

  /** Hides labels that would overlap one placed before them (list order = priority). */
  private declutter(): void {
    const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    for (const p of this.placed) {
      let show = p.x > -1e5;
      if (show) {
        const w = p.item.text.length * LABEL_CHAR_PX;
        const box = { x0: p.x + 8, y0: p.y + 8, x1: p.x + 8 + w, y1: p.y + 8 + LABEL_LINE_PX };
        show = !boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
        if (show) boxes.push(box);
      }
      if (show !== p.shown) {
        p.el.style.visibility = show ? 'visible' : 'hidden';
        p.shown = show;
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.layer.remove();
  }
}
