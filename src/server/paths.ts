// Path relativization against the observed repo root.
// Handles macOS symlinked prefixes (/tmp -> /private/tmp, /var -> /private/var)
// and the non-realpath spelling of the root, without touching the disk per call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Where Claude Code checks out the worktree of a subagent launched with isolation
 * "worktree" (`git worktree add <root>/.claude/worktrees/agent-<id>`), relative to the root.
 */
export const WORKTREES_DIR = '.claude/worktrees';

/** True when `rel` is WORKTREES_DIR or lies under it (a full checkout, never part of the tree). */
export function isWorktreeRel(rel: string): boolean {
  return rel === WORKTREES_DIR || rel.startsWith(WORKTREES_DIR + '/');
}

/**
 * Splits a repo-relative path inside a Claude Code worktree into the worktree name and the
 * equivalent path in the main repo ("" for the worktree root). undefined when `rel` is not
 * inside one (WORKTREES_DIR itself included).
 */
export function splitWorktreeRel(rel: string): { worktree: string; rel: string } | undefined {
  if (!rel.startsWith(WORKTREES_DIR + '/')) return undefined;
  const rest = rel.slice(WORKTREES_DIR.length + 1);
  const slash = rest.indexOf('/');
  const worktree = slash === -1 ? rest : rest.slice(0, slash);
  if (worktree === '') return undefined;
  return { worktree, rel: slash === -1 ? '' : rest.slice(slash + 1).replace(/\/+$/, '') };
}

export interface ResolvedPath {
  /** Absolute path; rewritten onto the realpath'd root when inside. */
  abs: string;
  /** Relative to the root with "/" separators ("" for the root itself). Only when inside. */
  rel?: string;
  inside: boolean;
}

export interface PathResolver {
  root: string;
  resolve(p: string, cwd?: string): ResolvedPath;
}

/** macOS system dirs that are symlinks into /private. */
const PRIVATE_LINKED = ['/tmp', '/var', '/etc'];

function privateVariants(p: string): string[] {
  const out = [p];
  if (p.startsWith('/private/')) {
    const stripped = p.slice('/private'.length);
    if (PRIVATE_LINKED.some((d) => stripped === d || stripped.startsWith(d + '/'))) out.push(stripped);
  } else if (PRIVATE_LINKED.some((d) => p === d || p.startsWith(d + '/'))) {
    out.push('/private' + p);
  }
  return out;
}

function expandHome(p: string, P: typeof path.posix): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return P.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Windows: a Git Bash / MSYS / Cygwin spelling of a drive path (`/c/Users/me`,
 * `/cygdrive/c/Users/me`) as the Windows path (`C:\Users\me`). Claude Code runs Bash
 * through Git Bash there, so commands can carry either form.
 */
export function fromMsysPath(p: string): string {
  const m = /^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)(.*)$/.exec(p);
  if (!m) return p;
  return `${(m[1] as string).toUpperCase()}:${(m[2] as string) === '' ? '\\' : (m[2] as string).replace(/\//g, '\\')}`;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export interface PathResolverOptions {
  /** Path rules to follow (default: this process's). Tests pass 'win32' on any OS. */
  platform?: NodeJS.Platform;
  /** Realpath of the root (default: fs.realpathSync.native, falling back to the path as given). */
  realpath?: (p: string) => string;
}

/**
 * On Windows, paths compare case-insensitively (NTFS is, and drive letters come as `c:` or
 * `C:` depending on who built the path) and the MSYS spellings are accepted; elsewhere they
 * compare exactly.
 */
export function createPathResolver(root: string, opts: PathResolverOptions = {}): PathResolver {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const P = platform === process.platform ? path : win ? path.win32 : path.posix;
  const rawRoot = P.resolve(win ? fromMsysPath(root) : root);
  const realRoot = (opts.realpath ?? safeRealpath)(rawRoot);
  const aliases = new Set<string>();
  for (const r of [realRoot, rawRoot]) for (const v of win ? [r] : privateVariants(r)) aliases.add(v);
  // Longest first so a nested alias never shadows a longer one.
  const aliasList = [...aliases].sort((a, b) => b.length - a.length);
  const fold = (s: string): string => (win ? s.toLowerCase() : s);
  const folded = aliasList.map((alias) => {
    const prefix = alias.endsWith(P.sep) ? alias : alias + P.sep;
    return { alias: fold(alias), prefix: fold(prefix) };
  });

  function toRootRel(abs: string): string | undefined {
    const key = fold(abs);
    for (const { alias, prefix } of folded) {
      if (key === alias) return '';
      if (key.startsWith(prefix)) return toPosix(abs.slice(prefix.length));
    }
    return undefined;
  }

  const prepare = (p: string): string => expandHome(win ? fromMsysPath(p) : p, P);

  return {
    root: realRoot,
    resolve(p: string, cwd?: string): ResolvedPath {
      const base = cwd ? P.resolve(realRoot, prepare(cwd)) : realRoot;
      const abs = P.resolve(base, prepare(p));
      const rel = toRootRel(abs);
      if (rel === undefined) return { abs, inside: false };
      const canonical = rel === '' ? realRoot : P.join(realRoot, rel);
      return { abs: canonical, rel, inside: true };
    },
  };
}
