import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DiskChange } from '../../src/server/attribution.ts';
import { TreeIndex, isGitIgnored, scanTree } from '../../src/server/tree.ts';
import { startWatcher, type WatcherHandle } from '../../src/server/watcher.ts';

const tmpDirs: string[] = [];
const handles: WatcherHandle[] = [];

beforeAll(() => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-'));
  tmpDirs.push(cfg);
  process.env.CLAUDE_CONFIG_DIR = cfg;
});

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.close();
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>, git = false): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-watch-')));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
  }
  return dir;
}

interface Setup {
  root: string;
  index: TreeIndex;
  changes: DiskChange[];
}

/** Starts a watcher; with `apply`, mirrors the server by applying structural changes to the index. */
async function setup(
  files: Record<string, string>,
  opts: { apply?: boolean; git?: boolean; isIgnored?: (rels: string[]) => Promise<Set<string>> } = {},
): Promise<Setup> {
  const root = makeRepo(files, opts.git);
  const index = new TreeIndex(await scanTree(root));
  const changes: DiskChange[] = [];
  const apply = opts.apply ?? true;
  const watchOpts: Parameters<typeof startWatcher>[0] = {
    root,
    index,
    onChange: (c) => {
      changes.push(c);
      if (!apply) return;
      if (c.type === 'add') index.add(c.path, 'file');
      else if (c.type === 'addDir') index.add(c.path, 'dir');
      else if (c.type === 'unlink' || c.type === 'unlinkDir') index.remove(c.path);
    },
  };
  if (opts.isIgnored) watchOpts.isIgnored = opts.isIgnored;
  handles.push(startWatcher(watchOpts));
  // Let FSEvents start its stream (and replay its short history) before touching the disk.
  await sleep(150);
  return { root, index, changes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for watcher');
    await sleep(10);
  }
}

const has = (changes: DiskChange[], type: DiskChange['type'], p: string) =>
  changes.some((c) => c.type === type && c.path === p);

