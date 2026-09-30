import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_EVENTS,
  checkEnvironmentSync,
  bashDiffStateDir,
  enableBashEditDiff,
  ensureGitExcluded,
  installHooksSync,
  readBashDiffState,
  hookUrl,
  installHooks,
  isOwnHook,
  mergeHooks,
  noProxyCovers,
  readManifest,
  removeOwnHooks,
  restoreBashEditDiff,
  uninstallHooks,
  updateManifest,
  urlPatternMatches,
  userSettingsPath,
} from '../../src/install/settings.ts';

const tmpDirs: string[] = [];
let cfgDir: string;
const savedEnv: Record<string, string | undefined> = {};

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  for (const k of ['CLAUDE_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    savedEnv[k] = process.env[k];
  }
  // Never touch the real ~/.claude, and keep the user's global gitignore out of the tests.
  cfgDir = tmp('rs-inst-cfg-');
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.XDG_CONFIG_HOME = tmp('rs-inst-xdg-');
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(cfgDir, 'settings.json'), { force: true });
  fs.rmSync(path.join(cfgDir, 'repo-synapse'), { recursive: true, force: true });
});

/** A PID that does not exist (a crashed run). */
const DEAD_PID = 2 ** 22 + 777;

function gitRepo(): string {
  const repo = tmp('rs-inst-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return repo;
}

function localFile(repo: string): string {
  return path.join(repo, '.claude', 'settings.local.json');
}

function writeLocal(repo: string, text: string): void {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(localFile(repo), text);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

type Group = { matcher?: string; hooks: Array<Record<string, unknown>> };

function ownEntries(settings: unknown): Array<{ event: string; url: string }> {
  const out: Array<{ event: string; url: string }> = [];
  const hooks = (settings as { hooks?: Record<string, Group[]> }).hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const h of g.hooks) if (isOwnHook(h)) out.push({ event, url: String(h.url) });
  }
  return out;
}

/** Realistic settings with foreign hooks: Orca-style command hooks plus a foreign http hook. */
function foreignSettings(): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { allow: ['Bash(npm test:*)', 'Read(//tmp/**)'], deny: [] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '"$HOME/.orca/bin/orca-hook" pre-tool-use --worktree "$CLAUDE_PROJECT_DIR"', timeout: 5 }],
        },
        { matcher: 'Edit|Write', hooks: [{ type: 'http', url: 'http://127.0.0.1:9999/hook', timeout: 3 }] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: '"$HOME/.orca/bin/orca-hook" post-tool-use' }] }],
      Stop: [{ hooks: [{ type: 'command', command: '"$HOME/.orca/bin/orca-hook" stop', timeout: 10 }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo started' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'osascript -e "display notification \\"Claude\\""' }] }],
    },
    env: { FOO: 'bar' },
  };
}

// ---------------------------------------------------------------- pure functions

describe('hookUrl / isOwnHook', () => {
  it('builds the marked loopback URL', () => {
    expect(hookUrl(7777)).toBe('http://127.0.0.1:7777/hook?src=repo-synapse');
  });

  it('matches only the exact URL shape', () => {
    expect(isOwnHook({ type: 'http', url: hookUrl(1234) })).toBe(true);
    expect(isOwnHook({ type: 'http', url: 'http://127.0.0.1:7777/hook' })).toBe(false);
    expect(isOwnHook({ type: 'http', url: 'http://localhost:7777/hook?src=repo-synapse' })).toBe(false);
    expect(isOwnHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse&x=1' })).toBe(false);
    expect(isOwnHook({ type: 'command', url: hookUrl(7777) })).toBe(false);
    expect(isOwnHook({ type: 'command', command: 'curl http://127.0.0.1:7777/hook?src=repo-synapse' })).toBe(false);
    expect(isOwnHook(null)).toBe(false);
    expect(isOwnHook('http')).toBe(false);
  });
});

describe('mergeHooks', () => {
  it('adds one group per event without matcher and timeout 2', () => {
    const merged = mergeHooks({}, 7777) as { hooks: Record<string, Group[]> };
    expect(Object.keys(merged.hooks)).toEqual([...HOOK_EVENTS]);
    for (const e of HOOK_EVENTS) {
      expect(merged.hooks[e]).toEqual([{ hooks: [{ type: 'http', url: hookUrl(7777), timeout: 2 }] }]);
    }
  });

  it('preserves foreign hooks, keys and their order, and does not mutate the input', () => {
    const input = foreignSettings();
    const before = JSON.stringify(input);
    const merged = mergeHooks(input, 7777) as { hooks: Record<string, Group[]> } & Record<string, unknown>;
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(merged)).toEqual(['$schema', 'permissions', 'hooks', 'env']);
    // Existing events keep their position; new ones are appended.
    expect(Object.keys(merged.hooks).slice(0, 5)).toEqual(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'Notification']);
    const orig = foreignSettings().hooks as Record<string, Group[]>;
    expect(merged.hooks.PreToolUse?.slice(0, 2)).toEqual(orig.PreToolUse);
    expect(merged.hooks.PostToolUse?.slice(0, 1)).toEqual(orig.PostToolUse);
    expect(merged.hooks.SessionStart).toEqual(orig.SessionStart);
    expect(merged.hooks.Notification).toEqual(orig.Notification);
    expect(ownEntries(merged)).toHaveLength(HOOK_EVENTS.length);
    // Removing ours gives the input back.
    expect(removeOwnHooks(merged)).toEqual(foreignSettings());
  });

  it('is idempotent: re-merging with another port leaves one own entry per event', () => {
    const once = mergeHooks(foreignSettings(), 7777);
    const twice = mergeHooks(mergeHooks(once, 7778), 7779);
    const own = ownEntries(twice);
    expect(own).toHaveLength(HOOK_EVENTS.length);
    expect(new Set(own.map((o) => o.event)).size).toBe(HOOK_EVENTS.length);
    expect(own.every((o) => o.url === hookUrl(7779))).toBe(true);
    expect(removeOwnHooks(twice)).toEqual(foreignSettings());
  });

  it('refuses a malformed hooks value', () => {
    expect(() => mergeHooks({ hooks: [] }, 1)).toThrow();
    expect(() => mergeHooks({ hooks: { Stop: {} } }, 1)).toThrow();
  });
});

