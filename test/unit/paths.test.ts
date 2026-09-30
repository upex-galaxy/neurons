import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPathResolver, toPosix } from '../../src/server/paths.ts';

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

  it('keeps .git and .repo-synapse paths inside (filtering happens elsewhere)', () => {
    const r = createPathResolver(mk(os.tmpdir()));
    expect(r.resolve('.git/HEAD')).toMatchObject({ rel: '.git/HEAD', inside: true });
    expect(r.resolve('.repo-synapse/events.jsonl')).toMatchObject({ rel: '.repo-synapse/events.jsonl', inside: true });
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
