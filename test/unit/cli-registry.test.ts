// Repo root resolution, the viewer registry and stopViewer's signal rules.
// NEURONS_HOME points at a temp dir for the whole file.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stopViewer, type StopDeps } from '../../src/cli/control.ts';
import { CliError } from '../../src/cli/output.ts';
import {
  isEntryLive,
  isNeuronsViewer,
  listViewers,
  neuronsHome,
  removeViewerEntry,
  viewerForRepo,
  viewerFromLock,
  viewersDir,
  writeViewerEntry,
} from '../../src/cli/registry.ts';
import { resolveRepoRoot } from '../../src/cli/repo-root.ts';
import { processCommand } from '../../src/install/settings.ts';
import { detectLang, setLang } from '../../src/i18n.ts';

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
let savedHome: string | undefined;

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  savedHome = process.env.NEURONS_HOME;
  process.env.NEURONS_HOME = tmp('rs-reg-home-');
});

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  fs.rmSync(viewersDir(), { recursive: true, force: true });
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.NEURONS_HOME;
  else process.env.NEURONS_HOME = savedHome;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A live process we own that is not a Neurons viewer. */
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

/** A PID that is not running. */
function deadPid(): number {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  return pid;
}

describe('resolveRepoRoot', () => {
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };

  it('moves a subdirectory up to the git top level (real paths)', () => {
    const repo = tmp('rs-root-');
    execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv });
    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveRepoRoot(sub)).toEqual({ root: repo, given: sub, isGit: true });
    expect(resolveRepoRoot(repo)).toEqual({ root: repo, given: repo, isGit: true });
  });

  it('resolves a symlink to the repo to its real path', () => {
    const repo = tmp('rs-root-l-');
    execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv });
    fs.mkdirSync(path.join(repo, 'src'));
    const link = path.join(tmp('rs-root-ln-'), 'link');
    fs.symlinkSync(repo, link);
    expect(resolveRepoRoot(path.join(link, 'src'))).toEqual({ root: repo, given: path.join(repo, 'src'), isGit: true });
  });

  it('a directory outside git is used as is', () => {
    const dir = tmp('rs-root-ng-');
    fs.mkdirSync(path.join(dir, 'x'));
    // An injected git lookup: os.tmpdir() could sit inside some repo on a dev machine.
    expect(resolveRepoRoot(path.join(dir, 'x'), () => undefined)).toEqual({ root: path.join(dir, 'x'), given: path.join(dir, 'x'), isGit: false });
  });

  it('fails in the CLI language for a missing directory or a file', () => {
    const dir = tmp('rs-root-f-');
    try {
      setLang('es');
      expect(() => resolveRepoRoot(path.join(dir, 'nope'))).toThrow(CliError);
      expect(() => resolveRepoRoot(path.join(dir, 'nope'))).toThrow(/No existe el directorio/);
      fs.writeFileSync(path.join(dir, 'file'), 'x');
      expect(() => resolveRepoRoot(path.join(dir, 'file'))).toThrow(/no es un directorio/);
      setLang('en');
      expect(() => resolveRepoRoot(path.join(dir, 'nope'))).toThrow(/The directory .* does not exist/);
      expect(() => resolveRepoRoot(path.join(dir, 'file'))).toThrow(/is not a directory/);
    } finally {
      setLang(detectLang());
    }
  });
});

