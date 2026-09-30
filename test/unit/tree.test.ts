import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDES,
  TreeIndex,
  isAlwaysExcluded,
  isExcludedRel,
  isGitIgnored,
  scanTree,
} from '../../src/server/tree.ts';
import type { TreeSnapshot } from '../../src/shared/types.ts';

const tmpDirs: string[] = [];

beforeAll(() => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-'));
  tmpDirs.push(cfg);
  process.env.CLAUDE_CONFIG_DIR = cfg;
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkRepo(files: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tree-'));
  tmpDirs.push(d);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), 'x');
  }
  return d;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const paths = (s: TreeSnapshot) => s.entries.map((e) => `${e.kind === 'dir' ? 'd' : 'f'}:${e.path}`);

describe('exclusion helpers', () => {
  it('isExcludedRel matches any DEFAULT_EXCLUDES segment', () => {
    expect(DEFAULT_EXCLUDES).toEqual(['.git', 'node_modules', '.repo-synapse', 'dist', 'build']);
    expect(isExcludedRel('node_modules/x/index.js')).toBe(true);
    expect(isExcludedRel('packages/a/dist/index.js')).toBe(true);
    expect(isExcludedRel('.git')).toBe(true);
    expect(isExcludedRel('src/distance.ts')).toBe(false);
    expect(isExcludedRel('')).toBe(false);
  });

  it('isAlwaysExcluded only matches .git and .repo-synapse', () => {
    expect(isAlwaysExcluded('.git/HEAD')).toBe(true);
    expect(isAlwaysExcluded('a/.repo-synapse/events.jsonl')).toBe(true);
    expect(isAlwaysExcluded('node_modules/x')).toBe(false);
    expect(isAlwaysExcluded('dist/a.js')).toBe(false);
    expect(isAlwaysExcluded('.github/workflows/ci.yml')).toBe(false);
  });
});

describe('scanTree (not a git repo)', () => {
  it('walks recursively with DEFAULT_EXCLUDES, derives dirs, sorts entries', async () => {
    const dir = mkRepo(['b.txt', 'src/a.ts', 'src/utils/x.ts', 'node_modules/p/i.js', 'dist/o.js', 'build/o.js', '.repo-synapse/e.jsonl', '.claude/rules/api.md']);
    fs.mkdirSync(path.join(dir, 'empty'));
    const snap = await scanTree(dir);
    expect(snap.root).toBe(fs.realpathSync(dir));
    expect(snap.name).toBe(path.basename(dir));
    expect(snap.truncated).toBe(false);
    expect(paths(snap)).toEqual([
      'd:.claude',
      'd:.claude/rules',
      'f:.claude/rules/api.md',
      'f:b.txt',
      'd:empty',
      'd:src',
      'f:src/a.ts',
      'd:src/utils',
      'f:src/utils/x.ts',
    ]);
  });

  it('sets truncated when maxFiles is reached', async () => {
    const dir = mkRepo(['a/1', 'a/2', 'a/3', 'b/4', 'b/5']);
    const snap = await scanTree(dir, { maxFiles: 3 });
    expect(snap.truncated).toBe(true);
    expect(snap.entries.filter((e) => e.kind === 'file')).toHaveLength(3);
  });
});

