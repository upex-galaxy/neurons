// 2D view: force-graph on a canvas, same model and effects as the 3D view. Halos, session
// rings and the active glow are drawn with nodeCanvasObjectMode 'after', only for glowing nodes.
import ForceGraph from 'force-graph';
import { Color } from 'three';
import { GlowBook, idleColor, newSample, type GlowSample } from './glow.ts';
import { DAG_LEVEL_DISTANCE } from './graph3d.ts';
import { TrailBook } from './linkGlow.ts';
import { ParticleTrack } from './particles2d.ts';
import {
  BACKGROUND,
  baseColor,
  baseOpacity,
  nodeRadius,
  type Renderer,
  type RendererOptions,
} from './renderer.ts';
import { ROOT_ID, type GraphData, type VizLink, type VizNode } from './treeModel.ts';

type Graph = ForceGraph<VizNode, VizLink>;

const LINK_RGBA = 'rgba(58, 86, 128, 0.35)';
const IDLE_BOOST_2D = 2.1;
/** force-graph sizes nodes as sqrt(val) * relSize. */
const REL_SIZE = 1;
const ALPHA_DECAY = 0.0228;
const CALM_ALPHA_DECAY = 0.08;
/** Zoom the 2D view eases to (at least) when focusing a node. */
const FOCUS_ZOOM = 2.4;

interface LinkFlash {
  link: VizLink;
  color: string;
  start: number;
  duration: number;
}