describe('viewer registry', () => {
  it('lives under NEURONS_HOME/viewers', () => {
    expect(viewersDir()).toBe(path.join(neuronsHome(), 'viewers'));
    expect(neuronsHome()).toBe(process.env.NEURONS_HOME);
  });

  it('writes, lists and removes this process entry', () => {
    const file = writeViewerEntry({ repo: '/r/one', port: 7777, url: 'http://127.0.0.1:7777' });
    expect(file).toBe(path.join(viewersDir(), `${process.pid}.json`));
    const e = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(e).sort()).toEqual(['cmd', 'command', 'pid', 'port', 'repo', 'startedAt', 'url']);
    // Its own `ps` line, matched exactly before any signal.
    expect(e.command).toBe(processCommand(process.pid));
    expect(e.pid).toBe(process.pid);
    expect(listViewers().map((v) => v.repo)).toEqual(['/r/one']);
    expect(viewerForRepo('/r/one')?.port).toBe(7777);
    expect(viewerForRepo('/r/two')).toBeUndefined();
    removeViewerEntry();
    expect(listViewers()).toEqual([]);
  });

  it('prunes dead PIDs, reused PIDs, corrupt files and mismatched names on read', () => {
    const dead = deadPid();
    writeViewerEntry({ pid: dead, repo: '/r/dead', port: 1, url: 'http://127.0.0.1:1', cmd: '/x/dist/cli.mjs' });
    // A live process that started after the entry and does not run its script: a reused PID.
    const k = sleeper();
    const old = new Date(Date.now() - 3600_000).toISOString();
    writeViewerEntry({ pid: k.pid!, repo: '/r/reused', port: 2, url: 'http://127.0.0.1:2', startedAt: old, cmd: '/nowhere/dist/cli.mjs' });
    fs.writeFileSync(path.join(viewersDir(), '123.json'), '{not json');
    fs.writeFileSync(path.join(viewersDir(), '456.json'), JSON.stringify({ pid: process.pid, repo: '/r/x', port: 3, url: 'u', startedAt: old, cmd: 'c' }));
    fs.writeFileSync(path.join(viewersDir(), 'README'), 'not an entry');
    writeViewerEntry({ repo: '/r/me', port: 4, url: 'http://127.0.0.1:4' });

    expect(listViewers({ prune: false }).map((v) => v.repo)).toEqual(['/r/me']);
    expect(fs.readdirSync(viewersDir()).sort()).toHaveLength(6);
    expect(listViewers().map((v) => v.repo)).toEqual(['/r/me']);
    expect(fs.readdirSync(viewersDir()).sort()).toEqual([`${process.pid}.json`, 'README']);
  });

  it('a missing registry dir lists nothing', () => {
    expect(listViewers()).toEqual([]);
  });

  it('isNeuronsViewer requires a live PID running the entry script, never ourselves', () => {
    const k = sleeper();
    expect(isNeuronsViewer({ pid: k.pid!, cmd: '/nowhere/dist/cli.mjs' })).toBe(false);
    expect(isNeuronsViewer({ pid: k.pid!, cmd: '' })).toBe(false);
    // The sleeper's command line is "<node> -e setTimeout(...)": it runs "-e".
    expect(isNeuronsViewer({ pid: k.pid!, cmd: process.execPath })).toBe(true);
    expect(isNeuronsViewer({ pid: process.pid, cmd: process.argv[1] ?? 'x' })).toBe(false);
    expect(isNeuronsViewer({ pid: deadPid(), cmd: process.execPath })).toBe(false);
    expect(isEntryLive({ pid: k.pid!, repo: '/r', port: 1, url: 'u', startedAt: new Date().toISOString(), cmd: '/nowhere' })).toBe(true);
  });

  it('isNeuronsViewer refuses a process that started after the record (a reused PID), even running the same script', async () => {
    const k = sleeper();
    await new Promise((r) => setTimeout(r, 100));
    const recent = new Date(Date.now() + 1000).toISOString();
    expect(isNeuronsViewer({ pid: k.pid!, cmd: process.execPath, startedAt: recent })).toBe(true);
    expect(isNeuronsViewer({ pid: k.pid!, cmd: process.execPath, startedAt: '2020-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('isNeuronsViewer matches a recorded command line exactly, whatever argv[1] says (relative launches)', () => {
    const k = sleeper();
    const line = processCommand(k.pid!);
    expect(line).toBeDefined();
    // argv[1] is absolute, but `ps` shows the script as it was typed.
    expect(isNeuronsViewer({ pid: k.pid!, cmd: '/abs/path/src/cli.ts', command: line })).toBe(true);
    expect(isNeuronsViewer({ pid: k.pid!, cmd: process.execPath, command: `${line} other` })).toBe(false);
  });

  // Regression (F1): the script path matched as a substring, so a reused PID running
  // /usr/local/bin/neutron passed as a viewer started through /usr/local/bin/neu.
  it('isNeuronsViewer and isEntryLive refuse a program whose path only starts with the script path', () => {
    const dir = tmp('rs-reg-bin-');
    for (const name of ['neutron', 'neural-cli']) {
      fs.writeFileSync(path.join(dir, name), 'setTimeout(() => {}, 60000);\n');
      const k = spawn(process.execPath, [path.join(dir, name), 'serve'], { stdio: 'ignore' });
      children.push(k);
      for (const bin of ['neu', 'neurons']) {
        const cmd = path.join(dir, bin);
        expect(isNeuronsViewer({ pid: k.pid!, cmd })).toBe(false);
        const old = '2020-01-01T00:00:00.000Z';
        expect(isEntryLive({ pid: k.pid!, repo: '/r', port: 1, url: 'u', startedAt: old, cmd })).toBe(false);
      }
    }
  });

  it('viewerFromLock reads a live lock that names its script', () => {
    const repo = tmp('rs-reg-lock-');
    fs.mkdirSync(path.join(repo, '.neurons'));
    const lock = path.join(repo, '.neurons', 'lock');
    expect(viewerFromLock(repo)).toBeUndefined();
    const k = sleeper();
    const now = new Date(Date.now() + 1000).toISOString();
    fs.writeFileSync(lock, JSON.stringify({ pid: k.pid, startedAt: now, cmd: '/x/dist/cli.mjs' }));
    expect(viewerFromLock(repo)).toEqual({ pid: k.pid, startedAt: now, cmd: '/x/dist/cli.mjs' });
    fs.writeFileSync(lock, JSON.stringify({ pid: k.pid, startedAt: now }));
    expect(viewerFromLock(repo)).toBeUndefined();
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid(), startedAt: now, cmd: '/x/dist/cli.mjs' }));
    expect(viewerFromLock(repo)).toBeUndefined();
  });

  // Regression (F2): a stale lock whose PID another viewer reused named that viewer.
  it('viewerFromLock refuses a PID that started after the lock, or that the registry lists for another repo', () => {
    const repo = tmp('rs-reg-lock2-');
    fs.mkdirSync(path.join(repo, '.neurons'));
    const lock = path.join(repo, '.neurons', 'lock');
    const k = sleeper();
    // Its command line runs the lock's script, but it started long after the lock.
    fs.writeFileSync(lock, JSON.stringify({ pid: k.pid, startedAt: '2020-01-01T00:00:00.000Z', cmd: process.execPath }));
    expect(viewerFromLock(repo)).toBeUndefined();
    const now = new Date(Date.now() + 1000).toISOString();
    fs.writeFileSync(lock, JSON.stringify({ pid: k.pid, startedAt: now, cmd: process.execPath, command: 'x' }));
    expect(viewerFromLock(repo)).toEqual({ pid: k.pid, startedAt: now, cmd: process.execPath, command: 'x' });
    writeViewerEntry({ pid: k.pid!, repo: '/r/other', port: 1, url: 'u', startedAt: now, cmd: process.execPath });
    expect(viewerFromLock(repo)).toBeUndefined();
  });
});

