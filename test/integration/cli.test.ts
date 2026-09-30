// Runs the built CLI (dist/cli.mjs) as a child process.
// `npm test` builds first; when run alone, beforeAll rebuilds dist/cli.mjs with
// tsdown if it is missing or older than any file under src/.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, hookUrl, isOwnHook } from '../../src/install/settings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist', 'cli.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'payloads', 'run1.jsonl');

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
let xdgDir: string;

function tmp(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function newestMtime(dir: string): number {
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    max = Math.max(max, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return max;
}

beforeAll(() => {
  const built = fs.statSync(CLI, { throwIfNoEntry: false });
  if (!built || built.mtimeMs < newestMtime(path.join(ROOT, 'src'))) {
    execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsdown'), [], { cwd: ROOT, stdio: 'ignore' });
  }
  xdgDir = tmp('rs-cli-xdg-');
}, 120_000);

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function gitRepo(): string {
  const repo = tmp('rs-cli-repo-');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface Run {
  child: ChildProcess;
  output(): string;
  waitFor(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function run(args: string[], cfgDir: string): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: cfgDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    XDG_CONFIG_HOME: xdgDir,
  };
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let buf = '';
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    for (const l of listeners) l();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const l of listeners) l();
      resolve({ code, signal });
    });
  });
  return {
    child,
    output: () => buf,
    exited,
    waitFor(re, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = buf.match(re);
          if (m) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(m);
          } else if (child.exitCode !== null) {
            listeners.delete(check);
            clearTimeout(timer);
            reject(new Error(`process exited before ${re}; output:\n${buf}`));
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timeout waiting for ${re}; output:\n${buf}`));
        }, ms);
        listeners.add(check);
        check();
      });
    },
  };
}

function firstFixture(repo: string): string {
  const line = fs.readFileSync(FIXTURE, 'utf8').split('\n').find((l) => l.trim() !== '');
  return (line ?? '{}').replaceAll('__REPO__', repo).replaceAll('__HOME__', '/Users/fake-home');
}

function ownUrls(file: string): Array<{ event: string; url: string }> {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks: unknown[] }>> };
  const out: Array<{ event: string; url: string }> = [];
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks) if (isOwnHook(h)) out.push({ event, url: (h as { url: string }).url });
  }
  return out;
}

const READY = /escuchando en http:\/\/127\.0\.0\.1:(\d+)/;

describe('repo-synapse CLI (dist/cli.mjs)', () => {
  it('has a shebang and prints --version / --help', () => {
    expect(fs.readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
    expect(execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })).toContain('Uso:');
  });

  it('start installs hooks with the real port, answers 204 and cleans up on SIGINT', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const port = await freePort();
    const r = run(['start', repo, '--no-open', '--port', String(port), '--no-bash-diff'], cfg);
    const m = await r.waitFor(READY);
    const actual = Number(m[1]);
    expect(actual).toBe(port);

    const settings = path.join(repo, '.claude', 'settings.local.json');
    const own = ownUrls(settings);
    expect(own.map((o) => o.event).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(own.every((o) => o.url === hookUrl(actual))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'lock'))).toBe(true);
    expect(fs.existsSync(path.join(cfg, 'settings.json'))).toBe(false);

    const res = await fetch(hookUrl(actual), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: firstFixture(repo),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    r.child.kill('SIGINT');
    const { code } = await r.exited;
    expect(code).toBe(0);
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'lock'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'install.json'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.repo-synapse/');
  });

  it('start with bash diff toggles the user setting and restores both files byte for byte', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const userFile = path.join(cfg, 'settings.json');
    const userOriginal = '{\n\t"theme": "light",\n\t"model": "opus"\n}';
    fs.writeFileSync(userFile, userOriginal);
    const localFile = path.join(repo, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(localFile));
    const localOriginal = '{ "permissions": { "allow": [ "Bash(ls:*)" ] } }';
    fs.writeFileSync(localFile, localOriginal);

    const r = run(['start', repo, '--no-open', '--port', '0'], cfg);
    const m = await r.waitFor(READY);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf8'))).toEqual({ theme: 'light', model: 'opus', bashEditDiffEnabled: true });
    expect(ownUrls(localFile).every((o) => o.url === hookUrl(Number(m[1])))).toBe(true);

    r.child.kill('SIGTERM');
    const { code } = await r.exited;
    expect(code).toBe(0);
    expect(fs.readFileSync(userFile, 'utf8')).toBe(userOriginal);
    expect(fs.readFileSync(localFile, 'utf8')).toBe(localOriginal);
  });

  it('start --no-install keeps .repo-synapse/ out of git', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-install'], cfg);
    await r.waitFor(READY);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'events.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.repo-synapse/');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status).not.toContain('.repo-synapse');
    r.child.kill('SIGINT');
    expect((await r.exited).code).toBe(0);
  });

  it('a read-only .git/info/exclude does not abort start nor leave hooks behind', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    fs.chmodSync(exclude, 0o444);
    try {
      const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
      await r.waitFor(READY);
      expect(r.output()).toContain('.git/info/exclude');
      expect(ownUrls(path.join(repo, '.claude', 'settings.local.json'))).toHaveLength(HOOK_EVENTS.length);
      r.child.kill('SIGINT');
      expect((await r.exited).code).toBe(0);
      expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.repo-synapse', 'install.json'))).toBe(false);
    } finally {
      fs.chmodSync(exclude, 0o644);
    }
  });

  it('an install that throws after writing the manifest is undone on exit', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const claudeDir = path.join(repo, '.claude');
    fs.mkdirSync(claudeDir);
    const localFile = path.join(claudeDir, 'settings.local.json');
    fs.writeFileSync(localFile, '{"a":1}');
    fs.chmodSync(claudeDir, 0o555); // the atomic write of settings.local.json fails
    try {
      const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
      const { code } = await r.exited;
      expect(code).toBe(1);
      expect(r.output()).toContain('No se pudo arrancar');
    } finally {
      fs.chmodSync(claudeDir, 0o755);
    }
    expect(fs.readFileSync(localFile, 'utf8')).toBe('{"a":1}');
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'install.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'lock'))).toBe(false);
  });

  it('an unwritable user config dir skips bash diff instead of aborting start', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const userFile = path.join(cfg, 'settings.json');
    fs.writeFileSync(userFile, '{"a":1}');
    fs.chmodSync(cfg, 0o555);
    try {
      const r = run(['start', repo, '--no-open', '--port', '0'], cfg);
      await r.waitFor(READY);
      expect(r.output()).toContain('No se pudo activar bashEditDiffEnabled');
      r.child.kill('SIGTERM');
      expect((await r.exited).code).toBe(0);
    } finally {
      fs.chmodSync(cfg, 0o755);
    }
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(cfg)).toEqual(['settings.json']);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'user-settings.bak'))).toBe(false);
  });

  it('two viewers on different repos share bashEditDiffEnabled until the last one exits', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const userFile = path.join(cfg, 'settings.json');
    fs.writeFileSync(userFile, '{"a":1}');
    const ra = run(['start', a, '--no-open', '--port', '0'], cfg);
    await ra.waitFor(READY);
    const rb = run(['start', b, '--no-open', '--port', '0'], cfg);
    await rb.waitFor(READY);
    expect(rb.output()).toContain('otro visor');
    ra.child.kill('SIGINT');
    expect((await ra.exited).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf8'))).toEqual({ a: 1, bashEditDiffEnabled: true });
    rb.child.kill('SIGINT');
    expect((await rb.exited).code).toBe(0);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(cfg)).toEqual(['settings.json']);
  });

  it('refuses a second start on the same repo and takes over a stale lock', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const first = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    await first.waitFor(READY);
    const second = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const res = await second.exited;
    expect(res.code).toBe(1);
    expect(second.output()).toContain('Ya hay un repo-synapse corriendo');
    first.child.kill('SIGINT');
    expect((await first.exited).code).toBe(0);

    // Stale lock + leftovers of a crashed run.
    fs.writeFileSync(path.join(repo, '.repo-synapse', 'lock'), JSON.stringify({ pid: 2 ** 22 + 4321 }));
    execFileSync(process.execPath, [CLI, 'install', repo, '--port', '7'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: xdgDir },
    });
    const third = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const m = await third.waitFor(READY);
    expect(third.output()).toContain('lock viejo');
    const own = ownUrls(path.join(repo, '.claude', 'settings.local.json'));
    expect(own).toHaveLength(HOOK_EVENTS.length);
    expect(own.every((o) => o.url === hookUrl(Number(m[1])))).toBe(true);
    third.child.kill('SIGINT');
    expect((await third.exited).code).toBe(0);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('a lock whose PID was reused by an unrelated process is stale for start and doctor (F7)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    // A live process that started long after the lock was written cannot be its owner.
    const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.push(squatter);
    fs.mkdirSync(path.join(repo, '.repo-synapse'));
    const lockFile = path.join(repo, '.repo-synapse', 'lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: squatter.pid, startedAt: '2001-01-01T00:00:00.000Z' }) + '\n');

    const doctor = run(['doctor', repo], cfg);
    expect((await doctor.exited).code).toBe(0);
    expect(doctor.output()).toContain('lock viejo');
    expect(doctor.output()).not.toContain('está corriendo sobre este repo');

    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    await r.waitFor(READY);
    expect(r.output()).toContain('lock viejo');
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(r.child.pid);
    r.child.kill('SIGINT');
    expect((await r.exited).code).toBe(0);
    expect(fs.readdirSync(path.join(repo, '.repo-synapse')).filter((f) => f.startsWith('lock'))).toEqual([]);
  });

  it('the refusal of a live lock says how to recover (F7)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const first = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    await first.waitFor(READY);
    const second = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    expect((await second.exited).code).toBe(1);
    expect(second.output()).toContain('Ya hay un repo-synapse corriendo');
    expect(second.output()).toContain(`borrá ${path.join(repo, '.repo-synapse', 'lock')}`);
    first.child.kill('SIGINT');
    expect((await first.exited).code).toBe(0);
  });

  it('several starts racing on a stale lock: exactly one takes it over (F8)', async () => {
    for (let round = 0; round < 3; round++) {
      const repo = gitRepo();
      const cfg = tmp('rs-cli-cfg-');
      fs.mkdirSync(path.join(repo, '.repo-synapse'));
      const lockFile = path.join(repo, '.repo-synapse', 'lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 4321, startedAt: '2001-01-01T00:00:00.000Z' }));
      const racers = [0, 1, 2, 3, 4].map(() => run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg));
      const settled = await Promise.all(
        racers.map((r) =>
          r.waitFor(READY, 15_000).then(
            () => 'ready' as const,
            () => 'exited' as const,
          ),
        ),
      );
      const winners = racers.filter((_, i) => settled[i] === 'ready');
      const losers = racers.filter((_, i) => settled[i] === 'exited');
      expect(winners).toHaveLength(1);
      for (const l of losers) {
        expect((await l.exited).code).toBe(1);
        expect(l.output()).toMatch(/Ya hay un repo-synapse corriendo|otro repo-synapse está arrancando/);
      }
      const winner = winners[0]!;
      expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(winner.child.pid);
      const port = Number(winner.output().match(READY)![1]);
      expect(ownUrls(path.join(repo, '.claude', 'settings.local.json')).every((o) => o.url === hookUrl(port))).toBe(true);
      winner.child.kill('SIGINT');
      expect((await winner.exited).code).toBe(0);
      expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
      expect(fs.readdirSync(path.join(repo, '.repo-synapse')).filter((f) => f.startsWith('lock'))).toEqual([]);
    }
  }, 60_000);

  it('install refuses while a start is live and leaves its hooks alone (F9)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff'], cfg);
    const port = Number((await r.waitFor(READY))[1]);
    const settings = path.join(repo, '.claude', 'settings.local.json');
    const before = fs.readFileSync(settings, 'utf8');
    const manifest = path.join(repo, '.repo-synapse', 'install.json');
    const manifestBefore = fs.readFileSync(manifest, 'utf8');

    const inst = run(['install', repo, '--port', '7'], cfg);
    expect((await inst.exited).code).toBe(1);
    expect(inst.output()).toContain('repo-synapse está corriendo');
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
    expect(fs.readFileSync(manifest, 'utf8')).toBe(manifestBefore);
    expect(ownUrls(settings).every((o) => o.url === hookUrl(port))).toBe(true);

    r.child.kill('SIGINT');
    expect((await r.exited).code).toBe(0);
  });

  // Regression (F9 follow-up): with a live `start --no-install`, install refused and claimed
  // that hooks were installed when there were none.
  it('install works while a start --no-install is live (it installed nothing)', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['start', repo, '--no-open', '--port', '0', '--no-bash-diff', '--no-install'], cfg);
    await r.waitFor(READY);
    const inst = run(['install', repo, '--port', '7'], cfg);
    expect((await inst.exited).code).toBe(0);
    const settings = path.join(repo, '.claude', 'settings.local.json');
    expect(ownUrls(settings).length).toBeGreaterThan(0);
    expect(ownUrls(settings).every((o) => o.url === hookUrl(7))).toBe(true);
    r.child.kill('SIGINT');
    expect((await r.exited).code).toBe(0);
    // The hooks were installed by hand, so they outlive the viewer.
    expect(ownUrls(settings).every((o) => o.url === hookUrl(7))).toBe(true);
    const un = run(['uninstall', repo], cfg);
    expect((await un.exited).code).toBe(0);
  });

  it('install and uninstall work as manual commands', () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: '/dev/null', XDG_CONFIG_HOME: xdgDir };
    execFileSync(process.execPath, [CLI, 'install', repo, '--port', '7801'], { env });
    expect(ownUrls(path.join(repo, '.claude', 'settings.local.json')).every((o) => o.url === hookUrl(7801))).toBe(true);
    const out = execFileSync(process.execPath, [CLI, 'uninstall', repo], { env, encoding: 'utf8' });
    expect(out).toContain('Hooks quitados');
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('doctor runs and exits 0', async () => {
    const repo = gitRepo();
    const cfg = tmp('rs-cli-cfg-');
    const r = run(['doctor', repo], cfg);
    const { code } = await r.exited;
    expect(code).toBe(0);
    expect(r.output()).toContain('diagnóstico');
    expect(r.output()).toContain('Node');
  });

  it('fails with a Spanish message for a missing repo', async () => {
    const r = run(['start', path.join(os.tmpdir(), 'rs-does-not-exist-xyz'), '--no-open'], tmp('rs-cli-cfg-'));
    const { code } = await r.exited;
    expect(code).toBe(1);
    expect(r.output()).toContain('No existe el directorio');
  });
});
