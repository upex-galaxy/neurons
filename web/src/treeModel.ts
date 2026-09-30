// Graph data model built from the server's TreeSnapshot, plus satellites (paths outside
// the repo) and directory collapse. No DOM or three.js here, so it can be unit tested in Node.
import type { NodeKind, TreeEntry, TreeSnapshot } from '../../src/shared/types.ts';

export const ROOT_ID = '';
/** Hub for paths outside the repo. Repo ids are relative paths, so "::" cannot collide in practice. */
export const OUTSIDE_HUB_ID = '::outside';
const OUTSIDE_GROUP_PREFIX = '::outside/';
/** Satellite file nodes beyond this count light their group node instead. */
export const MAX_SATELLITES = 200;
/** How long an auto-expanded dir is protected from re-collapse. */
export const EXPAND_HOLD_MS = 30_000;

export interface VizNode {
  /** Relative path ("" for the root), absolute path for satellites, "::outside..." for hub and groups. */
  id: string;
  kind: NodeKind;
  depth: number;
  /** Basename, the repo name for the root, or the group label. */
  name: string;
  parentId: string | null;
  /** True while the node fades out before being purged. */
  removing?: boolean;
  /** Hub, group or satellite: pinned outside the main tree. */
  outside?: boolean;
  /** Collapsed dir: its descendants are not in the graph. */
  collapsed?: boolean;
  // Positions and velocities written by the force layout.
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

export interface VizLink {
  /** "parent->child". */
  key: string;
  /** Node id before the layout runs, node object afterwards. */
  source: string | VizNode;
  target: string | VizNode;
  /** Transient particle style, set right before emitParticle. */
  __pColor?: string;
  __pWidth?: number;
  __pSpeed?: number;
  /** Subagent halo color for the particle, if any. */
  __pHalo?: string;
}

export interface GraphData {
  nodes: VizNode[];
  links: VizLink[];
}

export function linkKey(parent: string, child: string): string {
  return `${parent}->${child}`;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? ROOT_ID : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function depthOf(path: string): number {
  if (path === ROOT_ID) return 0;
  let d = 1;
  for (const ch of path) if (ch === '/') d++;
  return d;
}

/** Normalizes "./a/b/" to "a/b". */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p === '.') p = '';
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path);
}

export function isOutsideId(id: string): boolean {
  return id === OUTSIDE_HUB_ID || id.startsWith(OUTSIDE_GROUP_PREFIX) || isAbsolutePath(id);
}

/**
 * Groups an absolute path outside the repo: ~/.claude, /tmp (also /private/tmp),
 * otherwise its first two segments.
 */
export function outsideGroup(abs: string): string {
  const p = abs.replace(/\\/g, '/');
  if (/^(?:~|\/Users\/[^/]+|\/home\/[^/]+|\/root|__HOME__)\/\.claude(?:\/|$)/.test(p)) return '~/.claude';
  if (/^(?:\/private)?\/tmp(?:\/|$)/.test(p)) return '/tmp';
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return '/';
  const lead = p.startsWith('/') ? '/' : '';
  return lead + segs.slice(0, 2).join('/');
}

export function groupId(label: string): string {
  return OUTSIDE_GROUP_PREFIX + label;
}

function endpointId(end: string | VizNode): string {
  return typeof end === 'object' ? end.id : end;
}

export interface DeltaResult {
  /** Nodes created by this delta, including missing ancestors. */
  added: VizNode[];
  /** Ids now marked `removing` (removed paths plus their descendants). Call purge() later. */
  removing: string[];
  /**
   * Ids that were `removing` from an earlier delta and came back in this one (re-added
   * paths and their ancestors). Their fade-out already started: the view must cancel it.
   */
  revived: string[];
}

export class TreeModel {
  name = '';
  readonly nodes = new Map<string, VizNode>();
  private readonly children = new Map<string, Set<string>>();
  /** linkKey -> link object. After syncLive() these are the objects the graph holds. */
  private readonly links = new Map<string, VizLink>();
  /** Last activity per dir (for least-recently-active re-collapse). */
  private readonly lastActive = new Map<string, number>();
  /** Dir -> time until which it must stay expanded. */
  private readonly holdUntil = new Map<string, number>();
  private satelliteCount = 0;
  private visibleCache = -1;

