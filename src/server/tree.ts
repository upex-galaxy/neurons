// Initial repo scan and the in-memory path index.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_STATE_DIR_NAME, STATE_DIR_NAME, type NodeKind, type TreeEntry, type TreeSnapshot } from '../shared/types.ts';
import { toPosix } from './paths.ts';

export const DEFAULT_EXCLUDES = ['.git', 'node_modules', STATE_DIR_NAME, LEGACY_STATE_DIR_NAME, 'dist', 'build'];

/** Excluded even in git repos (git ls-files already applies .gitignore for the rest). */
const ALWAYS_EXCLUDED = ['.git', STATE_DIR_NAME, LEGACY_STATE_DIR_NAME];

const DEFAULT_MAX_FILES = 50_000;

function segments(rel: string): string[] {
  return toPosix(rel).split('/').filter(Boolean);
}

/** True when any segment of `rel` is one of DEFAULT_EXCLUDES (used for non-git repos). */
export function isExcludedRel(rel: string): boolean {
  return segments(rel).some((s) => DEFAULT_EXCLUDES.includes(s));
}

/** True when any segment of `rel` is `.git`, `.neurons` or the legacy `.repo-synapse`. */
export function isAlwaysExcluded(rel: string): boolean {
  return segments(rel).some((s) => ALWAYS_EXCLUDED.includes(s));
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}

function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function splitNul(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

interface Collected {
  entries: TreeEntry[];
  truncated: boolean;
}

/** Builds file + derived dir entries from a flat list of repo-relative file paths. */
function fromFileList(files: Iterable<string>, maxFiles: number): Collected {
  const kinds = new Map<string, NodeKind>();
  let count = 0;
  let truncated = false;
  for (const raw of files) {
    let rel = toPosix(raw);
    let kind: NodeKind = 'file';
    // Untracked nested repositories are listed as "dir/".
    if (rel.endsWith('/')) {
      rel = rel.replace(/\/+$/, '');
      kind = 'dir';
    }
    if (!rel || isAlwaysExcluded(rel) || kinds.has(rel)) continue;
    if (kind === 'file') {
      if (count >= maxFiles) {
        truncated = true;
        break;
      }
      count++;
    }
    kinds.set(rel, kind);
    const parts = rel.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = parts.slice(0, i).join('/');
      if (kinds.get(dir) === 'dir') break;
      kinds.set(dir, 'dir');
    }
  }
  const entries: TreeEntry[] = [];
  for (const [p, kind] of kinds) entries.push({ path: p, kind });
  return { entries: sortEntries(entries), truncated };
}

async function scanGit(root: string, maxFiles: number): Promise<Collected | null> {
  let listed: string;
  let deleted: string;
  try {
    [listed, deleted] = await Promise.all([
      execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root),
      execFileAsync('git', ['ls-files', '--deleted', '-z'], root),
    ]);
  } catch {
    return null; // Not a git repo, or git is not installed.
  }
  const gone = new Set(splitNul(deleted));
  const files = splitNul(listed).filter((f) => !gone.has(f));
  return fromFileList(files, maxFiles);
}

async function scanWalk(root: string, maxFiles: number): Promise<Collected> {
  const entries: TreeEntry[] = [];
  let count = 0;
  let truncated = false;
  const queue: string[] = [''];
  for (let qi = 0; qi < queue.length && !truncated; qi++) {
    const relDir = queue[qi] as string;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => comparePaths(a.name, b.name));
    for (const d of dirents) {
      if (DEFAULT_EXCLUDES.includes(d.name)) continue;
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isDirectory()) {
        entries.push({ path: rel, kind: 'dir' });
        queue.push(rel);
      } else {
        // Files, symlinks (not followed) and other special entries count as files.
        if (count >= maxFiles) {
          truncated = true;
          break;
        }
        count++;
        entries.push({ path: rel, kind: 'file' });
      }
    }
  }
  return { entries: sortEntries(entries), truncated };
}

