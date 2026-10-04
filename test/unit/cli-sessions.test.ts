import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findClaudeSessions,
  isClaudeArgv,
  isInside,
  decodeLsofName,
  parseLsofCwd,
  parsePsOutput,
  processTree,
  sessionsInRepo,
  sessionWarning,
  startHint,
  type CommandRunner,
} from '../../src/cli/sessions.ts';
import { setLang } from '../../src/i18n.ts';

// The messages asserted below are the Spanish ones.
setLang('es');

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// /tmp on macOS is a symlink to /private/tmp; lsof reports the real path.
const fakeRealpath = (p: string) => (p === '/tmp' || p.startsWith('/tmp/') ? `/private${p}` : p);

// pid ppid args. 900 is us (node .../cli.mjs), started from a Claude Code session (500)
// through a shell (800); 600 and 610 are other sessions, 700 is the desktop app.
const PS = `
    1     0 /sbin/launchd
  500     1 claude --continue
  800   500 /bin/zsh -c neu
  900   800 /usr/local/bin/node /x/neurons/dist/cli.mjs start
  901   900 git rev-parse --show-toplevel
  600     1 claude
  610     1 /Users/me/.local/bin/claude --resume abc
  620     1 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js
  630     1 node /Users/me/.npm-global/bin/claude
  640     1 claude
  700     1 /Applications/Claude.app/Contents/MacOS/Claude
  710     1 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
  720     1 node /x/server.js
`;

// lsof -nP -a -p <pids> -d cwd -Fpn
const LSOF = ['p500', 'fcwd', 'n/private/tmp/repo', 'p600', 'fcwd', 'n/private/tmp/repo/src', 'p610', 'fcwd', 'n/private/tmp/repo-other', 'p620', 'fcwd', 'n/tmp/repo', 'p630', 'fcwd', 'n/Users/me/elsewhere', 'p640', 'fcwd', 'n/private/tmp'].join('\n') + '\n';

describe('parsers', () => {
  it('parsePsOutput keeps pid, ppid and argv', () => {
    const procs = parsePsOutput(PS);
    expect(procs.find((p) => p.pid === 610)).toEqual({ pid: 610, ppid: 1, argv: ['/Users/me/.local/bin/claude', '--resume', 'abc'] });
    expect(procs.find((p) => p.pid === 1)?.ppid).toBe(0);
    expect(parsePsOutput('garbage\n\n  12\n')).toEqual([]);
  });

  it('parseLsofCwd maps pid -> cwd and ignores fds other than cwd', () => {
    expect(parseLsofCwd(LSOF).get(600)).toBe('/private/tmp/repo/src');
    expect(parseLsofCwd('p1\nfcwd\nn/a\nf3\nn/b\np2\nn/c\npX\nn/d\n')).toEqual(
      new Map([
        [1, '/a'],
        [2, '/c'],
      ]),
    );
    expect(parseLsofCwd('p1\r\nc2.1.285\r\nfcwd\r\nn/with space/dir\r\n').get(1)).toBe('/with space/dir');
  });

  // Regression: without a UTF-8 locale lsof prints non-ASCII bytes as \xNN escapes.
  it('decodes the \\xNN escapes lsof prints for non-ASCII paths', () => {
    expect(parseLsofCwd('p7\nfcwd\nn/Users/me/c\\xc3\\xb3digo con espacio\n').get(7)).toBe('/Users/me/código con espacio');
    expect(decodeLsofName('/a/\\xe6\\x97\\xa5\\xe6\\x9c\\xac')).toBe('/a/日本');
    // ASCII escapes and invalid UTF-8 stay as printed.
    expect(decodeLsofName('/a/\\x41b')).toBe('/a/\\x41b');
    expect(decodeLsofName('/a/\\xc3x')).toBe('/a/\\xc3x');
    expect(decodeLsofName('/plain/path')).toBe('/plain/path');
  });

  it('isClaudeArgv: claude binaries and node running the claude script, not the desktop app', () => {
    expect(isClaudeArgv(['claude'])).toBe(true);
    expect(isClaudeArgv(['/Users/me/.local/bin/claude', '--resume'])).toBe(true);
    expect(isClaudeArgv(['node', '/usr/local/bin/claude'])).toBe(true);
    expect(isClaudeArgv(['node', '/x/@anthropic-ai/claude-code/cli.js'])).toBe(true);
    expect(isClaudeArgv(['/Applications/Claude.app/Contents/MacOS/Claude'])).toBe(false);
    expect(isClaudeArgv(['node', '/x/claude-live-viewer/dist/cli.mjs'])).toBe(false);
    expect(isClaudeArgv(['/bin/zsh'])).toBe(false);
  });

  it('processTree has us, our ancestors and our descendants only', () => {
    const tree = processTree(parsePsOutput(PS), 900);
    expect([...tree].sort((a, b) => a - b)).toEqual([0, 1, 500, 800, 900, 901].filter((p) => p !== 0));
  });

  it('isInside compares real paths', () => {
    expect(isInside('/private/tmp/repo/src', '/tmp/repo', fakeRealpath)).toBe(true);
    expect(isInside('/tmp/repo', '/private/tmp/repo', fakeRealpath)).toBe(true);
    expect(isInside('/private/tmp/repo-other', '/tmp/repo', fakeRealpath)).toBe(false);
    expect(isInside('/private/tmp', '/tmp/repo', fakeRealpath)).toBe(false);
  });
});

