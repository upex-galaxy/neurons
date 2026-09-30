// Recursive disk watcher on top of fs.watch (FSEvents on macOS, one handle for
// the whole tree). Raw events carry no reliable type, so each path is coalesced
// and then classified with lstat against the tree index.
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
  onError?: (err: unknown) => void;
}

interface Probe {
  rel: string;
  /** undefined = missing on disk. */
  stat: fs.Stats | undefined;
}

const DEFAULT_MAX_WALK = 5000;

function lstat(abs: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(abs);
  } catch {
    return undefined;
  }
}

function hasIgnoredAncestor(rel: string, ignored: Set<string>): boolean {
  let i = rel.lastIndexOf('/');
  while (i > 0) {
    if (ignored.has(rel.slice(0, i))) return true;
    i = rel.lastIndexOf('/', i - 1);
  }
  return false;
}

export function startWatcher(opts: WatcherOptions): WatcherHandle {
  const root = opts.root;
  const index = opts.index;
  const coalesceMs = opts.coalesceMs ?? 40;
  const maxWalk = opts.maxWalk ?? DEFAULT_MAX_WALK;
  const excludeDefaults = opts.excludeDefaults ?? !fs.existsSync(path.join(root, '.git'));
  const onError = opts.onError ?? (() => {});
  // FSEvents replays recent history when a stream starts: file changes older
  // than the watcher are not news. Per-path mtimes drop repeated notifications.
  const startedAt = Date.now();
  const lastMtime = new Map<string, number>();
  /** Paths git ignores (and their subtrees), learned from isIgnored. */
  const ignoredCache = new Set<string>();

  let pending = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const excluded = (rel: string): boolean =>
    rel === '' || isAlwaysExcluded(rel) || (excludeDefaults && isExcludedRel(rel));

  const watcher = fs.watch(root, { recursive: true }, (_type, filename) => {
    if (closed || filename === null || filename === undefined) return;
    const rel = toPosix(String(filename)).replace(/^\.?\/+|\/+$/g, '');
    if (excluded(rel)) return;
    if (!pending.has(rel)) pending.set(rel, Date.now());
    if (!timer) timer = setTimeout(schedule, coalesceMs);
  });
  watcher.on('error', onError);

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
    return ignoredCache.has(rel) || hasIgnoredAncestor(rel, ignoredCache);
  }

  async function learnIgnored(rels: string[]): Promise<void> {
    if (!opts.isIgnored || rels.length === 0) return;
    try {
      for (const rel of await opts.isIgnored(rels)) ignoredCache.add(rel);
    } catch {
      /* treat as not ignored */
    }
  }

  async function flush(batch: Map<string, number>): Promise<void> {
    if (closed) return;
    const probes = new Map<string, Probe>();
    for (const rel of batch.keys()) probes.set(rel, { rel, stat: lstat(path.join(root, rel)) });

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
    for (const p of ordered) {
      if (closed) return;
      const type = classify(p);
      if (!type) continue;
      opts.onChange({ type, path: p.rel, ts: batch.get(p.rel) ?? Date.now() });
    }
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
      timer = undefined;
      watcher.close();
      await chain;
    },
  };
}