export async function scanTree(root: string, opts?: { maxFiles?: number }): Promise<TreeSnapshot> {
  const real = await fs.promises.realpath(path.resolve(root));
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const collected = (await scanGit(real, maxFiles)) ?? (await scanWalk(real, maxFiles));
  return {
    root: real,
    name: path.basename(real),
    entries: collected.entries,
    truncated: collected.truncated,
  };
}

/**
 * Returns the subset of `rels` that git ignores. Empty set when `root` is not a
 * git repo, git is missing, or nothing is ignored.
 */
export function isGitIgnored(root: string, rels: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  const input = rels.filter((r) => r.length > 0 && !r.includes('\0'));
  if (input.length === 0) return Promise.resolve(result);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('git', ['check-ignore', '--stdin', '-z'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(result);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => resolve(new Set()));
    child.on('close', (code) => {
      // 0 = some ignored, 1 = none ignored, 128 = fatal (not a repo).
      if (code === 0) for (const p of splitNul(out)) result.add(p);
      resolve(result);
    });
    child.stdin.on('error', () => {
      /* child exited early (not a repo); handled by close */
    });
    child.stdin.end(input.join('\0') + '\0');
  });
}

export class TreeIndex {
  #root: string;
  #name: string;
  #truncated: boolean;
  #kinds = new Map<string, NodeKind>();
  #children = new Map<string, Set<string>>();

  constructor(snapshot: TreeSnapshot) {
    this.#root = snapshot.root;
    this.#name = snapshot.name;
    this.#truncated = snapshot.truncated;
    this.#children.set('', new Set());
    for (const e of snapshot.entries) this.add(e.path, e.kind);
  }

  get root(): string {
    return this.#root;
  }

  get size(): number {
    return this.#kinds.size;
  }

  has(rel: string): boolean {
    return rel === '' || this.#kinds.has(rel);
  }

  kind(rel: string): NodeKind | undefined {
    return rel === '' ? 'dir' : this.#kinds.get(rel);
  }

  /** Adds `rel` and any missing ancestors. Returns the new entries, parents first. */
  add(rel: string, kind: NodeKind): TreeEntry[] {
    rel = toPosix(rel).replace(/^\/+|\/+$/g, '');
    if (rel === '' || this.#kinds.has(rel)) return [];
    const added: TreeEntry[] = [];
    const parts = rel.split('/');
    let parent = '';
    for (let i = 0; i < parts.length; i++) {
      const cur = parts.slice(0, i + 1).join('/');
      const isLeaf = i === parts.length - 1;
      if (!this.#kinds.has(cur)) {
        const k: NodeKind = isLeaf ? kind : 'dir';
        this.#kinds.set(cur, k);
        if (k === 'dir') this.#children.set(cur, new Set());
        this.#childSet(parent).add(cur);
        added.push({ path: cur, kind: k });
      } else if (!isLeaf && this.#kinds.get(cur) !== 'dir') {
        // A file became a directory on disk: promote it.
        this.#kinds.set(cur, 'dir');
        this.#children.set(cur, new Set());
      }
      parent = cur;
    }
    return added;
  }

  /** Removes `rel` and its subtree. Returns the removed paths ([] if absent). */
  remove(rel: string): string[] {
    rel = toPosix(rel).replace(/^\/+|\/+$/g, '');
    if (rel === '' || !this.#kinds.has(rel)) return [];
    const removed: string[] = [];
    const stack = [rel];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      removed.push(cur);
      this.#kinds.delete(cur);
      const kids = this.#children.get(cur);
      if (kids) {
        stack.push(...kids);
        this.#children.delete(cur);
      }
    }
    const slash = rel.lastIndexOf('/');
    this.#children.get(slash === -1 ? '' : rel.slice(0, slash))?.delete(rel);
    return removed;
  }

  snapshot(): TreeSnapshot {
    const entries: TreeEntry[] = [];
    for (const [p, kind] of this.#kinds) entries.push({ path: p, kind });
    return { root: this.#root, name: this.#name, entries: sortEntries(entries), truncated: this.#truncated };
  }

  #childSet(dir: string): Set<string> {
    let s = this.#children.get(dir);
    if (!s) {
      s = new Set();
      this.#children.set(dir, s);
    }
    return s;
  }
}
