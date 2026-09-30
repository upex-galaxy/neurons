// 3D view: 3d-force-graph with bloom, per-node glow, subagent halos and event particles.
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GlowBook, idleColor, newSample } from './glow.ts';
import {
  BACKGROUND,
  LINK_COLOR,
  baseColor,
  baseOpacity,
  nodeRadius,
  type ParticleStyle,
  type Renderer,
  type RendererOptions,
} from './renderer.ts';
import { OUTSIDE_HUB_ID, ROOT_ID, type GraphData, type VizLink, type VizNode } from './treeModel.ts';

type Graph = ForceGraph3DInstance<VizNode, VizLink>;

const BLOOM = { strength: 1.4, radius: 0.6, threshold: 0.05 };
export const DAG_LEVEL_DISTANCE = 40;

// Unit spheres scaled per node, shared by every node (the library may dispose them on
// node removal; three re-uploads them on the next frame).
const UNIT_LOW = new SphereGeometry(1, 6, 6);
const UNIT_HIGH = new SphereGeometry(1, 10, 8);

interface NodeMesh extends Mesh<SphereGeometry, MeshBasicMaterial> {
  userData: { id: string; base: Color; radius: number; opacity: number; halo?: Sprite };
}

let ringBase: CanvasTexture | null = null;
/**
 * A soft ring on a transparent canvas, used for subagent halos. Each user gets a clone:
 * clones share one GPU upload, and the library disposes the clone with its sprite.
 */
function ringTexture(): CanvasTexture {
  if (!ringBase) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const c = canvas.getContext('2d')!;
    c.strokeStyle = '#ffffff';
    c.shadowColor = '#ffffff';
    c.shadowBlur = 6;
    c.lineWidth = 5;
    c.beginPath();
    c.arc(32, 32, 24, 0, Math.PI * 2);
    c.stroke();
    ringBase = new CanvasTexture(canvas);
  }
  return ringBase.clone();
}

function haloSprite(color: Color): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({ map: ringTexture(), color, transparent: true, depthWrite: false, blending: AdditiveBlending }),
  );
  sprite.renderOrder = 2;
  return sprite;
}

interface LinkFlash {
  line: Line<BufferGeometry, LineBasicMaterial>;
  link: VizLink;
  start: number;
  duration: number;
}

function endpoint(end: string | VizNode): VizNode | null {
  return typeof end === 'object' ? end : null;
}