  load(tree: TreeSnapshot): void {
    this.nodes.clear();
    this.children.clear();
    this.links.clear();
    this.lastActive.clear();
    this.holdUntil.clear();
    this.satelliteCount = 0;
    this.visibleCache = -1;
    this.name = tree.name;
    const root: VizNode = { id: ROOT_ID, kind: 'dir', depth: 0, name: tree.name, parentId: null };
    this.nodes.set(ROOT_ID, root);
    for (const entry of tree.entries) this.addEntry(entry);
  }

  private attach(node: VizNode): void {
    this.nodes.set(node.id, node);
    this.visibleCache = -1;
    if (node.parentId === null) return;
    let set = this.children.get(node.parentId);
    if (!set) {
      set = new Set();
      this.children.set(node.parentId, set);
    }
    set.add(node.id);
    const key = linkKey(node.parentId, node.id);
    this.links.set(key, { key, source: node.parentId, target: node.id });
  }

  /** Adds an entry and any missing ancestor dirs. Returns the nodes created. */
  addEntry(entry: TreeEntry): VizNode[] {
    const path = normalizePath(entry.path);
    const created: VizNode[] = [];
    if (path === ROOT_ID || isOutsideId(path)) return created;
    const existing = this.nodes.get(path);
    if (existing) {
      // Re-added while fading out: keep it.
      if (existing.removing) existing.removing = false;
      return created;
    }
    const parent = parentPath(path);
    if (!this.nodes.has(parent)) created.push(...this.addEntry({ path: parent, kind: 'dir' }));
    const node: VizNode = {
      id: path,
      kind: entry.kind,
      depth: depthOf(path),
      name: baseName(path),
      parentId: parent,
    };
    this.attach(node);
    created.push(node);
    return created;
  }

  /**
   * Makes sure an absolute path outside the repo has a node (hub -> group -> satellite).
   * Returns the id to light (the satellite, or its group past MAX_SATELLITES) and the nodes created.
   */
  addOutside(abs: string): { id: string; created: VizNode[] } {
    const created: VizNode[] = [];
    const path = normalizePath(abs);
    if (!this.nodes.has(OUTSIDE_HUB_ID)) {
      const hub: VizNode = { id: OUTSIDE_HUB_ID, kind: 'dir', depth: 0, name: 'fuera del repo', parentId: null, outside: true };
      this.attach(hub);
      created.push(hub);
    }
    const label = outsideGroup(path);
    const gid = groupId(label);
    if (!this.nodes.has(gid)) {
      const group: VizNode = { id: gid, kind: 'dir', depth: 1, name: label, parentId: OUTSIDE_HUB_ID, outside: true };
      this.attach(group);
      created.push(group);
    }
    if (this.nodes.has(path)) return { id: path, created };
    if (this.satelliteCount >= MAX_SATELLITES) return { id: gid, created };
    const sat: VizNode = { id: path, kind: 'file', depth: 2, name: baseName(path) || path, parentId: gid, outside: true };
    this.attach(sat);
    this.satelliteCount++;
    created.push(sat);
    return { id: path, created };
  }

  /**
   * Applies a tree delta. Additions are immediate. Removals are two-phase: nodes are
   * marked `removing` (so the view can fade them) and must be purged with purge().
   */
  applyDelta(added: TreeEntry[], removed: string[]): DeltaResult {
    const result: DeltaResult = { added: [], removing: [], revived: [] };
    for (const raw of removed) {
      const path = normalizePath(raw);
      if (path === ROOT_ID || isOutsideId(path) || !this.nodes.has(path)) continue;
      for (const id of this.subtree(path)) {
        const node = this.nodes.get(id);
        if (node && !node.removing) {
          node.removing = true;
          result.removing.push(id);
        }
      }
    }
    // A node marked in this batch has not started fading yet: just drop it from `removing`.
    // One marked by an earlier batch is already fading: report it as revived.
    const keep = (id: string): void => {
      const i = result.removing.indexOf(id);
      if (i !== -1) result.removing.splice(i, 1);
      else result.revived.push(id);
    };
    for (const entry of added) {
      const path = normalizePath(entry.path);
      if (path === ROOT_ID || isOutsideId(path)) continue;
      const wasRemoving = this.nodes.get(path)?.removing === true;
      result.added.push(...this.addEntry(entry));
      if (wasRemoving) keep(path);
      // Ancestors of a (re-)added path must survive too, also when the path itself is new.
      for (let p = this.nodes.get(path)?.parentId ?? null; p !== null; p = this.nodes.get(p)?.parentId ?? null) {
        const anc = this.nodes.get(p);
        if (anc?.removing) {
          anc.removing = false;
          keep(p);
        }
      }
    }
    return result;
  }

