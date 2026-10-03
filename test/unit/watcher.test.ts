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
      else if (c.type === 'move' || c.type === 'moveDir') {
        if (c.from !== undefined) index.remove(c.from);
        index.add(c.path, c.type === 'moveDir' ? 'dir' : 'file');
      }
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

/** Makes files look old: a rename keeps the birth time, a new file is born now (macOS moves birthtime back with mtime). */
function age(root: string, ...rels: string[]): void {
  const old = new Date(Date.now() - 60_000);
  for (const rel of rels) fs.utimesSync(path.join(root, rel), old, old);
}

/** True when this volume ignores case (APFS default). */
function caseInsensitive(dir: string): boolean {
  const probe = path.join(dir, 'CaseProbe.tmp');
  fs.writeFileSync(probe, '');
  try {
    return fs.existsSync(path.join(dir, 'caseprobe.tmp'));
  } finally {
    fs.rmSync(probe);
  }
}

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

  // Regression: FSEvents may deliver the children of `rm -r d` one batch before d. The child
  // unlinks were still held for pairing and went out next to the unlinkDir.
  it('a dir removed one batch after its children is still one unlinkDir', async () => {
    const s = await setup({ 'd/one.txt': '1', 'd/two.txt': '2', 'keep.txt': 'k' });
    fs.rmSync(path.join(s.root, 'd/one.txt'));
    fs.rmSync(path.join(s.root, 'd/two.txt'));
    await sleep(90); // past the coalescing window, inside the pairing wait
    fs.rmdirSync(path.join(s.root, 'd'));
    await waitFor(() => has(s.changes, 'unlinkDir', 'd'));
    await sleep(350);
    expect(s.changes.map((c) => `${c.type}:${c.path}`)).toEqual(['unlinkDir:d']);
    expect(s.index.has('d/one.txt')).toBe(false);
  });

  // Regression (F5): the watcher never produced a move.
  it('reports a rename as one move with the old path in from', async () => {
    const s = await setup({ 'old.txt': 'o', 'keep.txt': 'k' });
    age(s.root, 'old.txt');
    fs.renameSync(path.join(s.root, 'old.txt'), path.join(s.root, 'new.txt'));
    await waitFor(() => has(s.changes, 'move', 'new.txt'));
    await sleep(300);
    expect(s.changes).toEqual([{ type: 'move', path: 'new.txt', from: 'old.txt', ts: expect.any(Number) }]);
    expect(s.index.has('old.txt')).toBe(false);
    expect(s.index.kind('new.txt')).toBe('file');
  });

  it('reports a moved file that keeps its name as a move', async () => {
    const s = await setup({ 'a/x.ts': 'x', 'b/keep.txt': 'k' });
    age(s.root, 'a/x.ts');
    fs.renameSync(path.join(s.root, 'a/x.ts'), path.join(s.root, 'b/x.ts'));
    await waitFor(() => has(s.changes, 'move', 'b/x.ts'));
    await sleep(300);
    expect(s.changes.map((c) => `${c.type}:${c.path}<${c.from ?? ''}`)).toEqual(['move:b/x.ts<a/x.ts']);
  });

  it('reports a dir rename as one moveDir, its contents quiet', async () => {
    const s = await setup({ 'src/a/one.ts': '1', 'src/keep.ts': 'k' });
    age(s.root, 'src/a', 'src/a/one.ts');
    fs.renameSync(path.join(s.root, 'src/a'), path.join(s.root, 'src/b'));
    await waitFor(() => has(s.changes, 'moveDir', 'src/b'));
    await sleep(300);
    const loud = s.changes.filter((c) => !c.quiet).map((c) => `${c.type}:${c.path}<${c.from ?? ''}`);
    expect(loud).toEqual(['moveDir:src/b<src/a']);
    expect(s.changes.filter((c) => c.quiet).map((c) => `${c.type}:${c.path}`)).toEqual(['add:src/b/one.ts']);
    expect(s.index.has('src/a')).toBe(false);
    expect(s.index.has('src/a/one.ts')).toBe(false);
    expect(s.index.kind('src/b/one.ts')).toBe('file');
  });

  it('does not pair a delete with a freshly written file of the same name (git checkout)', async () => {
    const s = await setup({ 'a/index.ts': 'a', 'b/keep.txt': 'k' });
    fs.rmSync(path.join(s.root, 'a/index.ts'));
    fs.writeFileSync(path.join(s.root, 'b/index.ts'), 'b');
    await waitFor(() => has(s.changes, 'unlink', 'a/index.ts') && has(s.changes, 'add', 'b/index.ts'));
    expect(s.changes.some((c) => c.type === 'move')).toBe(false);
  });

  it('pairs a file it saw appear by inode, even when it moves right away', async () => {
    const s = await setup({ 'keep.txt': 'k' });
    fs.writeFileSync(path.join(s.root, 'draft.txt'), 'd');
    await waitFor(() => has(s.changes, 'add', 'draft.txt'));
    fs.renameSync(path.join(s.root, 'draft.txt'), path.join(s.root, 'final.txt'));
    await waitFor(() => has(s.changes, 'move', 'final.txt'));
    expect(s.changes.find((c) => c.type === 'move')).toMatchObject({ path: 'final.txt', from: 'draft.txt' });
  });

  it('does not pair a delete with an unrelated new file', async () => {
    const s = await setup({ 'gone.txt': 'g' });
    fs.rmSync(path.join(s.root, 'gone.txt'));
    fs.writeFileSync(path.join(s.root, 'fresh.txt'), 'f');
    await waitFor(() => has(s.changes, 'unlink', 'gone.txt') && has(s.changes, 'add', 'fresh.txt'));
    expect(s.changes.some((c) => c.type === 'move')).toBe(false);
  });

  it('drops a held unlink when the path is back (delete and re-create)', async () => {
    const s = await setup({ 'a.txt': 'a' });
    fs.rmSync(path.join(s.root, 'a.txt'));
    await sleep(80); // past the coalescing window, inside the pairing wait
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'again');
    await waitFor(() => has(s.changes, 'change', 'a.txt'));
    await sleep(300);
    expect(s.changes.map((c) => `${c.type}:${c.path}`)).toEqual(['change:a.txt']);
    expect(s.index.has('a.txt')).toBe(true);
  });

  // Regression (F3): on APFS lstat('Foo.ts') succeeds after `mv Foo.ts foo.ts`, which left a ghost node.
  it('reports a case-only rename as a move and leaves no ghost of the old spelling', async (ctx) => {
    const s = await setup({ 'src/Foo.ts': 'f' });
    if (!caseInsensitive(s.root)) ctx.skip();
    fs.renameSync(path.join(s.root, 'src/Foo.ts'), path.join(s.root, 'src/foo.ts'));
    await waitFor(() => has(s.changes, 'move', 'src/foo.ts'));
    await sleep(300);
    expect(s.changes.map((c) => `${c.type}:${c.path}<${c.from ?? ''}`)).toEqual(['move:src/foo.ts<src/Foo.ts']);
    expect(s.index.snapshot().entries.map((e) => e.path)).toEqual(['src', 'src/foo.ts']);
  });

  it('a path removed from the index by a hook is not re-added from its old spelling', async (ctx) => {
    const s = await setup({ 'Bar.ts': 'b' });
    if (!caseInsensitive(s.root)) ctx.skip();
    // What the server does for a bashEditDiff move (git mv Bar.ts bar.ts): the index moves first.
    fs.renameSync(path.join(s.root, 'Bar.ts'), path.join(s.root, 'bar.ts'));
    s.index.remove('Bar.ts');
    s.index.add('bar.ts', 'file');
    await sleep(400);
    expect(s.changes.filter((c) => c.path === 'Bar.ts' || c.from === 'Bar.ts')).toEqual([]);
    expect(s.index.has('Bar.ts')).toBe(false);
  });

  // Regression (F4): outside git, a hook could put build/out.js in the index and the watcher
  // then dropped its removal because build/ is a default exclude.
  it('outside git, still reports the removal of an excluded path the index knows', async () => {
    const s = await setup({ 'a.txt': 'a', 'build/out.js': 'o' });
    s.index.add('build/out.js', 'file');
    fs.rmSync(path.join(s.root, 'build'), { recursive: true });
    await waitFor(() => has(s.changes, 'unlinkDir', 'build'));
    await sleep(300);
    expect(s.changes.map((c) => `${c.type}:${c.path}`)).toEqual(['unlinkDir:build']);
    expect(s.index.has('build')).toBe(false);
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

  it('skips .git, .neurons, the legacy .repo-synapse and, outside git, DEFAULT_EXCLUDES', async () => {
    const s = await setup({ 'a.txt': 'a' });
    for (const d of ['.git', '.neurons', '.repo-synapse', 'node_modules/pkg', 'dist', 'src/build']) {
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
