import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_EVENTS,
  acquireLockSync,
  lockStatus,
  checkEnvironmentSync,
  bashDiffStateDir,
  commandRunsScript,
  parseWin32ProcessInfo,
  enableBashEditDiff,
  ensureGitExcluded,
  installHooksSync,
  readBashDiffState,
  hookUrl,
  installHooks,
  processCommand,
  isLegacyHook,
  isOwnHook,
  legacyBashDiffStateDir,
  mergeHooks,
  noProxyCovers,
  readLegacyBashDiffState,
  readLegacyManifest,
  readManifest,
  uninstallHooksSync,
  removeOwnHooks,
  restoreBashEditDiff,
  uninstallHooks,
  updateManifest,
  urlPatternMatches,
  userSettingsPath,
} from '../../src/install/settings.ts';

const SETTINGS_TS = fileURLToPath(new URL('../../src/install/settings.ts', import.meta.url));
/** POSIX permission bits: Windows ignores chmod on folders and reports no group/other bits. */
const POSIX_MODES = process.platform !== 'win32';

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
  fs.rmSync(path.join(cfgDir, 'neurons'), { recursive: true, force: true });
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

/** `settings` with our hooks as a repo-synapse version wrote them (`?src=repo-synapse`). */
function legacyMerged(settings: object, port: number): Record<string, unknown> {
  return JSON.parse(JSON.stringify(mergeHooks(settings, port)).replaceAll('?src=neurons', '?src=repo-synapse'));
}

function legacyEntries(settings: unknown): number {
  const hooks = (settings as { hooks?: Record<string, Group[]> }).hooks ?? {};
  return Object.values(hooks).reduce((n, groups) => n + groups.reduce((m, g) => m + g.hooks.filter(isLegacyHook).length, 0), 0);
}

/**
 * Leaves `repo` as a repo-synapse version's install would: its hooks in the settings file,
 * the original bytes (if any) in .repo-synapse/settings.local.json.bak, and its manifest.
 */
