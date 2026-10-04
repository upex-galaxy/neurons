import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPathResolver, fromMsysPath, toPosix } from '../../src/server/paths.ts';

const tmpDirs: string[] = [];

beforeAll(() => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfg-'));
  tmpDirs.push(cfg);
  process.env.CLAUDE_CONFIG_DIR = cfg;
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function mk(parent: string): string {
  const d = fs.mkdtempSync(path.join(parent, 'rs-paths-'));
  tmpDirs.push(d);
  fs.mkdirSync(path.join(d, 'src'));
  return d;
}

describe('toPosix', () => {
  it('converts backslashes', () => {
    expect(toPosix('a\\b\\c.ts')).toBe('a/b/c.ts');
    expect(toPosix('a/b')).toBe('a/b');
  });
});

describe('createPathResolver', () => {
  it('realpaths the root and relativizes inside paths', () => {
    const dir = mk(os.tmpdir());
    const r = createPathResolver(dir);
    // The native realpath, as the resolver: on Windows it also expands 8.3 short names.
    expect(r.root).toBe(fs.realpathSync.native(dir));
    expect(r.resolve(path.join(dir, 'src/a.ts'))).toEqual({ abs: path.join(r.root, 'src/a.ts'), rel: 'src/a.ts', inside: true });
    expect(r.resolve(dir)).toMatchObject({ rel: '', inside: true, abs: r.root });
    expect(r.resolve(r.root + '/')).toMatchObject({ rel: '', inside: true });
  });

  it('resolves relative inputs against cwd, or the root', () => {
    const dir = mk(os.tmpdir());
    const r = createPathResolver(dir);
    expect(r.resolve('src/a.ts').rel).toBe('src/a.ts');
    expect(r.resolve('a.ts', path.join(dir, 'src')).rel).toBe('src/a.ts');
    expect(r.resolve('../README.md', path.join(dir, 'src')).rel).toBe('README.md');
    expect(r.resolve('.', path.join(dir, 'src')).rel).toBe('src');
    expect(r.resolve('src/api', 'lib').rel).toBe('lib/src/api'); // relative cwd -> against root
  });

  it('treats outside paths and sibling prefixes as outside', () => {
    const dir = mk(os.tmpdir());
    const r = createPathResolver(dir);
    expect(r.resolve('../other.txt')).toMatchObject({ inside: false });
    expect(r.resolve(dir + '-sibling/x.ts')).toEqual({ abs: path.resolve(dir + '-sibling/x.ts'), inside: false });
    expect(r.resolve('/etc/hosts').inside).toBe(false);
    expect(r.resolve('/etc/hosts').rel).toBeUndefined();
  });

  it('keeps .git and .neurons paths inside (filtering happens elsewhere)', () => {
    const r = createPathResolver(mk(os.tmpdir()));
    expect(r.resolve('.git/HEAD')).toMatchObject({ rel: '.git/HEAD', inside: true });
    expect(r.resolve('.neurons/events.jsonl')).toMatchObject({ rel: '.neurons/events.jsonl', inside: true });
  });

  it('expands ~ against the home directory', () => {
    const r = createPathResolver(mk(os.tmpdir()));
    expect(r.resolve('~/.claude/CLAUDE.md')).toEqual({ abs: path.join(os.homedir(), '.claude/CLAUDE.md'), inside: false });
  });

  const darwinTmp = process.platform === 'darwin' && fs.lstatSync('/tmp').isSymbolicLink();
  it.skipIf(!darwinTmp)('treats /tmp and /private/tmp as the same root (macOS)', () => {
    const dir = mk('/tmp'); // "/tmp/rs-paths-XXXX"
    const privateDir = '/private' + dir;
    for (const rootForm of [dir, privateDir]) {
      const r = createPathResolver(rootForm);
      expect(r.root).toBe(privateDir);
      expect(r.resolve(`${dir}/src/a.ts`)).toEqual({ abs: `${privateDir}/src/a.ts`, rel: 'src/a.ts', inside: true });
      expect(r.resolve(`${privateDir}/src/a.ts`).rel).toBe('src/a.ts');
      expect(r.resolve('a.ts', `${dir}/src`).rel).toBe('src/a.ts');
      expect(r.resolve('b.ts', `${privateDir}/src`).rel).toBe('src/b.ts');
      expect(r.resolve(dir).rel).toBe('');
      expect(r.resolve(`${dir}x/file`).inside).toBe(false);
    }
  });

  it('handles the os.tmpdir() /var -> /private/var symlink on macOS', () => {
    const dir = mk(os.tmpdir());
    const r = createPathResolver(dir);
    // Both spellings of the same file are inside.
    expect(r.resolve(path.join(dir, 'x.ts')).rel).toBe('x.ts');
    expect(r.resolve(path.join(r.root, 'x.ts')).rel).toBe('x.ts');
  });
});

describe('createPathResolver on Windows rules', () => {
  const root = 'C:\\Users\\Me\\repo';
  const r = createPathResolver(root, { platform: 'win32', realpath: (p) => p });

  it('matches case-insensitively (drive letter included) and keeps "/" separators in rel', () => {
    expect(r.resolve('C:\\Users\\Me\\repo\\src\\a.ts')).toEqual({ abs: 'C:\\Users\\Me\\repo\\src\\a.ts', rel: 'src/a.ts', inside: true });
    expect(r.resolve('c:\\users\\me\\REPO\\src\\a.ts')).toMatchObject({ rel: 'src/a.ts', inside: true, abs: 'C:\\Users\\Me\\repo\\src\\a.ts' });
    expect(r.resolve('C:/Users/Me/repo/web/main.ts')).toMatchObject({ rel: 'web/main.ts', inside: true });
    expect(r.resolve('c:\\users\\me\\repo')).toMatchObject({ rel: '', inside: true });
    expect(r.resolve('C:\\Users\\Me\\repo2\\x.ts')).toMatchObject({ inside: false });
    expect(r.resolve('D:\\Users\\Me\\repo\\x.ts')).toMatchObject({ inside: false });
  });

  it('resolves relative paths against a cwd and accepts Git Bash drive paths', () => {
    expect(r.resolve('src\\a.ts', 'c:\\Users\\Me\\repo')).toMatchObject({ rel: 'src/a.ts', inside: true });
    expect(r.resolve('/c/Users/Me/repo/src/a.ts')).toMatchObject({ rel: 'src/a.ts', inside: true });
    expect(r.resolve('/cygdrive/c/Users/Me/repo/src')).toMatchObject({ rel: 'src', inside: true });
    expect(r.resolve('a.ts', '/c/Users/Me/repo/src')).toMatchObject({ rel: 'src/a.ts', inside: true });
    expect(fromMsysPath('/c')).toBe('C:\\');
    expect(fromMsysPath('/tmp/x')).toBe('/tmp/x');
    expect(fromMsysPath('/usr/bin')).toBe('/usr/bin');
  });

  // Regression (Windows CI): os.tmpdir() is C:\\Users\\RUNNER~1\\... while the realpath of the
  // root is C:\\Users\\runneradmin\\...; payloads in the short spelling fell outside the repo.
  it('8.3 short names: a path outside every alias is expanded through the realpath of its folders', () => {
    const calls: string[] = [];
    const longOf = (p: string): string => {
      calls.push(p);
      const m = /^c:\\users\\runner~1(\\appdata(\\[^\\]*)*)?$/i.exec(p);
      if (!m) return p;
      // Only folders exist: a file path (with an extension) has no realpath.
      if (/\.[a-z]+$/i.test(p)) return p;
      return 'C:\\Users\\runneradmin' + (m[1] ?? '');
    };
    const w = createPathResolver('C:\\Users\\runneradmin\\AppData\\repo', { platform: 'win32', realpath: longOf });
    expect(w.root).toBe('C:\\Users\\runneradmin\\AppData\\repo');
    expect(w.resolve('C:\\Users\\RUNNER~1\\AppData\\repo\\src\\new.ts')).toEqual({
      abs: 'C:\\Users\\runneradmin\\AppData\\repo\\src\\new.ts',
      rel: 'src/new.ts',
      inside: true,
    });
    expect(w.resolve('a.ts', 'C:\\Users\\RUNNER~1\\AppData\\repo\\src')).toMatchObject({ rel: 'src/a.ts', inside: true });
    expect(w.resolve('C:\\Users\\RUNNER~1\\AppData\\other\\x.ts')).toEqual({ abs: 'C:\\Users\\RUNNER~1\\AppData\\other\\x.ts', inside: false });
    // A path without a short name never touches the disk; folders are looked up once.
    calls.length = 0;
    expect(w.resolve('C:\\elsewhere\\x.ts').inside).toBe(false);
    expect(calls).toEqual([]);
    w.resolve('C:\\Users\\RUNNER~1\\AppData\\repo\\src\\new.ts');
    expect(calls).toEqual([]);
    // Elsewhere a ~1 is just a character.
    const p = createPathResolver('/home/me/repo', { platform: 'linux', realpath: longOf });
    expect(p.resolve('/home/me/REPO~1/a.ts').inside).toBe(false);
  });

  it('POSIX rules stay case-sensitive', () => {
    const p = createPathResolver('/home/me/repo', { platform: 'linux', realpath: (x) => x });
    expect(p.resolve('/home/me/repo/src/a.ts')).toMatchObject({ rel: 'src/a.ts', inside: true });
    expect(p.resolve('/home/me/Repo/src/a.ts')).toMatchObject({ inside: false });
  });
});
