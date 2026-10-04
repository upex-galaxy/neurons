#!/usr/bin/env node
// Neurons CLI (bins `neu` and `neurons`): start | install | uninstall | replay | doctor |
// ls | stop | open. `neu` alone is `neu start`, and `neu <dir>` is `neu start <dir>`.
// Console output comes from src/i18n (English or Spanish, see detectLang); identifiers and
// comments stay in English.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNeuronsServer, type NeuronsServer } from './server/server.ts';
import {
  acquireLockSync,
  checkEnvironmentSync,
  enableBashEditDiffSync,
  ensureGitExcluded,
  installHooksSync,
  legacyLockPath,
  lockPath,
  readLegacyLock,
  readLegacyManifest,
  readLock,
  readManifest,
  restoreBashEditDiffSync,
  uninstallHooksSync,
  type DoctorCheck,
  type RestoreBashDiffResult,
  type SettingsSourceInfo,
} from './install/settings.ts';
import { route, type Options } from './cli/args.ts';
import { STOP_TIMEOUT_MS, stopViewer, type StopTarget } from './cli/control.ts';
import { CliError, err, fail, out } from './cli/output.ts';
import { listViewers, removeViewerEntry, viewerForRepo, viewerFromLock, writeViewerEntry, type ViewerEntry } from './cli/registry.ts';
import { browserCommand, shellArg, shutdownSignals } from './cli/platform.ts';
import { resolveRepoRoot } from './cli/repo-root.ts';
import { findClaudeSessions, startHint } from './cli/sessions.ts';
import { DEFAULT_PORT, LEGACY_STATE_DIR_NAME, STATE_DIR_NAME } from './shared/types.ts';
import { detectLang, setLang, t, tn, type Params } from './i18n.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function version(): string {
  // dist/cli.mjs and src/cli.ts both sit one level under the package root.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function help(): string {
  return t('cli.help', { version: version(), port: DEFAULT_PORT, stopSeconds: STOP_TIMEOUT_MS / 1000 });
}

// ---------------------------------------------------------------- repo

/**
 * The repo a command works on: `arg` (default: the cwd) moved up to its git root, with a
 * line saying so when that changed the directory. `treeNote`: also say when it is not git.
 */
function resolveRepo(arg: string | undefined, o: { treeNote?: boolean } = {}): string {
  const r = resolveRepoRoot(arg);
  if (r.root !== r.given) out(t('repo.usingRoot', { root: r.root }));
  if (!r.isGit && o.treeNote) out(t('repo.notGit'));
  return r.root;
}

// ---------------------------------------------------------------- helpers

function resolveWebDir(): string | undefined {
  const candidates = [
    path.resolve(HERE, 'web'), // dist/cli.mjs -> dist/web
    path.resolve(HERE, '..', 'dist', 'web'), // src/cli.ts via tsx -> dist/web
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
}

/** dist/docs (the user guide and architecture pages), when built. */
function resolveDocsDir(): string | undefined {
  const candidates = [
    path.resolve(HERE, 'docs'), // dist/cli.mjs -> dist/docs
    path.resolve(HERE, '..', 'dist', 'docs'), // src/cli.ts via tsx -> dist/docs
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'guide.html')) || fs.existsSync(path.join(d, 'architecture.html')));
}

/**
 * Opens `url` in the default browser (see browserCommand). Resolves true when the opener
 * exited cleanly; `start` does not wait for it, `open` does.
 */
function openBrowser(url: string): Promise<boolean> {
  const { cmd, args, verbatim } = browserCommand(url);
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { windowsHide: true, timeout: 10_000, windowsVerbatimArguments: verbatim }, (e) => {
        if (e) err(t('browser.failed', { error: e.message, url }));
        resolve(!e);
      });
      child.unref();
    } catch (e) {
      err(t('browser.failed', { error: (e as Error).message, url }));
      resolve(false);
    }
  });
}

