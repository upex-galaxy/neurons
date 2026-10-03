// Resolves the directory a command works on to the root of its git repository.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
 * a work tree. Fails in Spanish when the directory does not exist or is a file.
 */
export function resolveRepoRoot(arg: string | undefined, git: GitToplevel = gitToplevel): RepoRoot {
  const abs = path.resolve(arg ?? process.cwd());
  let given: string;
  try {
    given = fs.realpathSync(abs);
  } catch {
    fail(`No existe el directorio ${abs}.`);
  }
  if (!fs.statSync(given).isDirectory()) fail(`${abs} no es un directorio.`);
  const top = git(given);
  if (top === undefined) return { root: given, given, isGit: false };
  let root: string;
  try {
    root = fs.realpathSync(top);
  } catch {
    return { root: given, given, isGit: false };
  }
  return { root, given, isGit: true };
}