describe('removeOwnHooks', () => {
  it('does not remove the prefix-lookalike URL without the marker', () => {
    const lookalike = { type: 'http', url: 'http://127.0.0.1:7777/hook' };
    const s = { hooks: { Stop: [{ hooks: [lookalike, { type: 'http', url: hookUrl(7777) }] }] } };
    expect(removeOwnHooks(s)).toEqual({ hooks: { Stop: [{ hooks: [lookalike] }] } });
  });

  it('drops only containers that became empty because of us', () => {
    const s = {
      hooks: {
        Stop: [{ hooks: [{ type: 'http', url: hookUrl(1) }] }],
        PreCompact: [],
        PostCompact: [{ hooks: [] }],
      },
      other: 1,
    };
    expect(removeOwnHooks(s)).toEqual({ hooks: { PreCompact: [], PostCompact: [{ hooks: [] }] }, other: 1 });
    expect(removeOwnHooks({ hooks: { Stop: [{ hooks: [{ type: 'http', url: hookUrl(1) }] }] } })).toEqual({});
    expect(removeOwnHooks({ hooks: {} })).toEqual({ hooks: {} });
  });
});

// ---------------------------------------------------------------- install / uninstall on disk

describe('installHooks / uninstallHooks', () => {
  it('(a) restores the exact bytes of a pre-existing file with custom formatting', async () => {
    const repo = gitRepo();
    const original = '{\r\n\t"model":   "opus",\r\n\t"permissions": {"allow": ["Bash(ls:*)"]}\r\n}';
    writeLocal(repo, original);
    const r = await installHooks({ repoRoot: repo, port: 7777 });
    expect(r).toEqual({ settingsPath: localFile(repo), created: false });
    const installed = fs.readFileSync(localFile(repo), 'utf8');
    expect(installed.endsWith('}\n')).toBe(true);
    expect(installed).toContain('\n  "hooks": {');
    expect(ownEntries(JSON.parse(installed))).toHaveLength(HOOK_EVENTS.length);
    expect(fs.readFileSync(path.join(repo, '.repo-synapse', 'settings.local.json.bak'), 'utf8')).toBe(original);
    const m = readManifest(repo);
    expect(m).toMatchObject({ createdFile: false, createdClaudeDir: false, port: 7777 });
    expect(typeof m?.backedUpAt).toBe('string');

    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: true });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'install.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'settings.local.json.bak'))).toBe(false);
    // Idempotent.
    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: false });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
  });

  it('(b) removes the file and the .claude dir when neither existed', async () => {
    const repo = gitRepo();
    const r = await installHooks({ repoRoot: repo, port: 7777 });
    expect(r.created).toBe(true);
    expect(readManifest(repo)).toMatchObject({ createdFile: true, createdClaudeDir: true, backedUpAt: null });
    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: true });
    expect(fs.existsSync(localFile(repo))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: false });
  });

  it('(b2) keeps .claude when it existed or holds other files', async () => {
    const repo = gitRepo();
    fs.mkdirSync(path.join(repo, '.claude'));
    await installHooks({ repoRoot: repo, port: 7777 });
    await uninstallHooks({ repoRoot: repo });
    expect(fs.existsSync(localFile(repo))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(true);

    const repo2 = gitRepo();
    await installHooks({ repoRoot: repo2, port: 7777 });
    fs.writeFileSync(path.join(repo2, '.claude', 'settings.json'), '{}');
    await uninstallHooks({ repoRoot: repo2 });
    expect(fs.existsSync(path.join(repo2, '.claude', 'settings.json'))).toBe(true);
  });

  it('(c) restores bytes of a file with foreign hooks under the same events', async () => {
    const repo = gitRepo();
    const original = JSON.stringify(foreignSettings(), null, 4);
    writeLocal(repo, original);
    await installHooks({ repoRoot: repo, port: 7777 });
    const during = readJson(localFile(repo));
    const hooks = during.hooks as Record<string, Group[]>;
    expect(hooks.PreToolUse).toHaveLength(3);
    expect(hooks.PreToolUse?.[1]?.hooks[0]).toEqual({ type: 'http', url: 'http://127.0.0.1:9999/hook', timeout: 3 });
    expect(hooks.Stop).toHaveLength(2);
    await uninstallHooks({ repoRoot: repo });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
  });

  it('re-install with another port keeps one own entry per event and the first backup', async () => {
    const repo = gitRepo();
    const original = '{"model":"x"}';
    writeLocal(repo, original);
    await installHooks({ repoRoot: repo, port: 7777 });
    await installHooks({ repoRoot: repo, port: 7790 });
    const own = ownEntries(readJson(localFile(repo)));
    expect(own).toHaveLength(HOOK_EVENTS.length);
    expect(own.every((o) => o.url === hookUrl(7790))).toBe(true);
    expect(readManifest(repo)?.port).toBe(7790);
    await uninstallHooks({ repoRoot: repo });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
  });

  it('keeps changes made during the session and only removes our hooks', async () => {
    const repo = gitRepo();
    writeLocal(repo, '{"model":"x"}');
    await installHooks({ repoRoot: repo, port: 7777 });
    const cur = readJson(localFile(repo));
    cur.permissions = { allow: ['Bash(git status)'] };
    fs.writeFileSync(localFile(repo), JSON.stringify(cur));
    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: true });
    expect(readJson(localFile(repo))).toEqual({ model: 'x', permissions: { allow: ['Bash(git status)'] } });
  });

  it('does not remove a prefix-lookalike URL on disk', async () => {
    const repo = gitRepo();
    const lookalike = { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:7777/hook' }] }] } };
    const original = JSON.stringify(lookalike);
    writeLocal(repo, original);
    await installHooks({ repoRoot: repo, port: 7777 });
    const stop = (readJson(localFile(repo)).hooks as Record<string, Group[]>).Stop;
    expect(stop).toHaveLength(2);
    await uninstallHooks({ repoRoot: repo });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
  });

  it('aborts on invalid JSON without writing anything', async () => {
    const repo = gitRepo();
    const broken = '{ "model": "x", }';
    writeLocal(repo, broken);
    await expect(installHooks({ repoRoot: repo, port: 7777 })).rejects.toThrow(/JSON/);
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(broken);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'install.json'))).toBe(false);
    await expect(uninstallHooks({ repoRoot: repo })).rejects.toThrow(/JSON/);
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(broken);
  });

  it('adds entries to .git/info/exclude only when git does not ignore them', async () => {
    const repo = gitRepo();
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    const before = fs.readFileSync(exclude, 'utf8');
    await installHooks({ repoRoot: repo, port: 7777 });
    const after = fs.readFileSync(exclude, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('/.claude/settings.local.json\n');
    expect(after).toContain('/.repo-synapse/\n');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status).toBe('');
    // Second time nothing is appended.
    expect(ensureGitExcluded(repo)).toEqual([]);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(after);
    await uninstallHooks({ repoRoot: repo });
  });

  it('skips entries already ignored by .gitignore and non-git dirs', async () => {
    const repo = gitRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), '.repo-synapse/\n');
    expect(ensureGitExcluded(repo)).toEqual(['.claude/settings.local.json']);
    const plain = tmp('rs-inst-plain-');
    expect(ensureGitExcluded(plain)).toEqual([]);
    await installHooks({ repoRoot: plain, port: 7777 });
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
    await uninstallHooks({ repoRoot: plain });
    expect(fs.existsSync(path.join(plain, '.claude'))).toBe(false);
  });
});

