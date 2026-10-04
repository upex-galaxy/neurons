// Disk watcher on top of fs.watch. On macOS and Windows one recursive handle covers the
// whole tree (FSEvents, ReadDirectoryChangesW). Elsewhere (Linux) Node's recursive mode
// walks the whole tree and opens one inotify watch per file and folder, node_modules and
// .git included, and it swallows ENOSPC (a partial set of watches stays open, nothing is
// reported). So there the watcher opens one non-recursive watch per directory of the tree
// index (excluded and git-ignored folders never enter it), adds one for every new folder
// and drops it when the folder goes. The index only knows folders that hold a listed file,
// so right after the start the watcher also walks the disk for folders it lacks (empty
// ones, ones past the scan cap) and watches those git does not ignore; a new folder gets
// the same walk (a subtree deeper than maxWalk). A watch that cannot be opened at start
// throws (the caller reports it); one that fails later goes to onDegraded.
// Raw events carry no reliable type, so each path is coalesced
// and then classified with lstat against the tree index.
// An unlink and an add that belong together are reported as one move: same inode,
// the same path in another case, or, for an entry that was not born just now, the
// same name elsewhere or the only pair of the batch. An unmatched unlink waits
// `pairMs` for its add before it goes out.
// The watcher never mutates the index: the caller applies adds and removes.

import fs from 'node:fs';
import path from 'node:path';
import type { DiskChange, DiskChangeType } from './attribution.ts';
import { toPosix } from './paths.ts';
import { isAlwaysExcluded, isExcludedRel, type TreeIndex } from './tree.ts';

export interface WatcherHandle {
  close(): Promise<void>;
}

export interface WatcherOptions {
  root: string;
  index: TreeIndex;
  onChange: (c: DiskChange) => void;
  coalesceMs?: number;
  /** Returns the subset of `rels` to drop (git check-ignore). Only asked for paths new to the index. */
  isIgnored?: (rels: string[]) => Promise<Set<string>>;
  /** Also drop DEFAULT_EXCLUDES (node_modules, dist, ...). Default: true when `root` has no `.git`. */
  excludeDefaults?: boolean;
  /** Max entries walked under one new directory. */
  maxWalk?: number;
  /** How long an unmatched unlink waits for the add that would make it a move. */
  pairMs?: number;
  onError?: (err: unknown) => void;
  /** A folder that appeared after the start could not be watched (ENOSPC, EMFILE): its changes are missed. */
  onDegraded?: (err: unknown) => void;
  /** Platform that picks the watch mode (see usesNativeRecursive). Default: process.platform. */
  platform?: NodeJS.Platform;
  /** fs.watch, replaceable in tests. */
  watch?: typeof fs.watch;
}

/**
 * True where fs.watch's recursive mode is one native handle (macOS, Windows). Elsewhere it
 * is Node's JS fallback (one inotify watch per entry), so the watcher watches each
 * directory on its own.
 */
export function usesNativeRecursive(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * The directories a per-directory watcher opens at start: the root ('') and every dir of
 * the index that `excluded` lets through (.git, .neurons, subagent worktrees, and outside
 * git node_modules, dist...). Git-ignored dirs are never in the index of a git repo.
 */
export function initialWatchDirs(index: TreeIndex, excluded: (rel: string) => boolean): string[] {
  const dirs = [''];
  for (const e of index.snapshot().entries) if (e.kind === 'dir' && !excluded(e.path)) dirs.push(e.path);
  return dirs;
}

interface Probe {
  rel: string;
  /** undefined = missing on disk. */
  stat: fs.Stats | undefined;
}

const DEFAULT_MAX_WALK = 5000;
/** Max directories one disk walk for unwatched folders visits. */
const MAX_DISCOVER_DIRS = 100_000;
/** Paths per isIgnored call during that walk. */
const IGNORE_BATCH = 500;
const DEFAULT_PAIR_MS = 200;
/** A renamed entry keeps its birth time; a new one is born when it is seen. */
const FRESH_BIRTH_MS = 1000;
const MAX_INODES = 50_000;

function lstat(abs: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(abs);
  } catch {
    return undefined;
  }
}

function basenameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** True when a strict ancestor of `rel` is in `dirs`. */
function hasAncestorIn(rel: string, dirs: ReadonlySet<string>): boolean {
  if (dirs.size === 0) return false;
  let i = rel.lastIndexOf('/');
  while (i > 0) {
    if (dirs.has(rel.slice(0, i))) return true;
    i = rel.lastIndexOf('/', i - 1);
  }
  return false;
}

const isRemoval = (c: DiskChange) => c.type === 'unlink' || c.type === 'unlinkDir';
const isAddition = (c: DiskChange) => c.type === 'add' || c.type === 'addDir';

export function startWatcher(opts: WatcherOptions): WatcherHandle {
  const root = opts.root;
  const index = opts.index;
  const coalesceMs = opts.coalesceMs ?? 40;
  const maxWalk = opts.maxWalk ?? DEFAULT_MAX_WALK;
  const excludeDefaults = opts.excludeDefaults ?? !fs.existsSync(path.join(root, '.git'));
  const onError = opts.onError ?? (() => {});
  const pairMs = opts.pairMs ?? DEFAULT_PAIR_MS;
  // FSEvents replays recent history when a stream starts: file changes older
  // than the watcher are not news. Per-path mtimes drop repeated notifications.
  const startedAt = Date.now();
  const lastMtime = new Map<string, number>();
  /** Paths git ignores (and their subtrees), learned from isIgnored. */
  const ignoredCache = new Set<string>();
  /** Inodes of entries the watcher has seen appear (to recognize them when they move). */
  const inodes = new Map<string, number>();
  /** Unlinks waiting for the add that would pair them into a move. */
  let held: { change: DiskChange; until: number }[] = [];
  let heldTimer: NodeJS.Timeout | undefined;

  let pending = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const excluded = (rel: string): boolean =>
    rel === '' || isAlwaysExcluded(rel) || (excludeDefaults && isExcludedRel(rel));

  function onRaw(raw: string): void {
    const rel = toPosix(raw).replace(/^\.?\/+|\/+$/g, '');
    // A default-excluded path the index knows anyway (put there by a hook) must still be
    // able to leave it.
    if (excluded(rel) && !(rel !== '' && !isAlwaysExcluded(rel) && index.has(rel))) return;
    if (!pending.has(rel)) pending.set(rel, Date.now());
    if (!timer) timer = setTimeout(schedule, coalesceMs);
  }

  const watchFn = opts.watch ?? fs.watch;
  const native = usesNativeRecursive(opts.platform ?? process.platform);
  /** Per-directory mode: rel dir -> its non-recursive watch. */
  const dirWatchers = new Map<string, fs.FSWatcher>();
  let degraded = false;

  function watchDir(rel: string): void {
    if (closed || dirWatchers.has(rel) || (rel !== '' && excluded(rel))) return;
    const w = watchFn(rel === '' ? root : path.join(root, rel), (_type, filename) => {
      if (closed || filename === null || filename === undefined) return;
      const name = toPosix(String(filename));
      onRaw(rel === '' ? name : `${rel}/${name}`);
    });
    w.on('error', (err) => {
      // The folder went away (or the platform dropped the watch): its parent reports the rest.
      unwatchTree(rel);
      onError(err);
    });
    dirWatchers.set(rel, w);
  }

  /** Watches a folder that appeared after the start; a failure is reported once, not thrown. */
  function watchNewDir(rel: string): void {
    try {
      watchDir(rel);
    } catch (err) {
      onError(err);
      if (!degraded) {
        degraded = true;
        opts.onDegraded?.(err);
      }
    }
  }

  function unwatchTree(rel: string): void {
    for (const [dir, w] of dirWatchers) {
      if (dir === rel || dir.startsWith(`${rel}/`)) {
        dirWatchers.delete(dir);
        w.close();
      }
    }
  }

  /** Keeps the per-directory watches in step with the folders the watcher reports. */
  function track(c: DiskChange): void {
    if (native) return;
    if (c.type === 'addDir') {
      watchNewDir(c.path);
      discoverOnce(c.path);
    } else if (c.type === 'unlinkDir') unwatchTree(c.path);
    else if (c.type === 'moveDir') {
      if (c.from !== undefined) unwatchTree(c.from);
      watchNewDir(c.path);
      discoverOnce(c.path);
    }
  }

  /** Roots walked during the current flush: a new subtree is walked once, from its top. */
  const walkedRoots = new Set<string>();

  function discoverOnce(rel: string): void {
    if (walkedRoots.has(rel) || hasAncestorIn(rel, walkedRoots)) return;
    walkedRoots.add(rel);
    discover(rel);
  }

  /** Disk walks for unwatched folders still running (close waits for them). */
  const discovering = new Set<Promise<void>>();

  /** Starts a walk under `rel` for folders without a watch (see discoverDirs). */
  function discover(rel: string): void {
    const run = discoverDirs(rel)
      .catch(onError)
      .finally(() => discovering.delete(run));
    discovering.add(run);
  }

  /**
   * Walks the folders under `rel` on disk and watches the ones that have no watch yet:
   * empty folders and folders holding only unlisted files are not in a git repo's index,
   * and a scan or walk cap leaves others out. Excluded and git-ignored folders are skipped
   * with their subtree (node_modules is never walked).
   */
  async function discoverDirs(rel: string): Promise<void> {
    let level = [rel];
    let visited = 0;
    while (level.length > 0 && !closed && visited < MAX_DISCOVER_DIRS) {
      const candidates: string[] = [];
      for (const dir of level) {
        if (++visited > MAX_DISCOVER_DIRS) break;
        let dirents: fs.Dirent[];
        try {
          dirents = fs.readdirSync(dir === '' ? root : path.join(root, dir), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of dirents) {
          if (!d.isDirectory()) continue;
          const child = dir === '' ? d.name : `${dir}/${d.name}`;
          if (excluded(child) || isCachedIgnored(child)) continue;
          candidates.push(child);
        }
      }
      // Folders of the index are known not to be ignored; ask git about the rest.
      const unknown = candidates.filter((c) => index.kind(c) !== 'dir');
      for (let i = 0; i < unknown.length && !closed; i += IGNORE_BATCH) await learnIgnored(unknown.slice(i, i + IGNORE_BATCH));
      if (closed) return;
      level = [];
      for (const c of candidates) {
        if (isCachedIgnored(c)) continue;
        watchNewDir(c);
        level.push(c);
      }
    }
  }

  let watcher: fs.FSWatcher | undefined;
  if (native) {
    watcher = watchFn(root, { recursive: true }, (_type, filename) => {
      if (closed || filename === null || filename === undefined) return;
      onRaw(String(filename));
    });
    watcher.on('error', onError);
  } else {
    try {
      for (const rel of initialWatchDirs(index, excluded)) watchDir(rel);
    } catch (err) {
      // ENOSPC (inotify limit), EMFILE...: release what was opened, the caller reports it.
      for (const w of dirWatchers.values()) w.close();
      dirWatchers.clear();
      throw err;
    }
    // Folders the index does not know (empty, unlisted files only, past the scan cap).
    discover('');
  }

  function schedule(): void {
    timer = undefined;
    const batch = pending;
    pending = new Map();
    chain = chain.then(() => flush(batch)).catch(onError);
  }

  /** Lists `rel` (a new dir) recursively, bounded, skipping excluded names. */
  function walk(rel: string, into: Map<string, Probe>): void {
    const queue = [rel];
    let seen = 0;
    for (let qi = 0; qi < queue.length && seen < maxWalk; qi++) {
      const dir = queue[qi] as string;
      let names: string[];
      try {
        names = fs.readdirSync(path.join(root, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        const child = `${dir}/${name}`;
        if (excluded(child) || into.has(child) || isCachedIgnored(child)) continue;
        const st = lstat(path.join(root, child));
        if (!st) continue;
        into.set(child, { rel: child, stat: st });
        if (++seen >= maxWalk) break;
        if (st.isDirectory()) queue.push(child);
      }
    }
  }

  function isCachedIgnored(rel: string): boolean {
    return ignoredCache.has(rel) || hasAncestorIn(rel, ignoredCache);
  }

  async function learnIgnored(rels: string[]): Promise<void> {
    if (!opts.isIgnored || rels.length === 0) return;
    try {
      for (const rel of await opts.isIgnored(rels)) ignoredCache.add(rel);
    } catch {
      /* treat as not ignored */
    }
  }

  /**
   * lstat that also checks the exact spelling of every segment. On a case-insensitive
   * volume (APFS) lstat('Foo.ts') succeeds after `mv Foo.ts foo.ts`; the old spelling
   * must read as missing. Directory listings are cached for one flush.
   */
  function probeStat(rel: string, listings: Map<string, string[] | undefined>): fs.Stats | undefined {
    const st = lstat(path.join(root, rel));
    if (!st) return undefined;
    let dir = '';
    for (const seg of rel.split('/')) {
      if (!listings.has(dir)) {
        let names: string[] | undefined;
        try {
          names = fs.readdirSync(path.join(root, dir));
        } catch {
          names = undefined;
        }
        listings.set(dir, names);
      }
      const names = listings.get(dir);
      if (names && !names.includes(seg)) {
        const nfc = seg.normalize('NFC');
        const lower = nfc.toLowerCase();
        const same = names.some((n) => n.normalize('NFC') === nfc);
        // Only a spelling that differs by case alone is another entry; anything else
        // (an encoding quirk of the event) trusts lstat.
        if (!same && names.some((n) => n.normalize('NFC').toLowerCase() === lower)) return undefined;
      }
      dir = dir === '' ? seg : `${dir}/${seg}`;
    }
    return st;
  }

  async function flush(batch: Map<string, number>): Promise<void> {
    if (closed) return;
    walkedRoots.clear();
    const listings = new Map<string, string[] | undefined>();
    const probes = new Map<string, Probe>();
    for (const rel of batch.keys()) probes.set(rel, { rel, stat: probeStat(rel, listings) });
    // A path seen again decides for itself: a held unlink of it is void.
    if (held.length > 0) held = held.filter((h) => !batch.has(h.change.path));

    const isFresh = (p: Probe): boolean => p.stat !== undefined && !index.has(p.rel) && !isCachedIgnored(p.rel);
    // Ask about the reported paths first, so an ignored new dir (node_modules) is never walked.
    await learnIgnored([...probes.values()].filter(isFresh).map((p) => p.rel));
    if (closed) return;

    // FSEvents may report only the parent of a freshly created subtree.
    const walked = new Map<string, Probe>();
    for (const p of [...probes.values()]) {
      if (p.stat?.isDirectory() && isFresh(p)) walk(p.rel, walked);
    }
    if (walked.size > 0) {
      for (const [rel, p] of walked) if (!probes.has(rel)) probes.set(rel, p);
      await learnIgnored([...walked.values()].filter(isFresh).map((p) => p.rel));
      if (closed) return;
    }

    const ordered = [...probes.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const stats = new Map<string, fs.Stats>();
    let changes: DiskChange[] = [];
    for (const p of ordered) {
      const type = classify(p);
      if (!type) continue;
      if (p.stat) stats.set(p.rel, p.stat);
      changes.push({ type, path: p.rel, ts: batch.get(p.rel) ?? Date.now() });
    }
    // A removed dir takes its subtree with it: no separate removals beneath it.
    const removedDirs = new Set(
      [...changes, ...held.map((h) => h.change)].filter((c) => c.type === 'unlinkDir').map((c) => c.path),
    );
    if (removedDirs.size > 0) {
      changes = changes.filter((c) => !(isRemoval(c) || c.type === 'change') || !hasAncestorIn(c.path, removedDirs));
      // FSEvents can report the children of `rm -r d` one batch before d itself: the
      // child unlinks still waiting here are covered by the unlinkDir.
      held = held.filter((h) => !hasAncestorIn(h.change.path, removedDirs));
    }
    if (closed) return;
    for (const c of pairMoves(changes, stats)) {
      if (closed) return;
      track(c);
      opts.onChange(c);
    }
    scheduleHeld();
  }

  /**
   * Turns unlink + add pairs into moves, marks the contents of a moved dir quiet and
   * holds the unlinks that found no partner yet. Returns what to emit now, in order.
   */
  function pairMoves(changes: DiskChange[], stats: Map<string, fs.Stats>): DiskChange[] {
    const addedDirs = new Set(changes.filter((c) => c.type === 'addDir').map((c) => c.path));
    const topAdds = changes.filter((c) => isAddition(c) && !hasAncestorIn(c.path, addedDirs));
    const removals = changes.filter(isRemoval);
    const kindOf = (c: DiskChange) => (c.type === 'addDir' || c.type === 'unlinkDir' ? 'dir' : 'file');
    // A renamed entry keeps its birth time; one born just now is new (git checkout, a build).
    const isFreshBirth = (add: DiskChange) => (stats.get(add.path)?.birthtimeMs ?? 0) >= add.ts - FRESH_BIRTH_MS;
    const pairs = new Map<DiskChange, DiskChange>(); // add -> removal
    const used = new Set<DiskChange>();
    const pool = [...held.map((h) => h.change), ...removals];

    const match = (keyOfRemoval: (r: DiskChange) => string | undefined, keyOfAdd: (a: DiskChange) => string | undefined) => {
      const byKey = new Map<string, DiskChange[]>();
      for (const r of pool) {
        if (used.has(r)) continue;
        const k = keyOfRemoval(r);
        if (k === undefined) continue;
        const list = byKey.get(`${kindOf(r)}:${k}`) ?? [];
        list.push(r);
        byKey.set(`${kindOf(r)}:${k}`, list);
      }
      if (byKey.size === 0) return;
      for (const add of topAdds) {
        if (pairs.has(add)) continue;
        const k = keyOfAdd(add);
        if (k === undefined) continue;
        const r = byKey.get(`${kindOf(add)}:${k}`)?.find((x) => !used.has(x));
        if (r) {
          pairs.set(add, r);
          used.add(r);
        }
      }
    };
    // 1. Same inode (entries the watcher saw appear earlier).
    match(
      (r) => inodes.get(r.path)?.toString(),
      (a) => stats.get(a.path)?.ino.toString(),
    );
    // 2. The same path spelled with another case (a case-only rename on APFS).
    match(
      (r) => r.path.toLowerCase(),
      (a) => a.path.toLowerCase(),
    );
    // 3. Same name in another place, for an entry that is not brand new.
    match(
      (r) => basenameOf(r.path).toLowerCase(),
      (a) => (isFreshBirth(a) ? undefined : basenameOf(a.path).toLowerCase()),
    );
    // 4. A rename: the only unmatched pair of this batch, for an entry that is not brand new.
    const restAdds = topAdds.filter((a) => !pairs.has(a));
    const restRemovals = removals.filter((r) => !used.has(r));
    if (restAdds.length === 1 && restRemovals.length === 1) {
      const add = restAdds[0] as DiskChange;
      const r = restRemovals[0] as DiskChange;
      if (kindOf(add) === kindOf(r) && !isFreshBirth(add)) {
        pairs.set(add, r);
        used.add(r);
      }
    }

    if (used.size > 0) held = held.filter((h) => !used.has(h.change));
    const movedDirs = new Set([...pairs.keys()].filter((a) => a.type === 'addDir').map((a) => a.path));
    const out: DiskChange[] = [];
    for (const c of changes) {
      if (isRemoval(c)) {
        if (used.has(c)) continue;
        // Wait a little for the add that would make it a move.
        if (pairMs > 0) held.push({ change: c, until: Date.now() + pairMs });
        else out.push(c);
        continue;
      }
      const r = pairs.get(c);
      if (r) {
        const ino = stats.get(c.path)?.ino;
        inodes.delete(r.path);
        if (ino !== undefined) rememberInode(c.path, ino);
        out.push({ type: c.type === 'addDir' ? 'moveDir' : 'move', path: c.path, from: r.path, ts: Math.min(c.ts, r.ts) });
        continue;
      }
      if (isAddition(c)) {
        const ino = stats.get(c.path)?.ino;
        if (ino !== undefined) rememberInode(c.path, ino);
        if (hasAncestorIn(c.path, movedDirs)) {
          out.push({ ...c, quiet: true });
          continue;
        }
      }
      out.push(c);
    }
    return out;
  }

  function rememberInode(rel: string, ino: number): void {
    inodes.delete(rel);
    inodes.set(rel, ino);
    if (inodes.size > MAX_INODES) {
      const oldest = inodes.keys().next().value;
      if (oldest !== undefined) inodes.delete(oldest);
    }
  }

  function scheduleHeld(): void {
    if (heldTimer || held.length === 0 || closed) return;
    const wait = Math.max(0, Math.min(...held.map((h) => h.until)) - Date.now());
    heldTimer = setTimeout(() => {
      heldTimer = undefined;
      chain = chain.then(releaseHeld).catch(onError);
    }, wait);
  }

  /** Emits the held unlinks whose wait is over and that are still missing on disk. */
  function releaseHeld(): void {
    if (closed) return;
    const now = Date.now();
    const due = held.filter((h) => h.until <= now);
    held = held.filter((h) => h.until > now);
    const listings = new Map<string, string[] | undefined>();
    const removedDirs = new Set(
      [...due, ...held]
        .filter((h) => h.change.type === 'unlinkDir' && !probeStat(h.change.path, listings))
        .map((h) => h.change.path),
    );
    for (const h of due) {
      if (closed) return;
      if (hasAncestorIn(h.change.path, removedDirs)) continue; // The dir's unlinkDir covers it.
      if (probeStat(h.change.path, listings)) continue; // Back on disk: its own event says so.
      if (!index.has(h.change.path)) continue;
      inodes.delete(h.change.path);
      track(h.change);
      opts.onChange(h.change);
    }
    scheduleHeld();
  }

  function classify(p: Probe): DiskChangeType | undefined {
    const known = index.kind(p.rel);
    if (!p.stat) {
      lastMtime.delete(p.rel);
      if (known === 'dir') return 'unlinkDir';
      if (known === 'file') return 'unlink';
      return undefined;
    }
    const isDir = p.stat.isDirectory();
    if (known === undefined) {
      if (isCachedIgnored(p.rel)) return undefined;
      if (!isDir) lastMtime.set(p.rel, p.stat.mtimeMs);
      return isDir ? 'addDir' : 'add';
    }
    if (isDir) return undefined; // Known dir: children report their own changes.
    if (known === 'dir') return undefined; // Index says dir, disk says file: rare swap, left to unlink/add.
    const mtime = p.stat.mtimeMs;
    if (mtime < startedAt || lastMtime.get(p.rel) === mtime) return undefined;
    lastMtime.set(p.rel, mtime);
    return 'change';
  }

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (heldTimer) clearTimeout(heldTimer);
      timer = undefined;
      heldTimer = undefined;
      held = [];
      watcher?.close();
      for (const w of dirWatchers.values()) w.close();
      dirWatchers.clear();
      await Promise.all([...discovering]);
      await chain;
    },
  };
}