function onServerError(e: unknown): void {
  if (process.env.NEURONS_DEBUG || process.env.REPO_SYNAPSE_DEBUG) err(`[neurons] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}

/** Lines about the bashEditDiffEnabled release, for the user. */
function bashDiffMessages(r: RestoreBashDiffResult | undefined): { info: string[]; warn: string[] } {
  if (!r) return { info: [], warn: [] };
  switch (r.status) {
    case 'restored':
      return { info: [t('bashDiff.restored')], warn: [] };
    case 'in-use':
      return { info: [t('bashDiff.inUse')], warn: [] };
    case 'pending':
      return {
        info: [],
        warn: [
          t('bashDiff.pending', { path: r.settingsPath ?? t('bashDiff.userSettings'), error: r.error ?? t('common.unknownError') }),
          t('bashDiff.retry'),
        ],
      };
    default:
      return { info: [], warn: [] };
  }
}

/** Releases bashEditDiffEnabled (restored when no other viewer needs it) and removes our hooks. */
function undoInstall(repo: string): { hooksChanged: boolean; bashDiff?: RestoreBashDiffResult } {
  let bashDiff: RestoreBashDiffResult | undefined;
  let firstError: unknown;
  try {
    bashDiff = restoreBashEditDiffSync({ repoRoot: repo });
  } catch (e) {
    firstError = e;
  }
  let hooksChanged = false;
  try {
    hooksChanged = uninstallHooksSync({ repoRoot: repo }).changed;
  } catch (e) {
    firstError ??= e;
  }
  if (firstError) throw firstError;
  return bashDiff ? { hooksChanged, bashDiff } : { hooksChanged };
}

/** Keeps .neurons/ out of git even without hooks (events.jsonl lists the repo). Best effort. */
function excludeStateDir(repo: string): void {
  try {
    ensureGitExcluded(repo);
  } catch (e) {
    err(t('common.excludeFailed', { error: (e as Error).message, dir: STATE_DIR_NAME }));
  }
}

/** Fails when a repo-synapse version (before the rename) is running on the repo. */
function failIfLegacyRunning(repo: string, action: 'open' | 'install'): void {
  const legacy = readLegacyLock(repo);
  if (legacy?.alive && legacy.pid !== process.pid) {
    fail(t('legacy.running', { repo, pid: legacy.pid, action: t(`legacy.action.${action}`), lock: legacyLockPath(repo) }));
  }
}

/** Takes the repo's lock or fails (see acquireLockSync). */
function acquireLock(repo: string): void {
  // Both would install hooks in the same settings file, and each removes the other's.
  failIfLegacyRunning(repo, 'open');
  const r = acquireLockSync(repo);
  if (r.ok) {
    if (r.tookOver !== undefined) {
      out(t('lock.tookOver', { pid: r.tookOver || '?' }));
    }
    return;
  }
  if (r.reason === 'live') {
    fail(t('lock.live', { repo, pid: r.pid, lock: lockPath(repo) }));
  }
  fail(t('lock.busy', { repo }));
}

function releaseLock(repo: string): void {
  const lock = readLock(repo);
  if (lock && lock.pid !== process.pid) return;
  fs.rmSync(lockPath(repo), { force: true });
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const s of shutdownSignals()) process.once(s, () => resolve(s));
  });
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);
}

// ---------------------------------------------------------------- commands

async function cmdStart(positionals: string[], o: Options): Promise<number> {
  const repo = resolveRepo(positionals[0], { treeNote: true });
  acquireLock(repo);

  let server: NeuronsServer | undefined;
  let installed = false;
  let registered = false;
  let cleaned = false;
  /** Synchronous part of the cleanup: safe to run from an `exit` handler, runs once. */
  const cleanupSync = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (installed) {
      try {
        const r = undoInstall(repo);
        if (r.hooksChanged) out(t('start.hooksRemoved'));
        const msg = bashDiffMessages(r.bashDiff);
        for (const line of msg.info) out(line);
        for (const line of msg.warn) err(line);
      } catch (e) {
        err(t('common.uninstallFailed', { error: (e as Error).message }));
        err(t('common.runUninstall'));
      }
    }
    try {
      if (registered) removeViewerEntry();
    } catch {
      /* best effort: readers prune dead entries */
    }
    try {
      releaseLock(repo);
    } catch {
      /* best effort */
    }
  };
  process.on('exit', cleanupSync);

  let exiting = false;
  const shutdown = async (code: number): Promise<never> => {
    if (!exiting) {
      exiting = true;
      // Keep the process alive while the server closes.
      const keepAlive = setInterval(() => {}, 1000);
      cleanupSync();
      if (server) await withTimeout(server.close(), 2000);
      clearInterval(keepAlive);
    }
    process.exit(code);
  };
  for (const s of shutdownSignals()) {
    // A second signal while closing skips the wait for the server (cleanup already ran).
    process.on(s, () => {
      if (!exiting) out(t('start.signal', { signal: s }));
      void shutdown(0);
    });
  }
  const unexpected = (e: unknown): Params => ({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.on('uncaughtException', (e) => {
    err(t('common.unexpected', unexpected(e)));
    void shutdown(1);
  });
  process.on('unhandledRejection', (e) => {
    err(t('common.unexpected', unexpected(e)));
    void shutdown(1);
  });

  try {
    excludeStateDir(repo);
    if (o.install && (readManifest(repo) || readLegacyManifest(repo))) {
      // Leftovers of a run that did not clean up (or of a repo-synapse version): undo
      // them before a fresh install.
      installed = true;
      undoInstall(repo);
      installed = false;
    }
    const webDir = resolveWebDir();
    if (!webDir) err(t('start.webMissing'));
    const docsDir = resolveDocsDir();
    server = await startNeuronsServer({
      root: repo,
      port: o.port,
      portStrict: o.strictPort,
      mode: 'live',
      ...(webDir ? { webDir } : {}),
      ...(docsDir ? { docsDir } : {}),
      onError: onServerError,
    });
    if (server.watcherError) err(t('start.watcherFailed', { error: server.watcherError }));
    if (o.port !== 0 && server.port !== o.port) out(t('start.portBusy', { port: o.port, actual: server.port }));
    try {
      writeViewerEntry({ repo, port: server.port, url: server.url });
      registered = true;
    } catch (e) {
      err(t('start.registryFailed', { error: (e as Error).message }));
    }

    let bashNote = '';
    if (o.install) {
      let inst;
      try {
        inst = installHooksSync({ repoRoot: repo, port: server.port });
      } finally {
        // The manifest is written before the settings file: when it exists, something
        // may be on disk and the cleanup must undo it, even if the install threw.
        if (readManifest(repo)) installed = true;
      }
      out(t('common.hooksInstalled', { file: path.relative(repo, inst.settingsPath), port: server.port }));
      if (inst.excludeError) err(t('start.excludeFailed', { error: inst.excludeError, dir: STATE_DIR_NAME }));
      if (o.bashDiff) {
        try {
          const r = enableBashEditDiffSync({ repoRoot: repo });
          if (r.changed) bashNote = t('bashDiff.enabled', { path: r.settingsPath });
          else if (r.reason === 'shared') bashNote = t('bashDiff.shared');
          else if (r.reason === 'missing') bashNote = t('bashDiff.missing', { path: r.settingsPath });
          else if (r.reason === 'invalid') bashNote = t('bashDiff.invalid', { path: r.settingsPath });
        } catch (e) {
          bashNote = t('bashDiff.enableFailed', { error: (e as Error).message });
        }
      }
    }
    if (bashNote) out(bashNote);

    out('');
    out(t('start.listening', { url: server.url }));
    out(t('start.repository', { repo }));
    if (docsDir) out(t('start.docs', { url: server.url }));
    out('');
    if (o.install) {
      for (const line of startHint(await findClaudeSessions(repo))) out(line);
    } else {
      out(t('start.noInstall'));
    }
    out(o.install ? t('start.ctrlCHooks') : t('start.ctrlC'));

    if (o.open) void openBrowser(server.url);
  } catch (e) {
    err(e instanceof CliError ? e.message : t('start.failed', { error: (e as Error).message }));
    return shutdown(1);
  }

  // Runs until a signal calls shutdown().
  return new Promise<number>(() => {});
}

function cmdInstall(positionals: string[], o: Options): number {
  const repo = resolveRepo(positionals[0]);
  // A live start already installed hooks pointing at the port it really listens on
  // (maybe a fallback): rewriting them to --port would cut it off from Claude Code.
  // Without a manifest the live start runs with --no-install: there is nothing to protect.
  const lock = readLock(repo);
  if (lock?.alive && lock.pid !== process.pid && readManifest(repo)) {
    fail(t('install.viewerRunning', { repo, pid: lock.pid }));
  }
  // Installing removes that version's hooks (and undoes its install) while it runs.
  if (readLegacyManifest(repo)) failIfLegacyRunning(repo, 'install');
  const r = installHooksSync({ repoRoot: repo, port: o.port });
  out(t('common.hooksInstalled', { file: r.settingsPath, port: o.port }));
  out(t('install.hookErrorWarning', { port: o.port }));
  out(t('install.removeHint'));
  return 0;
}

function cmdUninstall(positionals: string[]): number {
  const repo = resolveRepo(positionals[0]);
  const lock = readLock(repo);
  if (lock?.alive && lock.pid !== process.pid) {
    out(t('uninstall.stillRunning', { pid: lock.pid }));
  }
  const legacy = readLegacyLock(repo);
  if (legacy?.alive && legacy.pid !== process.pid) {
    out(t('uninstall.legacyRunning', { pid: legacy.pid }));
  }
  const r = undoInstall(repo);
  out(r.hooksChanged ? t('common.hooksRemoved') : t('common.noHooks'));
  const msg = bashDiffMessages(r.bashDiff);
  for (const line of msg.info) out(line);
  for (const line of msg.warn) err(line);
  return msg.warn.length > 0 ? 1 : 0;
}

async function cmdReplay(positionals: string[], o: Options): Promise<number> {
  const target = path.resolve(positionals[0] ?? process.cwd());
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st) fail(t('replay.missing', { path: target }));
  let root: string;
  let file: string;
  if (st.isDirectory()) {
    root = resolveRepo(target);
    // Logs recorded by a repo-synapse version stay in its dir: use them when there is no new one.
    file = path.join(root, STATE_DIR_NAME, 'events.jsonl');
    const legacy = path.join(root, LEGACY_STATE_DIR_NAME, 'events.jsonl');
    if (!fs.existsSync(file) && fs.existsSync(legacy)) file = legacy;
  } else {
    file = fs.realpathSync(target);
    const dir = path.dirname(file);
    const base = path.basename(dir);
    root = base === STATE_DIR_NAME || base === LEGACY_STATE_DIR_NAME ? path.dirname(dir) : dir;
  }
  if (!fs.existsSync(file)) fail(t('replay.noLog', { file }));

  const webDir = resolveWebDir();
  if (!webDir) err(t('common.webMissing'));
  const docsDir = resolveDocsDir();
  const server = await startNeuronsServer({
    root,
    port: o.port,
    portStrict: o.strictPort,
    mode: 'replay',
    replayFile: file,
    ...(webDir ? { webDir } : {}),
    ...(docsDir ? { docsDir } : {}),
    onError: onServerError,
  });
  out(t('replay.listening', { url: server.url }));
  out(t('replay.log', { file }));
  if (docsDir) out(t('start.docs', { url: server.url }));
  out(t('start.ctrlC'));
  if (o.open) void openBrowser(server.url);
  await waitForSignal();
  await withTimeout(server.close(), 2000);
  return 0;
}

const STATUSES: DoctorCheck['status'][] = ['ok', 'info', 'warn', 'error'];

/** `[label]` padded to the widest label of the current language. */
function statusLabel(status: DoctorCheck['status']): string {
  const width = Math.max(...STATUSES.map((s) => t(`doctor.status.${s}`).length)) + 3;
  return `[${t(`doctor.status.${status}`)}]`.padEnd(width);
}

const SCOPES: SettingsSourceInfo['scope'][] = ['managed', 'user', 'project', 'local'];

/** The settings scope, translated and padded to the widest scope of the current language. */
function scopeLabel(scope: SettingsSourceInfo['scope']): string {
  const width = Math.max(...SCOPES.map((s) => t(`doctor.scopeColumn.${s}`).length));
  return t(`doctor.scopeColumn.${scope}`).padEnd(width);
}

function cmdDoctor(positionals: string[]): number {
  const repo = resolveRepo(positionals[0]);
  const report = checkEnvironmentSync(repo);
  out(t('doctor.title', { version: version(), repo }));
  out('');
  out(t('doctor.configFiles'));
  for (const s of report.sources) {
    const state = !s.exists ? t('doctor.source.missing') : s.valid ? t('doctor.source.ok') : t('doctor.source.invalid');
    out(`  ${scopeLabel(s.scope)}  ${s.path} (${state})`);
  }
  out('');
  const checks = [...report.checks];
  const webDir = resolveWebDir();
  checks.push(webDir ? { id: 'web', status: 'ok', message: t('doctor.web.ok', { dir: webDir }) } : { id: 'web', status: 'warn', message: t('doctor.web.missing') });
  const docsDir = resolveDocsDir();
  checks.push(docsDir ? { id: 'docs', status: 'ok', message: t('doctor.docs.ok', { dir: docsDir }) } : { id: 'docs', status: 'info', message: t('doctor.docs.missing') });
  for (const c of checks) out(`${statusLabel(c.status)}${c.message}`);
  const errors = report.checks.filter((c) => c.status === 'error').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  out('');
  out(errors + warns === 0 ? t('doctor.allGood') : t('doctor.summary', { errors: tn('doctor.errors', errors), warns: tn('doctor.warns', warns) }));
  return 0;
}

// ---------------------------------------------------------------- ls / open / stop

/** `p` with the home directory shown as ~. */
function homeShort(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Local time as YYYY-MM-DD HH:MM. */
function formatSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function viewersTable(viewers: ViewerEntry[]): string[] {
  const rows = [
    [t('ls.header.repo'), t('ls.header.port'), t('ls.header.url'), t('ls.header.pid'), t('ls.header.since')],
    ...viewers.map((v) => [homeShort(v.repo), String(v.port), v.url, String(v.pid), formatSince(v.startedAt)]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '));
}

function cmdLs(positionals: string[]): number {
  if (positionals.length > 0) fail(t('ls.noArgs'));
  const viewers = listViewers();
  if (viewers.length === 0) {
    out(t('common.noViewers'));
    return 0;
  }
  for (const line of viewersTable(viewers)) out(line);
  return 0;
}

/** The repo of the cwd (git root), or undefined when the cwd cannot be resolved. Silent. */
function cwdRepo(): string | undefined {
  try {
    return resolveRepoRoot(undefined).root;
  } catch {
    return undefined;
  }
}

async function cmdOpen(positionals: string[]): Promise<number> {
  let target: ViewerEntry | undefined;
  if (positionals[0] !== undefined) {
    const repo = resolveRepo(positionals[0]);
    target = viewerForRepo(repo);
    if (!target) fail(t('open.noViewer', { repo, arg: shellArg(repo) }));
  }
  const viewers = target ? [] : listViewers();
  if (!target) {
    // Like `stop`: the viewer of the repo you are in. Otherwise the only one running.
    const here = cwdRepo();
    target = here === undefined ? undefined : viewerForRepo(here, viewers);
  }
  if (!target) {
    if (viewers.length === 0) fail(t('open.noneRunning'));
    if (viewers.length > 1) {
      out(t('open.several'));
      out('');
      for (const line of viewersTable(viewers)) out(`  ${line}`);
      out('');
      out(t('open.pick'));
      return 1;
    }
    target = viewers[0]!;
  }
  out(t('open.opening', { url: target.url, repo: homeShort(target.repo) }));
  return (await openBrowser(target.url)) ? 0 : 1;
}

/**
 * The cleanup a viewer that died without running its own does at exit: registry entry,
 * lock, hooks and bashEditDiffEnabled. After SIGKILL, and on Windows after any stop.
 */
function cleanupAfterKill(target: StopTarget & { repo: string }, info: string[], warn: string[]): boolean {
  try {
    removeViewerEntry(target.pid);
    const lock = readLock(target.repo);
    if (lock && lock.pid === target.pid && !lock.alive) fs.rmSync(lockPath(target.repo), { force: true });
    const u = undoInstall(target.repo);
    info.push(u.hooksChanged ? t('common.hooksRemoved') : t('common.noHooks'));
    const msg = bashDiffMessages(u.bashDiff);
    info.push(...msg.info);
    warn.push(...msg.warn);
    return msg.warn.length === 0;
  } catch (e) {
    warn.push(t('common.uninstallFailed', { error: (e as Error).message }), t('common.runUninstallRepo', { repo: shellArg(target.repo) }));
    return false;
  }
}

/** Stops one viewer and returns what to print. `ok` false makes `stop` exit 1. */
async function stopOne(target: StopTarget & { repo: string }, force: boolean): Promise<{ ok: boolean; info: string[]; warn: string[] }> {
  const where = `${homeShort(target.repo)} (PID ${target.pid})`;
  const r = await stopViewer(target, { force });
  switch (r.status) {
    case 'stopped': {
      if (process.platform === 'win32') {
        // process.kill() is TerminateProcess on Windows: the viewer ran no cleanup.
        const info = [t('stop.terminatedWin', { where })];
        const warn: string[] = [];
        return { ok: cleanupAfterKill(target, info, warn), info, warn };
      }
      // The viewer removes its hooks before exiting; leftovers mean its cleanup failed.
      const info = [t('stop.closed', { where })];
      const lock = readLock(target.repo);
      if (readManifest(target.repo) && !lock?.alive) {
        return { ok: false, info, warn: [t('stop.leftHooks', { repo: target.repo, arg: shellArg(target.repo) })] };
      }
      return { ok: true, info, warn: [] };
    }
    case 'timeout':
      return {
        ok: false,
        info: [],
        warn: [t('stop.timeout', { where, seconds: STOP_TIMEOUT_MS / 1000 }), t('stop.timeoutHint', { arg: shellArg(target.repo) })],
      };
    case 'killed': {
      const info = [t('stop.killed', { where })];
      const warn: string[] = [];
      return { ok: cleanupAfterKill(target, info, warn), info, warn };
    }
    case 'not-viewer':
      return { ok: false, info: [], warn: [t('stop.notViewer', { pid: target.pid, repo: homeShort(target.repo) })] };
    case 'error':
      return { ok: false, info: [], warn: [t('stop.error', { where, error: r.message })] };
  }
}

async function cmdStop(positionals: string[], o: Options): Promise<number> {
  let targets: Array<StopTarget & { repo: string }>;
  if (o.all) {
    if (positionals.length > 0) fail(t('stop.allNoArgs'));
    targets = listViewers().map((v) => ({ pid: v.pid, cmd: v.cmd, startedAt: v.startedAt, repo: v.repo, ...(v.command ? { command: v.command } : {}) }));
    if (targets.length === 0) {
      out(t('common.noViewers'));
      return 0;
    }
  } else {
    const repo = resolveRepo(positionals[0]);
    const v = viewerForRepo(repo) ?? viewerFromLock(repo);
    if (!v) {
      out(t('common.noViewer', { repo }));
      return 1;
    }
    targets = [{ pid: v.pid, cmd: v.cmd, startedAt: v.startedAt, repo, ...(v.command ? { command: v.command } : {}) }];
  }
  if (targets.length > 1) out(t('stop.closing', { count: targets.length }));
  // In parallel: each one may take up to STOP_TIMEOUT_MS.
  const results = await Promise.all(targets.map((t) => stopOne(t, o.force)));
  for (const r of results) {
    for (const line of r.info) out(line);
    for (const line of r.warn) err(line);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

// ---------------------------------------------------------------- main

function isDirectoryArg(p: string): boolean {
  try {
    return fs.statSync(path.resolve(p)).isDirectory();
  } catch {
    return false;
  }
}

function isFileArg(p: string): boolean {
  try {
    return fs.statSync(path.resolve(p)).isFile();
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  // Before routing, so its own errors come out in the chosen language too.
  setLang(detectLang(argv));
  const r = route(argv, isDirectoryArg, isFileArg);
  if (r.kind === 'version') {
    out(version());
    return 0;
  }
  if (r.kind === 'help') {
    out(help());
    return 0;
  }
  switch (r.command) {
    case 'start':
      return cmdStart(r.positionals, r.opts);
    case 'install':
      return cmdInstall(r.positionals, r.opts);
    case 'uninstall':
      return cmdUninstall(r.positionals);
    case 'replay':
      return cmdReplay(r.positionals, r.opts);
    case 'doctor':
      return cmdDoctor(r.positionals);
    case 'ls':
      return cmdLs(r.positionals);
    case 'open':
      return cmdOpen(r.positionals);
    case 'stop':
      return cmdStop(r.positionals, r.opts);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    err(e instanceof CliError ? e.message : t('common.error', { error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  },
);