  /** Deletes nodes still marked `removing`. Returns the ids actually deleted. */
  purge(ids: string[]): string[] {
    const gone: string[] = [];
    // Deepest first so parents lose their children before themselves.
    const sorted = [...ids].sort((a, b) => depthOf(b) - depthOf(a));
    for (const id of sorted) {
      const node = this.nodes.get(id);
      if (!node || !node.removing || id === ROOT_ID) continue;
      this.nodes.delete(id);
      this.children.delete(id);
      this.lastActive.delete(id);
      this.holdUntil.delete(id);
      if (node.parentId !== null) {
        this.children.get(node.parentId)?.delete(id);
        this.links.delete(linkKey(node.parentId, id));
      }
      gone.push(id);
    }
    if (gone.length) this.visibleCache = -1;
    return gone;
  }

  /** The path and all its descendants. */
  subtree(path: string): string[] {
    const out: string[] = [];
    const stack = [path];
    while (stack.length) {
      const id = stack.pop()!;
      if (!this.nodes.has(id)) continue;
      out.push(id);
      const kids = this.children.get(id);
      if (kids) for (const k of kids) stack.push(k);
    }
    return out;
  }

  /** Number of descendants (not counting the node). */
  descendantCount(id: string): number {
    return Math.max(0, this.subtree(id).length - 1);
  }

  childrenOf(id: string): string[] {
    return [...(this.children.get(id) ?? [])];
  }

  childCount(id: string): number {
    return this.children.get(id)?.size ?? 0;
  }

  /** Visible nodes and the links between them: fresh arrays holding the model's own objects. */
  data(): GraphData {
    const nodes: VizNode[] = [];
    const links: VizLink[] = [];
    const roots = [ROOT_ID, OUTSIDE_HUB_ID].filter((id) => this.nodes.has(id));
    const stack = [...roots];
    while (stack.length) {
      const id = stack.pop()!;
      const node = this.nodes.get(id);
      if (!node) continue;
      nodes.push(node);
      if (node.collapsed) continue;
      const kids = this.children.get(id);
      if (!kids) continue;
      for (const kid of kids) {
        const link = this.links.get(linkKey(id, kid));
        if (link) links.push(link);
        stack.push(kid);
      }
    }
    this.visibleCache = nodes.length;
    return { nodes, links };
  }

  /**
   * Re-indexes links from the graph's own list, so emitParticle gets the exact object
   * the graph holds (force-graph swaps source/target ids for node objects).
   */
  syncLive(liveLinks: readonly VizLink[]): void {
    for (const link of liveLinks) {
      const key = linkKey(endpointId(link.source), endpointId(link.target));
      link.key = key;
      this.links.set(key, link);
    }
  }

  link(parent: string, child: string): VizLink | undefined {
    return this.links.get(linkKey(parent, child));
  }

  get(id: string): VizNode | undefined {
    return this.nodes.get(id);
  }

  /** A node is visible when it exists and no ancestor is collapsed. */
  isVisible(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    for (let p = node.parentId; p !== null; ) {
      const anc = this.nodes.get(p);
      if (!anc) return false;
      if (anc.collapsed) return false;
      p = anc.parentId;
    }
    return true;
  }