// ---------------------------------------------------------------- bashEditDiffEnabled

describe('enable / restore bashEditDiffEnabled', () => {
  it('uses CLAUDE_CONFIG_DIR', () => {
    expect(userSettingsPath()).toBe(path.join(cfgDir, 'settings.json'));
  });

  it('turns it on and restores the exact bytes', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    const original = '{\n    "theme": "dark",\n    "hooks": {}\n}';
    fs.writeFileSync(file, original);
    const r = await enableBashEditDiff({ repoRoot: repo });
    expect(r).toMatchObject({ changed: true, previous: { present: false }, settingsPath: file });
    const during = readJson(file);
    expect(Object.keys(during)).toEqual(['theme', 'hooks', 'bashEditDiffEnabled']);
    expect(during.bashEditDiffEnabled).toBe(true);
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'user-settings.bak'))).toBe(false);
  });

  it('restores a previous false value', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    const original = '{"bashEditDiffEnabled":false,"a":1}';
    fs.writeFileSync(file, original);
    const r = await enableBashEditDiff({ repoRoot: repo });
    expect(r.previous).toEqual({ present: true, value: false });
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('keeps other changes made during the session', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');
    await enableBashEditDiff({ repoRoot: repo });
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), b: 2 }));
    await restoreBashEditDiff({ repoRoot: repo });
    expect(readJson(file)).toEqual({ a: 1, b: 2 });
  });

  it('does nothing when already true, when someone turned it off, or when the file is missing', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"bashEditDiffEnabled":true}');
    expect(await enableBashEditDiff({ repoRoot: repo })).toMatchObject({ changed: false, reason: 'already' });

    fs.writeFileSync(file, '{}');
    await enableBashEditDiff({ repoRoot: repo });
    fs.writeFileSync(file, '{"bashEditDiffEnabled":false}');
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"bashEditDiffEnabled":false}');

    fs.rmSync(file);
    expect(await enableBashEditDiff({ repoRoot: repo })).toMatchObject({ changed: false, reason: 'missing' });
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves invalid JSON untouched', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{oops');
    expect(await enableBashEditDiff({ repoRoot: repo })).toMatchObject({ changed: false, reason: 'invalid' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{oops');
  });

  it('writes through a symlinked settings file', async () => {
    const repo = gitRepo();
    const real = path.join(tmp('rs-inst-dot-'), 'settings.json');
    fs.writeFileSync(real, '{"a":1}');
    const link = path.join(cfgDir, 'settings.json');
    fs.symlinkSync(real, link);
    await enableBashEditDiff({ repoRoot: repo });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readJson(real).bashEditDiffEnabled).toBe(true);
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.readFileSync(real, 'utf8')).toBe('{"a":1}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('keeps the backup of the user settings outside the repo, mode 0600', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    const original = '{"env":{"GITHUB_TOKEN":"ghp_secret_value"}}';
    fs.writeFileSync(file, original, { mode: 0o600 });
    await enableBashEditDiff({ repoRoot: repo });
    const inRepo = fs.existsSync(path.join(repo, '.repo-synapse'))
      ? fs.readdirSync(path.join(repo, '.repo-synapse'), { recursive: true }).map(String)
      : [];
    for (const f of inRepo) expect(fs.readFileSync(path.join(repo, '.repo-synapse', f), 'utf8')).not.toContain('ghp_secret_value');
    const dir = bashDiffStateDir();
    expect(dir.startsWith(cfgDir)).toBe(true);
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).mode & 0o077, f).toBe(0);
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('two viewers on different repos: the key stays on until the last one exits', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');
    expect(await enableBashEditDiff({ repoRoot: a })).toMatchObject({ changed: true });
    expect(await enableBashEditDiff({ repoRoot: b })).toMatchObject({ changed: false, reason: 'shared' });
    expect(await restoreBashEditDiff({ repoRoot: a })).toMatchObject({ changed: false, status: 'in-use' });
    expect(readJson(file).bashEditDiffEnabled).toBe(true);
    expect(await restoreBashEditDiff({ repoRoot: b })).toMatchObject({ changed: true, status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
  });

  it('a crashed owner (dead PID) does not keep the key on, and its previous value survives', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"bashEditDiffEnabled":false}');
    await enableBashEditDiff({ repoRoot: a, pid: DEAD_PID });
    expect(await enableBashEditDiff({ repoRoot: b })).toMatchObject({ reason: 'shared', previous: { present: true, value: false } });
    expect(readBashDiffState()?.owners).toEqual([{ repo: b, pid: process.pid }]);
    expect(await restoreBashEditDiff({ repoRoot: b })).toMatchObject({ status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"bashEditDiffEnabled":false}');
  });

  it('invalid JSON at restore keeps the record so a later run can revert it', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"model":"x"}');
    await enableBashEditDiff({ repoRoot: repo });
    fs.writeFileSync(file, '{"model":"x","bashEditDiffEnabled":true,}');
    const r = await restoreBashEditDiff({ repoRoot: repo });
    expect(r).toMatchObject({ changed: false, status: 'pending' });
    expect(r.error).toMatch(/JSON/);
    expect(readBashDiffState()).not.toBeNull();
    expect(checkEnvironmentSync(repo).checks.some((c) => c.id === 'bash-diff-pending')).toBe(true);
    // The user fixes the file; uninstall (or the next start) retries.
    fs.writeFileSync(file, '{"model":"x","bashEditDiffEnabled":true}');
    expect(await restoreBashEditDiff({ repoRoot: repo })).toMatchObject({ changed: true, status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"model":"x"}');
    expect(readBashDiffState()).toBeNull();
  });

  it('an unwritable config dir makes enable throw and leaves nothing behind', async () => {
    const repo = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');
    fs.chmodSync(cfgDir, 0o555);
    try {
      await expect(enableBashEditDiff({ repoRoot: repo })).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      fs.chmodSync(cfgDir, 0o755);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(fs.existsSync(bashDiffStateDir())).toBe(false);
    expect(fs.existsSync(path.join(repo, '.repo-synapse', 'user-settings.bak'))).toBe(false);
  });
});