describe('scanTree (git repo)', () => {
  it('uses git ls-files: honors .gitignore, includes untracked, drops deleted and .repo-synapse', async () => {
    const dir = mkRepo(['.gitignore', 'src/a.ts', 'src/gone.ts', 'ignored/x.txt', 'app.log', 'dist/keep.js', 'new/untracked.ts', '.repo-synapse/events.jsonl']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n*.log\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '.gitignore', 'src/a.ts', 'src/gone.ts');
    fs.rmSync(path.join(dir, 'src/gone.ts'));
    const snap = await scanTree(dir);
    expect(paths(snap)).toEqual([
      'f:.gitignore',
      'd:dist',
      'f:dist/keep.js', // not in .gitignore: git mode only drops .git/.repo-synapse
      'd:new',
      'f:new/untracked.ts',
      'd:src',
      'f:src/a.ts',
    ]);
  });

  it('truncates git listings at maxFiles', async () => {
    const dir = mkRepo(['a.ts', 'b.ts', 'c.ts']);
    git(dir, 'init', '-q');
    const snap = await scanTree(dir, { maxFiles: 2 });
    expect(snap.truncated).toBe(true);
    expect(snap.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('isGitIgnored', () => {
  it('returns the ignored subset in a git repo', async () => {
    const dir = mkRepo(['.gitignore', 'src/a.ts']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n*.log\n');
    git(dir, 'init', '-q');
    const ignored = await isGitIgnored(dir, ['dist/a.js', 'src/a.ts', 'x.log', 'src/deep/y.log', 'README.md']);
    expect([...ignored].sort()).toEqual(['dist/a.js', 'src/deep/y.log', 'x.log']);
    expect((await isGitIgnored(dir, ['src/a.ts'])).size).toBe(0);
    expect((await isGitIgnored(dir, [])).size).toBe(0);
  });

  it('returns an empty set outside a git repo', async () => {
    const dir = mkRepo(['a.log']);
    expect((await isGitIgnored(dir, ['a.log'])).size).toBe(0);
  });
});

describe('TreeIndex', () => {
  const snap: TreeSnapshot = {
    root: '/r',
    name: 'r',
    truncated: false,
    entries: [
      { path: 'src', kind: 'dir' },
      { path: 'src/a.ts', kind: 'file' },
      { path: 'README.md', kind: 'file' },
    ],
  };

  it('answers has/kind/size and treats "" as the root dir', () => {
    const idx = new TreeIndex(snap);
    expect(idx.root).toBe('/r');
    expect(idx.size).toBe(3);
    expect(idx.has('')).toBe(true);
    expect(idx.kind('')).toBe('dir');
    expect(idx.has('src/a.ts')).toBe(true);
    expect(idx.kind('src')).toBe('dir');
    expect(idx.kind('nope')).toBeUndefined();
  });

  it('add creates missing ancestors parents-first and is idempotent', () => {
    const idx = new TreeIndex(snap);
    expect(idx.add('src/api/v1/user.ts', 'file')).toEqual([
      { path: 'src/api', kind: 'dir' },
      { path: 'src/api/v1', kind: 'dir' },
      { path: 'src/api/v1/user.ts', kind: 'file' },
    ]);
    expect(idx.add('src/api/v1/user.ts', 'file')).toEqual([]);
    expect(idx.add('src', 'dir')).toEqual([]);
    expect(idx.add('docs', 'dir')).toEqual([{ path: 'docs', kind: 'dir' }]);
    expect(idx.size).toBe(7);
  });

  it('remove drops the subtree and returns removed paths', () => {
    const idx = new TreeIndex(snap);
    idx.add('src/api/user.ts', 'file');
    expect(idx.remove('src').sort()).toEqual(['src', 'src/a.ts', 'src/api', 'src/api/user.ts']);
    expect(idx.remove('src')).toEqual([]);
    expect(idx.remove('')).toEqual([]);
    expect(idx.snapshot().entries).toEqual([{ path: 'README.md', kind: 'file' }]);
    // Re-adding after removal works and re-creates the parent.
    expect(idx.add('src/b.ts', 'file')).toEqual([
      { path: 'src', kind: 'dir' },
      { path: 'src/b.ts', kind: 'file' },
    ]);
  });

  it('snapshot is sorted and keeps root, name and truncated', () => {
    const idx = new TreeIndex({ ...snap, truncated: true });
    idx.add('a/z.ts', 'file');
    const s = idx.snapshot();
    expect(s.root).toBe('/r');
    expect(s.name).toBe('r');
    expect(s.truncated).toBe(true);
    expect(s.entries.map((e) => e.path)).toEqual(['README.md', 'a', 'a/z.ts', 'src', 'src/a.ts']);
  });

  it('round-trips a real scan', async () => {
    const dir = mkRepo(['x/y/z.ts', 'w.ts']);
    const scanned = await scanTree(dir);
    expect(new TreeIndex(scanned).snapshot()).toEqual(scanned);
  });
});
