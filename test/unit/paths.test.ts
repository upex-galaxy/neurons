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
    expect(r.root).toBe(fs.realpathSync(dir));
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
    expect(r.resolve(dir + '-sibling/x.ts')).toEqual({ abs: dir + '-sibling/x.ts', inside: false });
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

  it('POSIX rules stay case-sensitive', () => {
    const p = createPathResolver('/home/me/repo', { platform: 'linux', realpath: (x) => x });
    expect(p.resolve('/home/me/repo/src/a.ts')).toMatchObject({ rel: 'src/a.ts', inside: true });
    expect(p.resolve('/home/me/Repo/src/a.ts')).toMatchObject({ inside: false });
  });
});