describe('install with a read-only .git/info/exclude', () => {
  it('installs the hooks anyway and reports the exclude error', () => {
    const repo = gitRepo();
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    fs.chmodSync(exclude, 0o444);
    try {
      const r = installHooksSync({ repoRoot: repo, port: 7777 });
      expect(r.excludeError).toMatch(/EACCES|EPERM/);
      expect(ownEntries(readJson(localFile(repo)))).toHaveLength(HOOK_EVENTS.length);
    } finally {
      fs.chmodSync(exclude, 0o644);
    }
  });
});

// ---------------------------------------------------------------- doctor

describe('checkEnvironment', () => {
  it('reports installed hooks, stale lock, allowlist and proxy problems', async () => {
    const repo = gitRepo();
    await installHooks({ repoRoot: repo, port: 7801 });
    updateManifest(repo, { port: 7801 });
    fs.writeFileSync(path.join(repo, '.repo-synapse', 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    fs.writeFileSync(
      path.join(cfgDir, 'settings.json'),
      JSON.stringify({ allowedHttpHookUrls: ['https://hooks.example.com/*'], disableAllHooks: true }),
    );
    process.env.HTTPS_PROXY = 'http://proxy:3128';
    process.env.NO_PROXY = 'example.com';
    try {
      const r = checkEnvironmentSync(repo);
      expect(r.nodeOk).toBe(true);
      expect(r.installedPorts).toEqual([7801]);
      expect(r.lock).toEqual({ pid: 2 ** 22 + 12345, alive: false });
      const byId = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
      expect(byId.installed).toBe('warn');
      expect(byId.lock).toBe('warn');
      expect(byId['allowlist-user']).toBe('error');
      expect(byId['disable-all-user']).toBe('error');
      expect(byId.proxy).toBe('warn');
      expect(r.checks.every((c) => c.message.length > 0)).toBe(true);
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
      await uninstallHooks({ repoRoot: repo });
    }
  });

  it('matches allowlist patterns and NO_PROXY entries', () => {
    expect(urlPatternMatches('http://127.0.0.1:*/hook?src=repo-synapse', hookUrl(7777))).toBe(true);
    expect(urlPatternMatches('http://localhost:*', hookUrl(7777))).toBe(false);
    expect(urlPatternMatches('http://127.0.0.1:7777/hook', hookUrl(7777))).toBe(false);
    expect(urlPatternMatches('http://127.0.0.1:*/*', hookUrl(7777))).toBe(true);
    expect(urlPatternMatches('*', hookUrl(7777))).toBe(true);
    expect(noProxyCovers('localhost,127.0.0.1')).toBe(true);
    expect(noProxyCovers('*')).toBe(true);
    expect(noProxyCovers('127.0.0.0/8')).toBe(true);
    expect(noProxyCovers('localhost')).toBe(false);
    expect(noProxyCovers(undefined)).toBe(false);
  });
});