export function createGraph3D(container: HTMLElement, opts: RendererOptions): Renderer {
  const meshes = new Map<string, NodeMesh>();
  const book = new GlowBook();
  const flashes: LinkFlash[] = [];
  const firstLayoutCbs: Array<() => void> = [];
  let firstLayoutDone = false;
  let zoomPending = false;
  let zoomedAfterWarmup = false;
  let disposed = false;
  let rafId = 0;

  // Particles: shared geometry per width and shared material per color+width. The library
  // removes an arrived particle but only disposes its children (the halo sprite).
  const particleGeoms = new Map<number, SphereGeometry>();
  const particleMats = new Map<string, MeshBasicMaterial>();

  const makeNodeObject = (node: VizNode): Object3D => {
    const high = node.id === ROOT_ID || node.id === OUTSIDE_HUB_ID;
    const material = new MeshBasicMaterial({ color: new Color(), transparent: true, depthWrite: false });
    const mesh = new Mesh(high ? UNIT_HIGH : UNIT_LOW, material) as unknown as NodeMesh;
    mesh.userData = { id: node.id, base: new Color(baseColor(node)), radius: nodeRadius(node), opacity: baseOpacity(node) };
    meshes.set(node.id, mesh);
    applyIdle(mesh);
    if (book.has(node.id)) mesh.visible = true;
    return mesh;
  };

  const makeParticle = (link: VizLink): Object3D => {
    const width = link.__pWidth ?? 2.5;
    const colorHex = link.__pColor ?? '#ffffff';
    let geom = particleGeoms.get(width);
    if (!geom) {
      geom = new SphereGeometry(width / 2, 6, 6);
      particleGeoms.set(width, geom);
    }
    const key = `${colorHex}|${width}`;
    let mat = particleMats.get(key);
    if (!mat) {
      const color = new Color(colorHex);
      // Push the color above 1 so the bloom pass picks particles up strongly.
      color.multiplyScalar(width >= 2 ? 1.6 : 1.1);
      mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false });
      particleMats.set(key, mat);
    }
    const mesh = new Mesh(geom, mat);
    if (link.__pHalo) {
      const sprite = haloSprite(new Color(link.__pHalo).multiplyScalar(1.3));
      const s = Math.max(4.5, width * 3.2);
      sprite.scale.set(s, s, 1);
      mesh.add(sprite);
    }
    return mesh;
  };

  const graph = new ForceGraph3D(container, { controlType: 'trackball' }) as unknown as Graph;
  graph
    .backgroundColor(BACKGROUND)
    .showNavInfo(false)
    .width(container.clientWidth)
    .height(container.clientHeight)
    .nodeId('id')
    .nodeLabel((n: VizNode) => `<span class="node-tip">${opts.label(n)}</span>`)
    .nodeThreeObject(makeNodeObject)
    .onNodeClick((n: VizNode) => opts.onNodeClick(n))
    .linkColor(() => LINK_COLOR)
    .linkWidth(0)
    .linkOpacity(0.25)
    .linkDirectionalParticles(0)
    .linkDirectionalParticleSpeed((l: VizLink) => l.__pSpeed ?? 0.18)
    .linkDirectionalParticleThreeObject(makeParticle)
    .dagMode('radialout')
    .dagLevelDistance(DAG_LEVEL_DISTANCE)
    // Satellites are pinned; keep them out of the radial constraint.
    .dagNodeFilter((n: VizNode) => !n.outside)
    .onDagError(() => {})
    .warmupTicks(80)
    .cooldownTicks(100)
    .onEngineTick(() => {
      if (zoomPending && !zoomedAfterWarmup) {
        // Not on this tick: node objects have not been moved yet, so the bbox is a point.
        zoomedAfterWarmup = true;
        setTimeout(() => !disposed && graph.zoomToFit(400, 60), 250);
      }
      if (!firstLayoutDone) {
        firstLayoutDone = true;
        for (const cb of firstLayoutCbs.splice(0)) cb();
      }
    })
    .onEngineStop(() => {
      if (zoomPending) {
        zoomPending = false;
        graph.zoomToFit(600, 60);
      }
    });

  graph.cameraPosition({ x: 0, y: 0, z: 420 });
  // The composer's RenderPass clears with the clear color already converted to sRGB, which
  // double-encodes the backdrop; a scene background is converted per target by three.
  graph.scene().background = new Color(BACKGROUND);

  const bloom = new UnrealBloomPass(new Vector2(container.clientWidth, container.clientHeight), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  graph.postProcessingComposer().addPass(bloom);
  graph.postProcessingComposer().addPass(new OutputPass());

  const fgRoot = (): Object3D | undefined =>
    graph.scene().children.find((c) => typeof (c as unknown as { emitParticle?: unknown }).emitParticle === 'function');

  const resize = (): void => {
    if (!disposed) graph.width(container.clientWidth).height(container.clientHeight);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  const scratch = new Color();
  const sample = newSample();
  const spare = newSample();

  function applyIdle(mesh: NodeMesh): void {
    const u = mesh.userData;
    idleColor(mesh.material.color, u.base, book.heat.get(u.id) ?? 0);
    mesh.material.opacity = u.opacity;
    mesh.scale.setScalar(u.radius);
    if (u.halo) u.halo.visible = false;
  }

  // Per-frame work touches only glowing nodes and live link flashes.
  const frame = (now: number): void => {
    if (disposed) return;
    for (const id of [...book.ids()]) {
      const mesh = meshes.get(id);
      if (!mesh) {
        // Not in the graph (hidden or purged): let the glow run out without drawing.
        book.sample(id, scratch, 1, now, spare);
        continue;
      }
      const u = mesh.userData;
      idleColor(scratch, u.base, book.heat.get(id) ?? 0);
      book.sample(id, scratch, u.opacity, now, sample);
      mesh.material.color.copy(sample.color);
      mesh.material.opacity = sample.opacity;
      if (sample.scale === 0) {
        mesh.visible = false;
      } else {
        mesh.visible = true;
        mesh.scale.setScalar(u.radius * sample.scale);
      }
      if (sample.halo) {
        if (!u.halo) {
          u.halo = haloSprite(sample.halo.clone());
          u.halo.scale.set(4.4, 4.4, 1);
          mesh.add(u.halo);
        }
        u.halo.material.color.copy(sample.halo).multiplyScalar(1.4);
        u.halo.material.opacity = sample.haloAlpha;
        u.halo.visible = true;
      } else if (u.halo) {
        u.halo.visible = false;
      }
      if (!sample.alive && sample.scale !== 0) applyIdle(mesh);
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]!;
      const t = (now - f.start) / f.duration;
      const s = endpoint(f.link.source);
      const e = endpoint(f.link.target);
      if (t >= 1 || !s || !e) {
        f.line.removeFromParent();
        f.line.geometry.dispose();
        f.line.material.dispose();
        flashes.splice(i, 1);
        continue;
      }
      const pos = f.line.geometry.getAttribute('position') as Float32BufferAttribute;
      pos.setXYZ(0, s.x ?? 0, s.y ?? 0, s.z ?? 0);
      pos.setXYZ(1, e.x ?? 0, e.y ?? 0, e.z ?? 0);
      pos.needsUpdate = true;
      f.line.material.opacity = 1 - t;
    }
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  const project = new Vector3();

  const renderer: Renderer = {
    kind: '3d',
    setData(data: GraphData, initial: boolean) {
      if (initial) {
        book.clear();
        const root = data.nodes.find((n) => n.id === ROOT_ID);
        if (root) {
          root.fx = 0;
          root.fy = 0;
          root.fz = 0;
        }
        graph.warmupTicks(80);
        zoomPending = true;
        zoomedAfterWarmup = false;
      } else {
        // Structural updates must not block the main thread with a new warmup.
        graph.warmupTicks(0);
      }
      graph.graphData(data);
      // Meshes of nodes no longer in the graph were disposed by the library.
      const inGraph = new Set(data.nodes.map((n) => n.id));
      for (const id of meshes.keys()) if (!inGraph.has(id)) meshes.delete(id);
      return graph.graphData().links;
    },
    emitParticle(link, style) {
      const holder = (link as { __singleHopPhotonsObj?: Object3D }).__singleHopPhotonsObj;
      // A photon group left over from a previous graph instance would never render.
      if (holder && holder.parent !== fgRoot()) delete (link as { __singleHopPhotonsObj?: Object3D }).__singleHopPhotonsObj;
      link.__pColor = style.color;
      link.__pWidth = style.width;
      link.__pSpeed = style.speed;
      if (style.halo) link.__pHalo = style.halo;
      else delete link.__pHalo;
      graph.emitParticle(link);
    },
    pulse(id, color, o) {
      book.pulse(id, color, o);
    },
    fadeOut(id) {
      book.fadeOut(id);
    },
    cancelFade(id) {
      if (book.isFading(id)) book.delete(id);
      const mesh = meshes.get(id);
      if (!mesh || book.has(id)) return;
      // A finished fade left the mesh hidden; frame() never un-hides it on its own.
      mesh.visible = true;
      applyIdle(mesh);
    },
    flashLink(link, color, durationMs) {
      const s = endpoint(link.source);
      const e = endpoint(link.target);
      if (!s || !e) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute([s.x ?? 0, s.y ?? 0, s.z ?? 0, e.x ?? 0, e.y ?? 0, e.z ?? 0], 3));
      const material = new LineBasicMaterial({
        color: new Color(color).multiplyScalar(2),
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const line = new Line(geometry, material);
      line.frustumCulled = false;
      graph.scene().add(line);
      flashes.push({ line, link, start: performance.now(), duration: durationMs });
    },
    forget(ids) {
      for (const id of ids) {
        meshes.delete(id);
        book.delete(id);
      }
    },
    refreshNode(node) {
      const mesh = meshes.get(node.id);
      if (!mesh) return;
      mesh.userData.base.set(baseColor(node));
      mesh.userData.radius = nodeRadius(node);
      if (!book.has(node.id)) applyIdle(mesh);
    },
    setHeat(heat) {
      const touched = new Set<string>([...book.heat.keys(), ...heat.keys()]);
      book.heat.clear();
      for (const [id, v] of heat) book.heat.set(id, v);
      for (const id of touched) {
        const mesh = meshes.get(id);
        if (mesh && !book.has(id)) applyIdle(mesh);
      }
    },
    activeIds() {
      return [...book.ids()];
    },
    screenCoords(node) {
      project.set(node.x ?? 0, node.y ?? 0, node.z ?? 0).project(graph.camera());
      if (project.z > 1 || project.z < -1) return null;
      return { x: ((project.x + 1) / 2) * container.clientWidth, y: ((1 - project.y) / 2) * container.clientHeight };
    },
    onFirstLayout(cb) {
      if (firstLayoutDone) cb();
      else firstLayoutCbs.push(cb);
    },
    zoomToFit(ms = 600) {
      graph.zoomToFit(ms, 60);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      observer.disconnect();
      for (const f of flashes) {
        f.line.geometry.dispose();
        f.line.material.dispose();
      }
      flashes.length = 0;
      graph._destructor();
      const webgl = graph.renderer();
      webgl.dispose();
      webgl.forceContextLoss();
      for (const g of particleGeoms.values()) g.dispose();
      for (const m of particleMats.values()) m.dispose();
      meshes.clear();
      container.replaceChildren();
    },
  };
  return renderer;
}