function css(c: Color, alpha: number): string {
  const r = Math.round(Math.min(1, c.r) * 255);
  const g = Math.round(Math.min(1, c.g) * 255);
  const b = Math.round(Math.min(1, c.b) * 255);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

function endpoint(end: string | VizNode): VizNode | null {
  return typeof end === 'object' ? end : null;
}

export function createGraph2D(container: HTMLElement, opts: RendererOptions): Renderer {
  const book = new GlowBook();
  const flashes: LinkFlash[] = [];
  const linksByKey = new Map<string, VizLink>();
  const trails = new TrailBook<null>(() => null);
  let calmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Own particle list: force-graph photons are wiped by graphData() and share one style per link. */
  const particles = new ParticleTrack();
  /** Per-frame samples of glowing nodes, filled in onRenderFramePre. */
  const frameSamples = new Map<string, GlowSample>();
  /** Idle color strings, cached per node until heat or flags change. */
  const idleCss = new Map<string, string>();
  const bases = new Map<string, Color>();
  const firstLayoutCbs: Array<() => void> = [];
  let firstLayoutDone = false;
  let zoomPending = false;
  let disposed = false;
  let paused = false;
  let nodesById = new Map<string, VizNode>();

  const scratch = new Color();

  const baseOf = (node: VizNode): Color => {
    let c = bases.get(node.id);
    if (!c) {
      // No bloom on canvas: idle nodes need more light to read on the dark backdrop.
      c = new Color(baseColor(node)).multiplyScalar(IDLE_BOOST_2D);
      bases.set(node.id, c);
    }
    return c;
  };

  const idleOf = (node: VizNode): string => {
    let s = idleCss.get(node.id);
    if (!s) {
      const heat = book.heat.get(node.id) ?? 0;
      idleColor(scratch, baseOf(node), heat);
      // Canvas has no bloom: heat also raises alpha a little.
      s = css(scratch, Math.min(1, baseOpacity(node) + heat * 0.2));
      idleCss.set(node.id, s);
    }
    return s;
  };

  const graph = new ForceGraph<VizNode, VizLink>(container);
  graph
    .backgroundColor(BACKGROUND)
    .width(container.clientWidth)
    .height(container.clientHeight)
    .nodeId('id')
    .nodeLabel((n: VizNode) => `<span class="node-tip">${opts.label(n)}</span>`)
    .nodeRelSize(REL_SIZE)
    .nodeVal((n: VizNode) => {
      const s = frameSamples.get(n.id);
      const r = nodeRadius(n) * (s ? Math.max(0.01, s.scale) : 1);
      return r * r;
    })
    .nodeColor((n: VizNode) => {
      const s = frameSamples.get(n.id);
      return s ? css(s.color, s.opacity) : idleOf(n);
    })
    .nodeCanvasObjectMode((n: VizNode) => (frameSamples.has(n.id) ? 'after' : undefined))
    .nodeCanvasObject((n: VizNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const s = frameSamples.get(n.id);
      if (!s || s.scale === 0) return;
      const r = nodeRadius(n) * s.scale;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      // Soft glow in place of the 3D bloom.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3);
      grad.addColorStop(0, css(s.color, 0.45 * s.opacity));
      grad.addColorStop(1, css(s.color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, Math.PI * 2);
      ctx.fill();
      if (s.halo && s.haloAlpha > 0) {
        ctx.strokeStyle = css(s.halo, s.haloAlpha);
        ctx.lineWidth = Math.max(1.2, 2.4 / Math.sqrt(scale));
        ctx.beginPath();
        ctx.arc(x, y, r + 2.2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.ring && s.ringAlpha > 0) {
        // Session tint: thinner and a little wider than a subagent halo.
        ctx.strokeStyle = css(s.ring, s.ringAlpha);
        ctx.lineWidth = Math.max(0.7, 1.3 / Math.sqrt(scale));
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    })
    .onNodeClick((n: VizNode) => opts.onNodeClick(n))
    .showPointerCursor((o: VizNode | VizLink | undefined) => !!o && 'kind' in o && opts.clickable(o))
    .linkColor(() => LINK_RGBA)
    .linkWidth(0.6)
    .linkDirectionalParticles(0)
    .dagMode('radialout')
    .dagLevelDistance(DAG_LEVEL_DISTANCE)
    .dagNodeFilter((n: VizNode) => !n.outside)
    .onDagError(() => {})
    .warmupTicks(80)
    .cooldownTicks(100)
    // Particles and glows animate even when the layout is still.
    .autoPauseRedraw(false)
    .onRenderFramePre((ctx: CanvasRenderingContext2D, scale: number) => {
      // Sample glows once per frame; only glowing nodes are touched.
      const now = performance.now();
      // Lingering trails: only the links that were touched.
      if (trails.size) {
        ctx.save();
        ctx.lineWidth = 2.2 / Math.sqrt(scale);
        ctx.lineCap = 'round';
        trails.step(now, (trail, alpha) => {
          const link = linksByKey.get(trail.key);
          const s = link && endpoint(link.source);
          const e = link && endpoint(link.target);
          if (!s || !e) return;
          ctx.globalAlpha = 0.8 * alpha;
          ctx.strokeStyle = trail.color;
          ctx.beginPath();
          ctx.moveTo(s.x ?? 0, s.y ?? 0);
          ctx.lineTo(e.x ?? 0, e.y ?? 0);
          ctx.stroke();
        });
        ctx.restore();
      }
      for (const id of [...book.ids()]) {
        const node = nodesById.get(id);
        let s = frameSamples.get(id);
        if (!s) {
          s = newSample();
          frameSamples.set(id, s);
        }
        idleColor(scratch, node ? baseOf(node) : scratch.set('#000000'), book.heat.get(id) ?? 0);
        book.sample(id, scratch, node ? baseOpacity(node) : 1, now, s);
        if (!s.alive && s.scale !== 0) frameSamples.delete(id);
      }
    })
    .onRenderFramePost((ctx: CanvasRenderingContext2D, scale: number) => {
      const now = performance.now();
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]!;
        const t = (now - f.start) / f.duration;
        const s = endpoint(f.link.source);
        const e = endpoint(f.link.target);
        if (t >= 1 || !s || !e) {
          flashes.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 3 / Math.sqrt(scale);
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(e.x ?? 0, e.y ?? 0);
        ctx.stroke();
        ctx.restore();
      }
      // Each particle keeps the color, width and halo it was emitted with.
      const root = Math.sqrt(scale);
      particles.step(now, (x, y, p) => {
        const r = Math.max(0.8, (p.width * 0.9) / root);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (p.halo) {
          ctx.strokeStyle = p.halo;
          ctx.lineWidth = Math.max(0.8, 1.4 / root);
          ctx.beginPath();
          ctx.arc(x, y, r + 2, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    })
    .onEngineTick(() => {
      if (!firstLayoutDone) {
        firstLayoutDone = true;
        for (const cb of firstLayoutCbs.splice(0)) cb();
      }
    })
    .onEngineStop(() => {
      if (zoomPending) {
        zoomPending = false;
        graph.zoomToFit(600, 40);
      }
    });

  const observer = new ResizeObserver(() => {
    if (!disposed) graph.width(container.clientWidth).height(container.clientHeight);
  });
  observer.observe(container);

  const renderer: Renderer = {
    kind: '2d',
    setData(data: GraphData, initial: boolean) {
      nodesById = new Map(data.nodes.map((n) => [n.id, n]));
      if (initial) {
        book.clear();
        frameSamples.clear();
        particles.clear();
        const root = nodesById.get(ROOT_ID);
        if (root) {
          root.fx = 0;
          root.fy = 0;
        }
        graph.warmupTicks(80);
        zoomPending = true;
        setTimeout(() => !disposed && graph.zoomToFit(400, 40), 300);
      } else {
        graph.warmupTicks(0);
      }
      if (initial) trails.clear();
      graph.graphData(data);
      // Particles in flight survive structural updates on links that are still there.
      particles.retain(new Set(data.links));
      const live = graph.graphData().links;
      linksByKey.clear();
      for (const l of live) linksByKey.set(l.key, l);
      for (const key of trails.keys()) if (!linksByKey.has(key)) trails.drop(key);
      return live;
    },
    emitParticle(link, style) {
      // Paused (the Timeline covers the graph): no frame prunes them, so they would pile up.
      if (paused) return;
      particles.add(link, style, performance.now());
    },
    pulse(id, color, o) {
      book.pulse(id, color, o);
    },
    fadeOut(id) {
      book.fadeOut(id);
    },
    cancelFade(id) {
      if (book.isFading(id)) book.delete(id);
      // A finished fade leaves a scale-0 sample behind that would keep the node invisible.
      if (!book.has(id)) frameSamples.delete(id);
    },
    flashLink(link, color, durationMs) {
      if (paused) return;
      flashes.push({ link, color, start: performance.now(), duration: durationMs });
    },
    trailLinks(links, color, durationMs) {
      const now = performance.now();
      for (const link of links) {
        linksByKey.set(link.key, link);
        trails.touch(link.key, color, durationMs, now);
      }
    },
    focus(node, ms) {
      graph.centerAt(node.x ?? 0, node.y ?? 0, ms);
      if (graph.zoom() < FOCUS_ZOOM) graph.zoom(FOCUS_ZOOM, ms);
    },
    calm(ms) {
      graph.d3AlphaDecay(CALM_ALPHA_DECAY);
      if (calmTimer !== null) clearTimeout(calmTimer);
      calmTimer = setTimeout(() => {
        calmTimer = null;
        if (!disposed) graph.d3AlphaDecay(ALPHA_DECAY);
      }, ms);
    },
    forget(ids) {
      for (const id of ids) {
        book.delete(id);
        frameSamples.delete(id);
        idleCss.delete(id);
        bases.delete(id);
      }
    },
    refreshNode(node) {
      bases.delete(node.id);
      idleCss.delete(node.id);
    },
    setHeat(heat) {
      for (const id of book.heat.keys()) idleCss.delete(id);
      book.heat.clear();
      for (const [id, v] of heat) {
        book.heat.set(id, v);
        idleCss.delete(id);
      }
    },
    activeIds() {
      return [...book.ids()];
    },
    screenCoords(node) {
      const p = graph.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
      return { x: p.x, y: p.y };
    },
    onFirstLayout(cb) {
      if (firstLayoutDone) cb();
      else firstLayoutCbs.push(cb);
    },
    zoomToFit(ms = 600) {
      graph.zoomToFit(ms, 40);
    },
    setPaused(p) {
      if (p === paused || disposed) return;
      paused = p;
      if (p) graph.pauseAnimation();
      else graph.width(container.clientWidth).height(container.clientHeight).resumeAnimation();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      particles.clear();
      trails.clear();
      if (calmTimer !== null) clearTimeout(calmTimer);
      graph._destructor();
      container.replaceChildren();
    },
  };
  return renderer;
}