  /** The node itself if visible, else the collapsed ancestor that hides it. */
  visibleAncestor(id: string): string | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    let found: string = id;
    for (let p = node.parentId; p !== null; ) {
      const anc = this.nodes.get(p);
      if (!anc) return undefined;
      if (anc.collapsed) found = anc.id;
      p = anc.parentId;
    }
    return found;
  }

  /**
   * Visible nodes from the root down to the path (or its deepest existing ancestor).
   * Repo paths start at the root; absolute paths start at the outside hub.
   */
  chain(path: string): string[] {
    const target = normalizePath(path);
    if (isOutsideId(target)) {
      let node = this.nodes.get(target);
      // Past MAX_SATELLITES a path has no node of its own: light its group.
      if (!node) node = this.nodes.get(groupId(outsideGroup(target)));
      if (!node) return this.nodes.has(OUTSIDE_HUB_ID) ? [OUTSIDE_HUB_ID] : [];
      const out: string[] = [];
      for (let id: string | null = node.id; id !== null; id = this.nodes.get(id)?.parentId ?? null) out.unshift(id);
      return out;
    }
    const out = [ROOT_ID];
    if (target === ROOT_ID) return out;
    const parts = target.split('/');
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const node = this.nodes.get(acc);
      if (!node) break;
      out.push(acc);
      if (node.collapsed) break;
    }
    return out;
  }

  // ---------- collapse ----------

  canCollapse(id: string): boolean {
    const node = this.nodes.get(id);
    return !!node && node.kind === 'dir' && id !== ROOT_ID && !node.outside && this.childCount(id) > 0;
  }

  collapse(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node || node.collapsed || !this.canCollapse(id)) return false;
    node.collapsed = true;
    this.visibleCache = -1;
    return true;
  }

  expand(id: string, now?: number): boolean {
    const node = this.nodes.get(id);
    if (!node?.collapsed) return false;
    node.collapsed = false;
    this.visibleCache = -1;
    if (now !== undefined) {
      this.holdUntil.set(id, now + EXPAND_HOLD_MS);
      this.lastActive.set(id, now);
    }
    return true;
  }

  /** Expands every collapsed ancestor of `path` so it becomes visible. Returns the dirs expanded. */
  reveal(path: string, now: number): string[] {
    const target = normalizePath(path);
    const node = this.nodes.get(target);
    if (!node) return [];
    const opened: string[] = [];
    for (let p = node.parentId; p !== null; ) {
      const anc = this.nodes.get(p);
      if (!anc) break;
      if (anc.collapsed && this.expand(anc.id, now)) opened.push(anc.id);
      p = anc.parentId;
    }
    return opened;
  }

  /** Records activity on a path and its ancestor dirs (for least-recently-active re-collapse). */
  touch(path: string, now: number): void {
    const target = normalizePath(path);
    let id: string | null = this.nodes.has(target) ? target : null;
    while (id !== null) {
      const node = this.nodes.get(id);
      if (!node) break;
      if (node.kind === 'dir') this.lastActive.set(id, now);
      id = node.parentId;
    }
  }

  /** Visible nodes under `id` (not counting it), stopping at collapsed dirs. */
  private visibleBelow(id: string): number {
    let n = 0;
    const stack: string[] = [];
    const kids = this.children.get(id);
    if (kids) for (const k of kids) stack.push(k);
    while (stack.length) {
      const cur = stack.pop()!;
      n++;
      const node = this.nodes.get(cur);
      if (node?.collapsed) continue;
      const more = this.children.get(cur);
      if (more) for (const k of more) stack.push(k);
    }
    return n;
  }

  get visibleCount(): number {
    if (this.visibleCache < 0) {
      let n = 0;
      for (const root of [ROOT_ID, OUTSIDE_HUB_ID]) if (this.nodes.has(root)) n += 1 + this.visibleBelow(root);
      this.visibleCache = n;
    }
    return this.visibleCache;
  }

  /**
   * Initial collapse for big trees: collapses dirs deepest first, then biggest first,
   * until at most `budget` nodes are visible. Returns the dirs collapsed.
   */
  collapseToBudget(budget: number): string[] {
    const done: string[] = [];
    let visible = this.visibleCount;
    if (visible <= budget) return done;
    const sizes = this.subtreeSizes();
    const dirs = [...this.nodes.values()]
      .filter((n) => this.canCollapse(n.id) && !n.collapsed)
      .sort((a, b) => b.depth - a.depth || (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0));
    for (const dir of dirs) {
      if (visible <= budget) break;
      if (!this.isVisible(dir.id)) continue;
      const gain = this.visibleBelow(dir.id);
      if (gain === 0) continue;
      dir.collapsed = true;
      visible -= gain;
      done.push(dir.id);
    }
    this.visibleCache = -1;
    return done;
  }

  /**
   * Re-collapses least-recently-active expanded dirs when more than `budget * slack`
   * nodes are visible, down to `budget`. Dirs held by a recent expand are skipped.
   */
  recollapse(budget: number, now: number, slack = 1.3): string[] {
    const done: string[] = [];
    let visible = this.visibleCount;
    if (visible <= budget * slack) return done;
    const dirs = [...this.nodes.values()]
      .filter((n) => this.canCollapse(n.id) && !n.collapsed && (this.holdUntil.get(n.id) ?? 0) <= now)
      .sort((a, b) => (this.lastActive.get(a.id) ?? 0) - (this.lastActive.get(b.id) ?? 0) || b.depth - a.depth);
    for (const dir of dirs) {
      if (visible <= budget) break;
      if (!this.isVisible(dir.id)) continue;
      const gain = this.visibleBelow(dir.id);
      if (gain === 0) continue;
      dir.collapsed = true;
      visible -= gain;
      done.push(dir.id);
    }
    this.visibleCache = -1;
    return done;
  }

  /** Subtree size per node (node included), computed bottom-up in one pass. */
  private subtreeSizes(): Map<string, number> {
    const sizes = new Map<string, number>();
    const byDepth = [...this.nodes.values()].sort((a, b) => b.depth - a.depth);
    for (const n of byDepth) {
      let s = 1;
      const kids = this.children.get(n.id);
      if (kids) for (const k of kids) s += sizes.get(k) ?? 1;
      sizes.set(n.id, s);
    }
    return sizes;
  }

  /** Deepest repo depth, used to place the outside hub clear of the tree. */
  maxDepth(): number {
    let d = 0;
    for (const n of this.nodes.values()) if (!n.outside && n.depth > d) d = n.depth;
    return d;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get linkCount(): number {
    return this.links.size;
  }
}