describe('sessionsInRepo', () => {
  it('finds sessions inside the repo, excluding our tree and paths outside it', () => {
    const procs = parsePsOutput(PS);
    const found = sessionsInRepo(procs, parseLsofCwd(LSOF), '/tmp/repo', processTree(procs, 900), fakeRealpath);
    // 500: our ancestor. 610: sibling dir. 630: elsewhere. 640: parent dir. 700: desktop app.
    expect(found.map((s) => s.pid)).toEqual([600, 620]);
  });

  it('follows a symlinked repo path on the real file system', () => {
    const base = tmp('rs-sess-');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const link = path.join(base, 'link');
    fs.symlinkSync(repo, link);
    const procs = [{ pid: 42, ppid: 1, argv: ['claude'] }];
    const cwds = new Map([[42, path.join(repo, 'src')]]);
    expect(sessionsInRepo(procs, cwds, link, new Set())).toEqual([{ pid: 42, cwd: path.join(repo, 'src') }]);
    expect(sessionsInRepo(procs, cwds, link, new Set([42]))).toEqual([]);
  });
});

describe('findClaudeSessions', () => {
  it('darwin: ps picks the candidates and lsof is asked only about them', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ps') return PS;
      if (cmd === 'lsof') return LSOF;
      return undefined;
    };
    const found = await findClaudeSessions('/tmp/repo', { platform: 'darwin', run, selfPid: 900, realpath: fakeRealpath });
    expect(found?.map((s) => s.pid)).toEqual([600, 620]);
    expect(calls[0]).toEqual(['ps', '-axo', 'pid=,ppid=,args=']);
    const lsof = calls[1] ?? [];
    expect(lsof.slice(0, 4)).toEqual(['lsof', '-nP', '-a', '-p']);
    expect((lsof[4] ?? '').split(',').map(Number).sort((a, b) => a - b)).toEqual([600, 610, 620, 630, 640]);
    expect(lsof.slice(5)).toEqual(['-d', 'cwd', '-Fpn']);
  });

  it('darwin: no ps or no lsof means unknown, and no candidates skips lsof', async () => {
    expect(await findClaudeSessions('/r', { platform: 'darwin', run: async () => undefined })).toBeUndefined();
    expect(await findClaudeSessions('/r', { platform: 'darwin', run: async (cmd) => (cmd === 'ps' ? PS : undefined), selfPid: 900 })).toBeUndefined();
    const calls: string[] = [];
    const none = await findClaudeSessions('/r', {
      platform: 'darwin',
      run: async (cmd) => {
        calls.push(cmd);
        return '  1 0 /sbin/launchd\n';
      },
    });
    expect(none).toEqual([]);
    expect(calls).toEqual(['ps']);
  });

  it('linux: reads /proc (stat, cmdline, cwd)', async () => {
    const base = tmp('rs-sess-l-');
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    const proc = path.join(base, 'proc');
    const mk = (pid: number, ppid: number, argv: string[], cwd: string) => {
      const d = path.join(proc, String(pid));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'stat'), `${pid} (we ird) name) S ${ppid} 1 1 0\n`);
      fs.writeFileSync(path.join(d, 'cmdline'), argv.join('\0') + '\0');
      fs.writeFileSync(path.join(d, 'comm'), path.basename(argv[0] ?? '') + '\n');
      fs.symlinkSync(cwd, path.join(d, 'cwd'));
    };
    mk(10, 1, ['claude'], path.join(repo, 'pkg'));
    mk(11, 1, ['/home/u/.local/bin/claude', '-c'], base); // outside
    mk(12, 1, ['bash'], repo); // not claude
    mk(13, 1, ['claude'], repo); // our parent
    mk(14, 13, ['node', '/x/dist/cli.mjs'], repo); // us
    fs.mkdirSync(path.join(proc, 'self'));
    const found = await findClaudeSessions(repo, { platform: 'linux', procDir: proc, selfPid: 14 });
    expect(found).toEqual([{ pid: 10, cwd: path.join(repo, 'pkg') }]);
    expect(await findClaudeSessions(repo, { platform: 'linux', procDir: path.join(base, 'nope') })).toBeUndefined();
  });

  it('other platforms: unknown', async () => {
    expect(await findClaudeSessions('/r', { platform: 'win32' })).toBeUndefined();
  });
});