function writeLegacyInstall(repo: string, original: string | undefined, port = 7777): void {
  const dir = path.join(repo, '.repo-synapse');
  fs.mkdirSync(dir, { recursive: true });
  const createdClaudeDir = !fs.existsSync(path.join(repo, '.claude'));
  if (original !== undefined) fs.writeFileSync(path.join(dir, 'settings.local.json.bak'), original);
  const manifest = {
    version: 1,
    createdFile: original === undefined,
    createdClaudeDir,
    backedUpAt: original === undefined ? null : '2026-09-30T12:00:00.000Z',
    port,
  };
  fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify(manifest, null, 2) + '\n');
  const base = original === undefined ? {} : (JSON.parse(original) as object);
  writeLocal(repo, JSON.stringify(legacyMerged(base, port), null, 2) + '\n');
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
    expect(hookUrl(7777)).toBe('http://127.0.0.1:7777/hook?src=neurons');
  });

  it('matches only the exact URL shape', () => {
    expect(isOwnHook({ type: 'http', url: hookUrl(1234) })).toBe(true);
    expect(isOwnHook({ type: 'http', url: 'http://127.0.0.1:7777/hook' })).toBe(false);
    expect(isOwnHook({ type: 'http', url: 'http://localhost:7777/hook?src=neurons' })).toBe(false);
    expect(isOwnHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=neurons&x=1' })).toBe(false);
    expect(isOwnHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=neurons-x' })).toBe(false);
    expect(isOwnHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse' })).toBe(false);
    expect(isOwnHook({ type: 'command', url: hookUrl(7777) })).toBe(false);
    expect(isOwnHook({ type: 'command', command: 'curl http://127.0.0.1:7777/hook?src=neurons' })).toBe(false);
    expect(isOwnHook(null)).toBe(false);
    expect(isOwnHook('http')).toBe(false);
  });

  it('isLegacyHook matches only the exact URL of the repo-synapse versions', () => {
    expect(isLegacyHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse' })).toBe(true);
    expect(isLegacyHook({ type: 'http', url: hookUrl(7777) })).toBe(false);
    expect(isLegacyHook({ type: 'http', url: 'http://localhost:7777/hook?src=repo-synapse' })).toBe(false);
    expect(isLegacyHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse&x=1' })).toBe(false);
    expect(isLegacyHook({ type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse2' })).toBe(false);
    expect(isLegacyHook({ type: 'http', url: 'http://127.0.0.1:7777/hook' })).toBe(false);
    expect(isLegacyHook({ type: 'command', command: 'curl http://127.0.0.1:7777/hook?src=repo-synapse' })).toBe(false);
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

  it('replaces the hooks of a repo-synapse version instead of adding to them', () => {
    const merged = mergeHooks(legacyMerged(foreignSettings(), 7777), 7790);
    expect(legacyEntries(merged)).toBe(0);
    expect(ownEntries(merged)).toHaveLength(HOOK_EVENTS.length);
    expect(removeOwnHooks(merged)).toEqual(foreignSettings());
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

  it('also removes the exact hooks of a repo-synapse version, and nothing that only looks like them', () => {
    const lookalikes = [
      { type: 'http', url: 'http://localhost:7777/hook?src=repo-synapse' },
      { type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse&x=1' },
      { type: 'command', command: 'curl http://127.0.0.1:7777/hook?src=repo-synapse' },
    ];
    const legacy = { type: 'http', url: 'http://127.0.0.1:7777/hook?src=repo-synapse', timeout: 2 };
    const s = { hooks: { Stop: [{ hooks: [...lookalikes, legacy, { type: 'http', url: hookUrl(7777) }] }], PreCompact: [{ hooks: [legacy] }] } };
    expect(removeOwnHooks(s)).toEqual({ hooks: { Stop: [{ hooks: lookalikes }] } });
    expect(removeOwnHooks(legacyMerged(foreignSettings(), 7777))).toEqual(foreignSettings());
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
    expect(fs.readFileSync(path.join(repo, '.neurons', 'settings.local.json.bak'), 'utf8')).toBe(original);
    const m = readManifest(repo);
    expect(m).toMatchObject({ createdFile: false, createdClaudeDir: false, port: 7777 });
    expect(typeof m?.backedUpAt).toBe('string');

    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: true });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.neurons', 'settings.local.json.bak'))).toBe(false);
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
    expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
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
    expect(after).toContain('/.neurons/\n');
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    expect(status).toBe('');
    // Second time nothing is appended.
    expect(ensureGitExcluded(repo)).toEqual([]);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(after);
    await uninstallHooks({ repoRoot: repo });
  });

  it('install and uninstall remove hooks of a repo-synapse version even without its manifest', async () => {
    const repo = gitRepo();
    writeLocal(repo, JSON.stringify(legacyMerged(foreignSettings(), 7777)));
    await installHooks({ repoRoot: repo, port: 7790 });
    const during = readJson(localFile(repo));
    expect(legacyEntries(during)).toBe(0);
    expect(ownEntries(during)).toHaveLength(HOOK_EVENTS.length);
    await uninstallHooks({ repoRoot: repo });
    expect(readJson(localFile(repo))).toEqual(foreignSettings());

    const repo2 = gitRepo();
    writeLocal(repo2, JSON.stringify(legacyMerged(foreignSettings(), 7777)));
    expect(await uninstallHooks({ repoRoot: repo2 })).toEqual({ changed: true });
    expect(readJson(localFile(repo2))).toEqual(foreignSettings());
  });

  it('install undoes a repo-synapse install first: its backup bytes become ours, its log stays', async () => {
    const repo = gitRepo();
    const original = '{\n\t"model":   "opus"\n}';
    writeLegacyInstall(repo, original);
    fs.writeFileSync(path.join(repo, '.repo-synapse', 'events.jsonl'), '{"kind":"tree"}\n');
    fs.writeFileSync(path.join(repo, '.repo-synapse', 'lock'), JSON.stringify({ pid: DEAD_PID }));
    await installHooks({ repoRoot: repo, port: 7790 });
    expect(readLegacyManifest(repo)).toBeNull();
    expect(fs.readdirSync(path.join(repo, '.repo-synapse'))).toEqual(['events.jsonl']);
    expect(fs.readFileSync(path.join(repo, '.neurons', 'settings.local.json.bak'), 'utf8')).toBe(original);
    expect(legacyEntries(readJson(localFile(repo)))).toBe(0);
    expect(ownEntries(readJson(localFile(repo)))).toHaveLength(HOOK_EVENTS.length);
    await uninstallHooks({ repoRoot: repo });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(repo, '.repo-synapse', 'events.jsonl'), 'utf8')).toBe('{"kind":"tree"}\n');
  });

  it('uninstall undoes a repo-synapse install: restores its bytes or deletes the file it created', async () => {
    const repo = gitRepo();
    const original = JSON.stringify(foreignSettings(), null, 4);
    writeLegacyInstall(repo, original);
    expect(await uninstallHooks({ repoRoot: repo })).toEqual({ changed: true });
    expect(fs.readFileSync(localFile(repo), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.repo-synapse'))).toBe(false);

    const repo2 = gitRepo();
    writeLegacyInstall(repo2, undefined);
    expect(await uninstallHooks({ repoRoot: repo2 })).toEqual({ changed: true });
    expect(fs.existsSync(path.join(repo2, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(repo2, '.repo-synapse'))).toBe(false);
    expect(await uninstallHooks({ repoRoot: repo2 })).toEqual({ changed: false });
  });

  // Regression (F4): the cleanup of a neu viewer stripped the hooks of a repo-synapse viewer
  // started after it on the same repo, and deleted that viewer's manifest and backup.
  it('a running repo-synapse viewer keeps its hooks and its install when ours is undone', async () => {
    const repo = gitRepo();
    const original = '{"permissions":{"allow":[]}}';
    writeLocal(repo, original);
    installHooksSync({ repoRoot: repo, port: 7790 });
    // The old version starts next to it: its backup holds our hooks, then it adds its own.
    const dir = path.join(repo, '.repo-synapse');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.local.json.bak'), fs.readFileSync(localFile(repo)));
    fs.writeFileSync(
      path.join(dir, 'install.json'),
      JSON.stringify({ version: 1, createdFile: false, createdClaudeDir: false, backedUpAt: '2026-10-03T12:00:00.000Z', port: 7791 }),
    );
    const settings = readJson(localFile(repo)) as { hooks: Record<string, Group[]> };
    for (const event of HOOK_EVENTS) settings.hooks[event]!.push({ hooks: [{ type: 'http', url: 'http://127.0.0.1:7791/hook?src=repo-synapse', timeout: 2 }] });
    writeLocal(repo, JSON.stringify(settings, null, 2));
    const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: k.pid, startedAt: new Date(Date.now() + 1000).toISOString() }));
      expect(uninstallHooksSync({ repoRoot: repo })).toEqual({ changed: true });
      const after = readJson(localFile(repo));
      expect(ownEntries(after)).toEqual([]);
      expect(legacyEntries(after)).toBe(HOOK_EVENTS.length);
      expect(after.permissions).toEqual({ allow: [] });
      expect(readLegacyManifest(repo)).not.toBeNull();
      expect(fs.existsSync(path.join(dir, 'settings.local.json.bak'))).toBe(true);
      expect(fs.existsSync(path.join(repo, '.neurons', 'install.json'))).toBe(false);
    } finally {
      k.kill('SIGKILL');
      await new Promise((r) => k.once('exit', r));
    }
    // Once it is gone, its install is undone: its backup holds our hooks, so the clean JSON is written.
    expect(uninstallHooksSync({ repoRoot: repo })).toEqual({ changed: true });
    expect(readJson(localFile(repo))).toEqual(JSON.parse(original));
    expect(readLegacyManifest(repo)).toBeNull();
  });

  it('skips entries already ignored by .gitignore and non-git dirs', async () => {
    const repo = gitRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), '.neurons/\n');
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
    const inRepo = fs.existsSync(path.join(repo, '.neurons'))
      ? fs.readdirSync(path.join(repo, '.neurons'), { recursive: true }).map(String)
      : [];
    for (const f of inRepo) expect(fs.readFileSync(path.join(repo, '.neurons', f), 'utf8')).not.toContain('ghp_secret_value');
    const dir = bashDiffStateDir();
    expect(dir.startsWith(cfgDir)).toBe(true);
    // Windows has no group/other bits to check (stat reports 0o666 for any writable file);
    // there the files live under the user's own config dir, see docs/DECISIONS.md (W3).
    if (POSIX_MODES) for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).mode & 0o077, f).toBe(0);
    await restoreBashEditDiff({ repoRoot: repo });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(dir)).toBe(false);
  });

  /** A record as a repo-synapse version left it in <config dir>/repo-synapse/. */
  function writeLegacyRegistry(settingsBytes: string, owners: Array<{ repo: string; pid: number }>): string {
    const dir = legacyBashDiffStateDir();
    expect(dir).toBe(path.join(cfgDir, 'repo-synapse'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(path.join(dir, 'settings.json.bak'), settingsBytes, { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, 'bash-diff.json'),
      JSON.stringify({ version: 1, settingsPath: file, previous: { present: false }, owners }),
      { mode: 0o600 },
    );
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(settingsBytes), bashEditDiffEnabled: true }));
    return file;
  }

  it('keeps its record in <config dir>/neurons', () => {
    expect(bashDiffStateDir()).toBe(path.join(cfgDir, 'neurons'));
  });

  it('a record left by repo-synapse (crashed viewer) is migrated and restored byte for byte', async () => {
    const repo = gitRepo();
    const original = '{\n    "theme": "dark"\n}';
    const file = writeLegacyRegistry(original, [{ repo, pid: DEAD_PID }]);
    expect(checkEnvironmentSync(repo).checks.some((c) => c.id === 'bash-diff-pending')).toBe(true);
    expect(await restoreBashEditDiff({ repoRoot: repo })).toMatchObject({ changed: true, status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(legacyBashDiffStateDir())).toBe(false);
    expect(fs.existsSync(bashDiffStateDir())).toBe(false);
  });

  // Regression (F3): the record was moved out from under a live repo-synapse viewer, whose
  // own restore then found nothing and left bashEditDiffEnabled on for good.
  it('while a repo-synapse owner is alive its record is shared in place: dead owners dropped, nothing migrated', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const c = gitRepo();
    const original = '{"a":1}';
    const file = writeLegacyRegistry(original, [
      { repo: a, pid: process.pid },
      { repo: b, pid: DEAD_PID },
    ]);
    expect(await enableBashEditDiff({ repoRoot: c, pid: DEAD_PID + 1 })).toMatchObject({ changed: false, reason: 'shared', previous: { present: false } });
    expect(readBashDiffState()).toBeNull();
    expect(readLegacyBashDiffState()?.owners).toEqual([
      { repo: a, pid: process.pid },
      { repo: c, pid: DEAD_PID + 1 },
    ]);
    // The legacy viewer is still live: the key stays on for it, and its record stays where it looks.
    expect(await restoreBashEditDiff({ repoRoot: c })).toMatchObject({ status: 'in-use' });
    expect(readJson(file).bashEditDiffEnabled).toBe(true);
    expect(readLegacyBashDiffState()?.owners).toEqual([{ repo: a, pid: process.pid }]);
    // Same format, same rules: this stands for the legacy viewer's own restore on exit.
    expect(await restoreBashEditDiff({ repoRoot: a })).toMatchObject({ status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.existsSync(legacyBashDiffStateDir())).toBe(false);
  });

  it('a repo-synapse record with only dead owners is migrated by enable', async () => {
    const a = gitRepo();
    const original = '{"a":1}';
    const file = writeLegacyRegistry(original, [{ repo: a, pid: DEAD_PID }]);
    expect(await enableBashEditDiff({ repoRoot: a })).toMatchObject({ changed: false, reason: 'shared' });
    expect(fs.existsSync(legacyBashDiffStateDir())).toBe(false);
    expect(readBashDiffState()?.owners).toEqual([{ repo: a, pid: process.pid }]);
    expect(await restoreBashEditDiff({ repoRoot: a })).toMatchObject({ status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('a repo-synapse record joins a current one instead of replacing it', async () => {
    const a = gitRepo();
    const b = gitRepo();
    const file = path.join(cfgDir, 'settings.json');
    fs.writeFileSync(file, '{"x":1}');
    await enableBashEditDiff({ repoRoot: a });
    const dir = legacyBashDiffStateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bash-diff.json'),
      JSON.stringify({ version: 1, settingsPath: file, previous: { present: true, value: false }, owners: [{ repo: b, pid: process.pid }] }),
    );
    expect(await restoreBashEditDiff({ repoRoot: a })).toMatchObject({ status: 'in-use' });
    expect(readBashDiffState()).toMatchObject({ previous: { present: false }, owners: [{ repo: b, pid: process.pid }] });
    // Its viewer is alive: the legacy record stays for its own restore.
    expect(fs.existsSync(path.join(dir, 'bash-diff.json'))).toBe(true);
    expect(await restoreBashEditDiff({ repoRoot: b })).toMatchObject({ status: 'restored' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"x":1}');
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

  // chmod 0o555 does not make a folder read-only on Windows (docs/DECISIONS.md, W3).
  it.skipIf(!POSIX_MODES)('an unwritable config dir makes enable throw and leaves nothing behind', async () => {
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
    fs.writeFileSync(path.join(repo, '.neurons', 'lock'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
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

  it('reports hooks left by a repo-synapse version', () => {
    const repo = gitRepo();
    writeLocal(repo, JSON.stringify(legacyMerged({}, 7777)));
    const r = checkEnvironmentSync(repo);
    expect(r.installedPorts).toEqual([]);
    expect(r.legacyPorts).toEqual([7777]);
    expect(r.checks.find((c) => c.id === 'legacy-hooks')).toMatchObject({ status: 'warn' });
  });

  it('matches allowlist patterns and NO_PROXY entries', () => {
    expect(urlPatternMatches('http://127.0.0.1:*/hook?src=neurons', hookUrl(7777))).toBe(true);
    expect(urlPatternMatches('http://127.0.0.1:*/hook?src=repo-synapse', hookUrl(7777))).toBe(false);
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

// ---------------------------------------------------------------- lock

describe('acquireLockSync', () => {
  const kids: ChildProcess[] = [];
  const dead = 2 ** 22 + 4321;

  afterAll(() => {
    for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL');
  });

  function sleeper(): ChildProcess {
    const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    kids.push(k);
    return k;
  }

  function lockFiles(repo: string): string[] {
    return fs.readdirSync(path.join(repo, '.neurons')).filter((f) => f.startsWith('lock')).sort();
  }

  function writeLock(repo: string, v: unknown): string {
    fs.mkdirSync(path.join(repo, '.neurons'), { recursive: true });
    const file = path.join(repo, '.neurons', 'lock');
    fs.writeFileSync(file, JSON.stringify(v) + '\n');
    return file;
  }

  it('creates the lock with pid, start time and script, and takes over a dead one', () => {
    const repo = gitRepo();
    expect(acquireLockSync(repo)).toEqual({ ok: true });
    const file = path.join(repo, '.neurons', 'lock');
    const own = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(own).toMatchObject({ pid: process.pid, cmd: process.argv[1] });
    expect(Number.isFinite(Date.parse(own.startedAt))).toBe(true);

    writeLock(repo, { pid: dead, startedAt: '2001-01-01T00:00:00.000Z' });
    expect(acquireLockSync(repo)).toEqual({ ok: true, tookOver: dead });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid);
    expect(lockFiles(repo)).toEqual(['lock']);
  });

  it('refuses a live owner and leaves its lock alone', async () => {
    const repo = gitRepo();
    const k = sleeper();
    await new Promise((r) => setTimeout(r, 100));
    const file = writeLock(repo, { pid: k.pid, startedAt: new Date().toISOString() });
    const before = fs.readFileSync(file);
    expect(acquireLockSync(repo)).toEqual({ ok: false, reason: 'live', pid: k.pid });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  // Regression (F7 follow-up): a wall-clock step after start made a live owner read as stale.
  it('a process that started after startedAt owns the lock only if its command line names the lock script', async () => {
    const k = sleeper();
    await new Promise((r) => setTimeout(r, 100));
    const old = '2001-01-01T00:00:00.000Z';
    expect(lockStatus(Buffer.from(JSON.stringify({ pid: k.pid, startedAt: old })))).toEqual({ pid: k.pid, alive: false });
    expect(lockStatus(Buffer.from(JSON.stringify({ pid: k.pid, startedAt: old, cmd: process.execPath })))).toEqual({ pid: k.pid, alive: true });
    expect(lockStatus(Buffer.from(JSON.stringify({ pid: k.pid, startedAt: old, cmd: '/nowhere/cli.mjs' })))).toEqual({ pid: k.pid, alive: false });
    // A recorded command line is compared exactly (a relative launch: argv[1] is absolute).
    const line = processCommand(k.pid!);
    expect(lockStatus(Buffer.from(JSON.stringify({ pid: k.pid, startedAt: old, cmd: '/abs/src/cli.ts', command: line })))).toEqual({ pid: k.pid, alive: true });
    expect(lockStatus(Buffer.from(JSON.stringify({ pid: k.pid, startedAt: old, cmd: process.execPath, command: 'node other.mjs' })))).toEqual({ pid: k.pid, alive: false });
  });

  it('a lock written through one bin name still matches a run through another', () => {
    expect(commandRunsScript('node /opt/bin/neu start', '/opt/bin/neu')).toBe(true);
    expect(commandRunsScript('node /opt/bin/neu start', '/opt/bin/repo-synapse')).toBe(true);
    expect(commandRunsScript('node /opt/bin/repo-synapse start', '/opt/bin/neurons')).toBe(true);
    expect(commandRunsScript('node /opt/bin/neu start', '/usr/bin/repo-synapse')).toBe(false);
    expect(commandRunsScript('node /opt/bin/neu start', '/opt/bin/other')).toBe(false);
    expect(commandRunsScript('node /x/dist/cli.mjs start', '/x/dist/cli.mjs')).toBe(true);
    expect(commandRunsScript('node /x/dist/cli.mjs', '/x/dist/cli.mjs')).toBe(true);
  });

  // Regression (F1): a substring match took another program for the viewer.
  it('the script path must be a whole argument, not the prefix of another path', () => {
    expect(commandRunsScript('node /usr/local/bin/neutron serve', '/usr/local/bin/neu')).toBe(false);
    expect(commandRunsScript('node /usr/local/bin/neural-cli', '/usr/local/bin/neurons')).toBe(false);
    expect(commandRunsScript('node /opt/app/dist/cli.js.bak', '/opt/app/dist/cli.js')).toBe(false);
    expect(commandRunsScript('node /other/opt/app/dist/cli.js', '/opt/app/dist/cli.js')).toBe(false);
    expect(commandRunsScript('/usr/local/bin/neu', '/usr/local/bin/neu')).toBe(true);
    expect(commandRunsScript('node\t/usr/local/bin/neurons\tstart', '/usr/local/bin/neu')).toBe(true);
  });

  it('Windows: a quoted script path is a whole argument; WMI output parses', () => {
    const cli = 'C:\\Users\\Me\\AppData\\Roaming\\npm\\node_modules\\neurons-cli\\dist\\cli.mjs';
    expect(commandRunsScript(`"C:\\Program Files\\nodejs\\node.exe" "${cli}" start`, cli)).toBe(true);
    expect(commandRunsScript(`"C:\\Program Files\\nodejs\\node.exe" "${cli}.bak" start`, cli)).toBe(false);
    expect(parseWin32ProcessInfo('2026-10-04T12:00:00.0000000Z\r\n"node.exe" "C:\\x\\cli.mjs" start\r\n')).toEqual({
      startMs: Date.parse('2026-10-04T12:00:00Z'),
      command: '"node.exe" "C:\\x\\cli.mjs" start',
    });
    expect(parseWin32ProcessInfo('')).toBeUndefined();
  });

  // Regression (F8 follow-up): the takeover moved the lock aside before checking it, so a
  // third start could slip in while a fresh lock was missing and two starts both won.
  it('waits for a takeover in progress instead of touching the lock', () => {
    const repo = gitRepo();
    const file = writeLock(repo, { pid: dead });
    fs.writeFileSync(`${file}.takeover`, JSON.stringify({ pid: process.pid }) + '\n');
    const before = fs.readFileSync(file);
    expect(acquireLockSync(repo, { timeoutMs: 100 })).toEqual({ ok: false, reason: 'busy' });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    fs.rmSync(`${file}.takeover`);
    expect(acquireLockSync(repo)).toEqual({ ok: true, tookOver: dead });
  });

  it('clears a takeover guard left by a crashed start', () => {
    const repo = gitRepo();
    const file = writeLock(repo, { pid: dead });
    fs.writeFileSync(`${file}.takeover`, JSON.stringify({ pid: dead + 1 }) + '\n');
    expect(acquireLockSync(repo)).toEqual({ ok: true, tookOver: dead });
    expect(lockFiles(repo)).toEqual(['lock']);
  });

  it('any number of processes racing on a stale lock: exactly one owner', async () => {
    const racer = `
      const { acquireLockSync } = await import(${JSON.stringify(pathToFileURL(SETTINGS_TS).href)});
      const [repo, at] = process.argv.slice(1);
      while (Date.now() < Number(at)) {}
      const r = acquireLockSync(repo);
      process.stdout.write(JSON.stringify(r));
      setTimeout(() => {}, r.ok ? 1500 : 0);
    `;
    for (let round = 0; round < 4; round++) {
      const repo = gitRepo();
      writeLock(repo, { pid: dead, startedAt: '2001-01-01T00:00:00.000Z' });
      const at = String(Date.now() + 600);
      const runs = Array.from({ length: 8 }, () => {
        const k = spawn(process.execPath, ['--input-type=module', '-e', racer, repo, at], { stdio: ['ignore', 'pipe', 'inherit'] });
        kids.push(k);
        let text = '';
        k.stdout!.on('data', (d: Buffer) => (text += d.toString()));
        return new Promise<{ pid: number; r: { ok: boolean } }>((resolve) =>
          k.stdout!.on('end', () => resolve({ pid: k.pid!, r: JSON.parse(text) })),
        );
      });
      const results = await Promise.all(runs);
      const winners = results.filter((x) => x.r.ok);
      expect(winners).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(repo, '.neurons', 'lock'), 'utf8')).pid).toBe(winners[0]!.pid);
      expect(lockFiles(repo)).toEqual(['lock']);
    }
  }, 30_000);
});
