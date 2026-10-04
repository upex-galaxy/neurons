// Resolves the directory a command works on to the root of its git repository.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../i18n.ts';
import { fail } from './output.ts';

/** Runs `git rev-parse --show-toplevel` in `dir` (execFile, no shell); undefined outside git. */
export type GitToplevel = (dir: string) => string | undefined;

export const gitToplevel: GitToplevel = (dir) => {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return top === '' ? undefined : top;
  } catch {
    return undefined;
  }
};

/**
 * On Windows the native realpath, which also gives the on-disk case and an upper-case
 * drive letter: `neu stop` from `c:\repo` must find the viewer started from `C:\Repo`.
 */
function realpath(p: string): string {
  return process.platform === 'win32' ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

export interface RepoRoot {
  /** Real path of the directory the command works on. */
  root: string;
  /** Real path of the directory that was given (or the cwd). */
  given: string;
  /** The directory is inside a git work tree (root is its top level). */
  isGit: boolean;
}

/**
 * Real path of `arg` (default: the cwd), moved up to its git top level when it is inside
 * a work tree. Fails when the directory does not exist or is a file.
 */
export function resolveRepoRoot(arg: string | undefined, git: GitToplevel = gitToplevel): RepoRoot {
  const abs = path.resolve(arg ?? process.cwd());
  let given: string;
  try {
    given = realpath(abs);
  } catch {
    fail(t('repo.missingDir', { path: abs }));
  }
  if (!fs.statSync(given).isDirectory()) fail(t('repo.notDir', { path: abs }));
  const top = git(given);
  if (top === undefined) return { root: given, given, isGit: false };
  let root: string;
  try {
    root = realpath(top);
  } catch {
    return { root: given, given, isGit: false };
  }
  return { root, given, isGit: true };
}