describe('stopViewer', () => {
  function fakeDeps(o: { viewer: boolean | (() => boolean); exitOn?: NodeJS.Signals | 'never' }) {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const deps: StopDeps = {
      isViewer: () => (typeof o.viewer === 'function' ? o.viewer() : o.viewer),
      isAlive: () => alive,
      kill: (_pid, s) => {
        signals.push(s);
        if (o.exitOn === s || s === 'SIGKILL') alive = false;
      },
      sleep: async () => {},
    };
    return { deps, signals };
  }

  it('never signals a PID that is not a viewer', async () => {
    const { deps, signals } = fakeDeps({ viewer: false });
    expect(await stopViewer({ pid: 1, cmd: 'c' }, { force: true }, deps)).toEqual({ status: 'not-viewer' });
    expect(signals).toEqual([]);
  });

  it('SIGTERM and wait; a viewer that exits is stopped', async () => {
    const { deps, signals } = fakeDeps({ viewer: true, exitOn: 'SIGTERM' });
    expect(await stopViewer({ pid: 1, cmd: 'c' }, {}, deps)).toEqual({ status: 'stopped' });
    expect(signals).toEqual(['SIGTERM']);
  });

  it('without --force a viewer that does not exit is left alone', async () => {
    const { deps, signals } = fakeDeps({ viewer: true, exitOn: 'never' });
    expect(await stopViewer({ pid: 1, cmd: 'c' }, { timeoutMs: 0 }, deps)).toEqual({ status: 'timeout' });
    expect(signals).toEqual(['SIGTERM']);
  });

  it('--force sends SIGKILL after the wait, re-checking the identity first', async () => {
    const { deps, signals } = fakeDeps({ viewer: true, exitOn: 'never' });
    expect(await stopViewer({ pid: 1, cmd: 'c' }, { timeoutMs: 0, force: true }, deps)).toEqual({ status: 'killed' });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

    let checks = 0;
    const second = fakeDeps({ viewer: () => ++checks === 1, exitOn: 'never' });
    expect(await stopViewer({ pid: 1, cmd: 'c' }, { timeoutMs: 0, force: true }, second.deps)).toEqual({ status: 'not-viewer' });
    expect(second.signals).toEqual(['SIGTERM']);
  });

  it('a real non-viewer process is not signaled', async () => {
    const k = sleeper();
    expect(await stopViewer({ pid: k.pid!, cmd: '/nowhere/dist/cli.mjs' }, { force: true, timeoutMs: 0 })).toEqual({ status: 'not-viewer' });
    expect(k.exitCode).toBeNull();
    expect(k.signalCode).toBeNull();
  });
});