/**
 * Pins the hub, its groups and their satellites on fixed positions at distance `radius`
 * from the origin (negative x axis). Groups sit on a ring around the hub, satellites around their group.
 * Uses the x/y plane so the same positions work in 2D.
 */
export function pinOutside(model: TreeModel, radius: number): void {
  const hub = model.get(OUTSIDE_HUB_ID);
  if (!hub) return;
  const pin = (n: VizNode, x: number, y: number, z: number): void => {
    n.fx = x;
    n.fy = y;
    n.fz = z;
    n.x = x;
    n.y = y;
    n.z = z;
  };
  // Left of the tree: the side panel sits on the right, and labels grow to the right.
  const hx = -radius;
  pin(hub, hx, 0, 0);
  // Insertion order keeps existing positions stable as new satellites arrive.
  const sorted = (id: string): VizNode[] =>
    model
      .childrenOf(id)
      .map((c) => model.get(c))
      .filter((n): n is VizNode => !!n);
  const groups = sorted(OUTSIDE_HUB_ID);
  const gR = 34;
  groups.forEach((g, i) => {
    const a = (i / Math.max(groups.length, 1)) * Math.PI * 2 + Math.PI / 2;
    const gx = hx + Math.cos(a) * gR;
    const gy = Math.sin(a) * gR;
    pin(g, gx, gy, 0);
    sorted(g.id).forEach((s, j) => {
      // Golden-angle spiral: stable positions as satellites are added.
      const r = 9 + 3.2 * Math.sqrt(j);
      const t = j * 2.39996;
      pin(s, gx + Math.cos(t) * r, gy + Math.sin(t) * r, 0);
    });
  });
}