describe('sessionWarning', () => {
  it('is empty without sessions and neutral Spanish otherwise', () => {
    expect(sessionWarning([])).toEqual([]);
    const one = sessionWarning([{ pid: 7, cwd: '/r' }]).join('\n');
    expect(one).toContain('Hay 1 sesión de Claude Code abierta en este repositorio (PID 7).');
    // Verified with Claude Code 2.1.288: an open session picks up the hooks live.
    expect(one).toContain('Toma los hooks en vivo, sin reiniciar (verificado con Claude Code 2.1.288).');
    expect(one).toContain('Si con una versión anterior no ves eventos, reiniciala: /exit y después claude --continue.');
    expect(one).not.toContain('Puede que no lea');
    const two = sessionWarning([
      { pid: 7, cwd: '/r' },
      { pid: 9, cwd: '/r/a' },
    ]).join('\n');
    expect(two).toContain('Hay 2 sesiones de Claude Code abiertas en este repositorio (PID 7, 9).');
    expect(two).toContain('Toman los hooks en vivo, sin reiniciar');
    expect(two).toContain('Si con una versión anterior no ves eventos, reinicialas: /exit y después claude --continue en cada una.');
    expect(two).not.toContain('reiniciala:');
    expect(two).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('startHint', () => {
  it('says open sessions pick up the hooks live and keeps the restart only as a fallback', () => {
    expect(startHint([])).toEqual(['Abrí Claude Code en este repositorio.']);
    expect(startHint([{ pid: 7, cwd: '/r' }])).toEqual(sessionWarning([{ pid: 7, cwd: '/r' }]));
    const unknown = startHint(undefined).join('\n');
    expect(unknown).toContain('Abrí Claude Code en este repositorio.');
    expect(unknown).toContain('toma los hooks en vivo (verificado con Claude Code 2.1.288)');
    expect(unknown).toContain('Si con una versión anterior no ves eventos, reiniciala');
    expect(unknown).not.toMatch(/[\u2013\u2014]/);
  });
});