describe('startWatcher', () => {
  it('reports no spurious changes at startup for files that existed before it', async () => {
    const s = await setup({ 'a.txt': 'a', 'src/b.ts': 'b' });
    await sleep(300);
    expect(s.changes).toEqual([]);
  });

  it('reports a new file as add', async () => {
    const s = await setup({ 'a.txt': 'a' });
    fs.writeFileSync(path.join(s.root, 'new.txt'), 'x');
    await waitFor(() => has(s.changes, 'add', 'new.txt'));
    expect(s.changes[0]?.ts).toBeTypeOf('number');
  });

  it('reports a nested new subtree as addDir + add, parents first', async () => {
    const s = await setup({ 'a.txt': 'a' });
    fs.mkdirSync(path.join(s.root, 'x/y'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'x/y/z.txt'), 'z');
    await waitFor(() => has(s.changes, 'add', 'x/y/z.txt'));
    const order = s.changes.map((c) => `${c.type}:${c.path}`);
    expect(order).toEqual(['addDir:x', 'addDir:x/y', 'add:x/y/z.txt']);
  });

  it('walks a new dir moved in from outside (only its root is reported by FSEvents)', async () => {
    const s = await setup({ 'a.txt': 'a' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-out-'));
    tmpDirs.push(outside);
    fs.mkdirSync(path.join(outside, 'pkg/lib'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'pkg/lib/m.js'), 'm');
    fs.writeFileSync(path.join(outside, 'pkg/readme.md'), 'r');
    fs.renameSync(path.join(outside, 'pkg'), path.join(s.root, 'pkg'));
    await waitFor(() => has(s.changes, 'add', 'pkg/lib/m.js') && has(s.changes, 'add', 'pkg/readme.md'));
    expect(has(s.changes, 'addDir', 'pkg')).toBe(true);
    expect(has(s.changes, 'addDir', 'pkg/lib')).toBe(true);
  });

  it('reports a modified known file as change, once per write', async () => {
    const s = await setup({ 'a.txt': 'a' });
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'changed');
    await waitFor(() => has(s.changes, 'change', 'a.txt'));
    await sleep(200);
    expect(s.changes.filter((c) => c.path === 'a.txt')).toHaveLength(1);
  });

  it('reports a deleted file as unlink', async () => {
    const s = await setup({ 'a.txt': 'a', 'b.txt': 'b' });
    fs.rmSync(path.join(s.root, 'a.txt'));
    await waitFor(() => has(s.changes, 'unlink', 'a.txt'));
    expect(s.changes.map((c) => c.path)).not.toContain('b.txt');
  });

  it('reports a removed dir as unlinkDir, without separate events for its children once applied', async () => {
    const s = await setup({ 'd/one.txt': '1', 'd/two.txt': '2', 'keep.txt': 'k' });
    fs.rmSync(path.join(s.root, 'd'), { recursive: true });
    await waitFor(() => has(s.changes, 'unlinkDir', 'd'));
    await sleep(150);
    expect(s.changes.map((c) => `${c.type}:${c.path}`)).toEqual(['unlinkDir:d']);
    expect(s.index.has('d/one.txt')).toBe(false);
  });

  it('reports a rename as unlink of the old path and add of the new one', async () => {
    const s = await setup({ 'old.txt': 'o' });
    fs.renameSync(path.join(s.root, 'old.txt'), path.join(s.root, 'new.txt'));
    await waitFor(() => has(s.changes, 'unlink', 'old.txt') && has(s.changes, 'add', 'new.txt'));
  });

  it('ignores a path that is created and deleted inside the coalescing window', async () => {
    const s = await setup({ 'a.txt': 'a' });
    fs.writeFileSync(path.join(s.root, 'tmp.txt'), 't');
    fs.rmSync(path.join(s.root, 'tmp.txt'));
    fs.writeFileSync(path.join(s.root, 'marker.txt'), 'm');
    await waitFor(() => has(s.changes, 'add', 'marker.txt'));
    await sleep(100);
    expect(s.changes.map((c) => c.path)).not.toContain('tmp.txt');
  });

  it('skips .git, .repo-synapse and, outside git, DEFAULT_EXCLUDES', async () => {
    const s = await setup({ 'a.txt': 'a' });
    for (const d of ['.git', '.repo-synapse', 'node_modules/pkg', 'dist', 'src/build']) {
      fs.mkdirSync(path.join(s.root, d), { recursive: true });
      fs.writeFileSync(path.join(s.root, d, 'f.txt'), 'x');
    }
    fs.writeFileSync(path.join(s.root, 'marker.txt'), 'm');
    await waitFor(() => has(s.changes, 'add', 'marker.txt'));
    await sleep(150);
    expect(s.changes.map((c) => `${c.type}:${c.path}`).sort()).toEqual(['add:marker.txt', 'addDir:src']);
  });

  it('drops new paths that isIgnored reports, and never walks an ignored dir', async () => {
    const asked: string[][] = [];
    const s = await setup(
      { 'a.txt': 'a' },
      {
        isIgnored: async (rels) => {
          asked.push([...rels]);
          return new Set(rels.filter((r) => r === 'deps' || r.endsWith('.log')));
        },
      },
    );
    fs.mkdirSync(path.join(s.root, 'deps/inner'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'deps/inner/x.js'), 'x');
    fs.writeFileSync(path.join(s.root, 'debug.log'), 'l');
    fs.writeFileSync(path.join(s.root, 'kept.ts'), 'k');
    await waitFor(() => has(s.changes, 'add', 'kept.ts'));
    await sleep(150);
    expect(s.changes.map((c) => c.path)).toEqual(['kept.ts']);
    // Known files are never sent to isIgnored.
    expect(asked.flat()).not.toContain('a.txt');
  });

  it('works with git check-ignore in a git repo (node_modules is not special there)', async () => {
    const root0 = { '.gitignore': 'ignored/\n*.tmp\n', 'a.txt': 'a' };
    const s = await setup(root0, { git: true });
    // Rebind isIgnored to the real repo: setup() does not know the root before creating it.
    await handles.pop()?.close();
    s.changes.length = 0;
    handles.push(
      startWatcher({
        root: s.root,
        index: s.index,
        isIgnored: (rels) => isGitIgnored(s.root, rels),
        onChange: (c) => s.changes.push(c),
      }),
    );
    await sleep(150);
    fs.mkdirSync(path.join(s.root, 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'ignored/x.txt'), 'x');
    fs.writeFileSync(path.join(s.root, 'scratch.tmp'), 't');
    fs.mkdirSync(path.join(s.root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'node_modules/y.js'), 'y');
    await waitFor(() => has(s.changes, 'add', 'node_modules/y.js'));
    await sleep(150);
    const got = s.changes.map((c) => `${c.type}:${c.path}`);
    expect(got).toContain('addDir:node_modules');
    expect(got.some((g) => g.includes('ignored') || g.includes('scratch.tmp'))).toBe(false);
  });

  it('does not mutate the index itself', async () => {
    const s = await setup({ 'a.txt': 'a' }, { apply: false });
    const before = s.index.size;
    fs.writeFileSync(path.join(s.root, 'n.txt'), 'n');
    fs.rmSync(path.join(s.root, 'a.txt'));
    await waitFor(() => has(s.changes, 'add', 'n.txt') && has(s.changes, 'unlink', 'a.txt'));
    expect(s.index.size).toBe(before);
    expect(s.index.has('a.txt')).toBe(true);
    expect(s.index.has('n.txt')).toBe(false);
  });

  it('stops reporting after close()', async () => {
    const s = await setup({ 'a.txt': 'a' });
    await handles.pop()?.close();
    fs.writeFileSync(path.join(s.root, 'late.txt'), 'l');
    await sleep(250);
    expect(s.changes).toEqual([]);
  });
});
