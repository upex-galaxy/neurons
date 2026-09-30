// Path relativization against the observed repo root.
// Handles macOS symlinked prefixes (/tmp -> /private/tmp, /var -> /private/var)
// and the non-realpath spelling of the root, without touching the disk per call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
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

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export function createPathResolver(root: string): PathResolver {
  const rawRoot = path.resolve(root);
  const realRoot = safeRealpath(rawRoot);
  const aliases = new Set<string>();
  for (const r of [realRoot, rawRoot]) for (const v of privateVariants(r)) aliases.add(v);
  // Longest first so a nested alias never shadows a longer one.
  const aliasList = [...aliases].sort((a, b) => b.length - a.length);

  function toRootRel(abs: string): string | undefined {
    for (const alias of aliasList) {
      if (abs === alias) return '';
      const prefix = alias.endsWith(path.sep) ? alias : alias + path.sep;
      if (abs.startsWith(prefix)) return toPosix(abs.slice(prefix.length));
    }
    return undefined;
  }

  return {
    root: realRoot,
    resolve(p: string, cwd?: string): ResolvedPath {
      const base = cwd ? path.resolve(realRoot, expandHome(cwd)) : realRoot;
      const abs = path.resolve(base, expandHome(p));
      const rel = toRootRel(abs);
      if (rel === undefined) return { abs, inside: false };
      const canonical = rel === '' ? realRoot : path.join(realRoot, rel);
      return { abs: canonical, rel, inside: true };
    },
  };
}
