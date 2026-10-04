// Installs and removes Neurons' HTTP hooks in <repo>/.claude/settings.local.json,
// toggles bashEditDiffEnabled in the user settings, and inspects the environment
// for `doctor`.
//
// Rules (docs/IMPLEMENTATION_PLAN.md §8):
// - Our hooks are identified by the exact URL http://127.0.0.1:<port>/hook?src=neurons.
//   The exact URL of the versions named repo-synapse (?src=repo-synapse) is ours too and
//   is removed by every install and uninstall. Foreign hooks are never touched, even when
//   they point at the same host and port.
// - An install left by a repo-synapse version (<repo>/.repo-synapse/install.json) is undone
//   the way that version would have done it before anything else is written.
// - The original bytes are backed up before the first write and restored when, after
//   removing our hooks, the content is the same as the backup.
// - Invalid JSON aborts: we never overwrite a file we could not parse.
// - Writes are atomic (temp file + rename) and follow symlinks to their target.
//
// The work is synchronous on purpose: the CLI must be able to undo it from an
// `exit` handler. The async exports are thin wrappers kept for the public API.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT, HOOK_QUERY_MARKER, LEGACY_STATE_DIR_NAME, STATE_DIR_NAME } from '../shared/types.ts';
import { t, tn } from '../i18n.ts';

// ---------------------------------------------------------------- constants

/** Hook events we subscribe to (plan §8). SessionStart/Setup do not accept http hooks. */
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'InstructionsLoaded',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
] as const;

export const HOOK_TIMEOUT_S = 2;
export const STATE_DIR = STATE_DIR_NAME;
/** State dir of the versions named repo-synapse (<= 0.1.0): only migrated and cleaned. */
export const LEGACY_STATE_DIR = LEGACY_STATE_DIR_NAME;
export const LOCAL_SETTINGS_REL = path.join('.claude', 'settings.local.json');
export const EXCLUDE_ENTRIES = ['.claude/settings.local.json', `${STATE_DIR}/`] as const;
/** Names of the CLI bin, current and legacy (see lockStatus). */
export const BIN_NAMES = ['neu', 'neurons', 'repo-synapse'] as const;

// Exact URLs only: a prefix would also match other tools' hooks (docs/DECISIONS.md I2).
const OWN_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/hook\?src=neurons$/;
const LEGACY_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/hook\?src=repo-synapse$/;
const MIN_NODE: [number, number] = [22, 12];

// ---------------------------------------------------------------- types

type JsonObject = { [k: string]: unknown };

/** Previous state of bashEditDiffEnabled in the user settings. */
export interface BashDiffPrevious {
  /** Whether the key existed. */
  present: boolean;
  /** Its value when present (never `true`: then we do not touch it). */
  value?: unknown;
}

export interface InstallManifest {
  version: 1;
  /** settings.local.json did not exist before the first install. */
  createdFile: boolean;
  /** .claude/ did not exist before the first install. */
  createdClaudeDir: boolean;
  /** ISO date of the backup, or null when there was nothing to back up. */
  backedUpAt: string | null;
  port: number;
}

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'info' | 'warn' | 'error';
  /** One line, in the CLI language (src/i18n). */
  message: string;
}

export interface SettingsSourceInfo {
  scope: 'managed' | 'user' | 'project' | 'local';
  path: string;
  exists: boolean;
  /** false when the file exists but is not valid JSON. */
  valid: boolean;
}

export interface DoctorReport {
  repoRoot: string;
  nodeVersion: string;
  nodeOk: boolean;
  sources: SettingsSourceInfo[];
  /** Ports of our hooks currently in settings.local.json (empty = not installed). */
  installedPorts: number[];
  /** Ports of hooks left by a repo-synapse version (removed by the next start/install/uninstall). */
  legacyPorts: number[];
  manifest: InstallManifest | null;
  lock: { pid: number; alive: boolean } | null;
  checks: DoctorCheck[];
}

// ---------------------------------------------------------------- small helpers

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hook?${HOOK_QUERY_MARKER}`;
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function httpUrlMatches(h: unknown, re: RegExp): boolean {
  if (!isPlainObject(h)) return false;
  return h.type === 'http' && typeof h.url === 'string' && re.test(h.url);
}

/** A hook installed by this version (exact URL, `?src=neurons`). */
export function isOwnHook(h: unknown): boolean {
  return httpUrlMatches(h, OWN_URL_RE);
}

/** A hook installed by a repo-synapse version (exact URL, `?src=repo-synapse`). */
export function isLegacyHook(h: unknown): boolean {
  return httpUrlMatches(h, LEGACY_URL_RE);
}

/** Ours to remove: current or legacy. */
function isRemovableHook(h: unknown): boolean {
  return isOwnHook(h) || isLegacyHook(h);
}

function hookPort(h: unknown, match: (h: unknown) => boolean): number | undefined {
  if (!match(h)) return undefined;
  const m = /:(\d+)\/hook/.exec((h as { url: string }).url);
  return m?.[1] ? Number(m[1]) : undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Parses a settings file. Blank file = {}. Throws a translated error on invalid JSON or a non-object. */
function parseSettings(raw: string, file: string): JsonObject {
  const text = stripBom(raw);
  if (text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(t('settings.invalidJson', { file, error: (err as Error).message }));
  }
  if (!isPlainObject(v)) throw new Error(t('settings.notObject', { file }));
  return v;
}

function readBytes(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function serialize(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n';
}

/**
 * Atomic write: temp file in the same dir + rename. Follows a symlinked target and keeps
 * its mode; `newMode` applies only when the target does not exist yet.
 */
export function writeFileAtomic(file: string, data: string | Buffer, newMode?: number): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    /* does not exist yet */
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.statSync(target, { throwIfNoEntry: false })?.mode;
  const mode = existing === undefined ? newMode : existing & 0o777;
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? {} : { mode });
    renameWithRetry(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * fs.renameSync, retried for a moment on Windows: replacing a file another process has
 * open (Claude Code reading settings.local.json, an antivirus scan) fails there with
 * EPERM, EACCES or EBUSY until that handle closes.
 */
function renameWithRetry(from: string, to: string, platform: NodeJS.Platform = process.platform): void {
  const deadline = Date.now() + (platform === 'win32' ? 2000 : 0);
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') || Date.now() + wait > deadline) throw err;
      sleepSync(wait);
    }
  }
}

// ---------------------------------------------------------------- pure merge / unmerge

function hooksObjectOf(settings: JsonObject): JsonObject | undefined {
  const hooks = settings.hooks;
  if (hooks === undefined) return undefined;
  if (!isPlainObject(hooks)) throw new Error(t('settings.hooksNotObject'));
  return hooks;
}

/**
 * Removes our hook objects, current and legacy (mutates `settings`). `groups`: drop groups that became
 * empty because of that removal. `containers`: also drop event arrays and the
 * "hooks" object that became empty because of it. Containers that were already
 * empty are never dropped. Returns the number of hooks removed.
 */
function stripOwn(settings: JsonObject, prune: { groups: boolean; containers: boolean }, remove: (h: unknown) => boolean = isRemovableHook): number {
  const hooks = hooksObjectOf(settings);
  if (!hooks) return 0;
  let removed = 0;
  let emptiedEvent = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const left: unknown[] = [];
    let droppedGroup = false;
    for (const g of groups as unknown[]) {
      if (isPlainObject(g) && Array.isArray(g.hooks)) {
        const before = g.hooks.length;
        const kept = g.hooks.filter((h) => !remove(h));
        if (kept.length !== before) {
          removed += before - kept.length;
          g.hooks = kept;
          if (prune.groups && kept.length === 0) {
            droppedGroup = true;
            continue;
          }
        }
      }
      left.push(g);
    }
    if (!droppedGroup) continue;
    if (left.length === 0 && prune.containers) {
      delete hooks[event];
      emptiedEvent = true;
    } else {
      hooks[event] = left;
    }
  }
  if (prune.containers && emptiedEvent && Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

/**
 * Pure. Our hooks (current and legacy) removed, containers emptied by that removal dropped.
 * Foreign entries untouched. `keepLegacy`: leave the repo-synapse hooks in place (one of
 * its viewers is still running and receives events through them).
 */
export function removeOwnHooks(settings: object, o: { keepLegacy?: boolean } = {}): object {
  const out = clone(settings) as JsonObject;
  stripOwn(out, { groups: true, containers: true }, o.keepLegacy ? isOwnHook : isRemovableHook);
  return out;
}

/**
 * Pure. Removes our previous entries (any port, current and legacy) and appends one group per event,
 * without matcher, pointing at `port`. Existing keys keep their order; new event
 * keys are appended in HOOK_EVENTS order, and "hooks" at the end when missing.
 */
export function mergeHooks(settings: object, port: number): object {
  const out = clone(settings) as JsonObject;
  stripOwn(out, { groups: true, containers: false });
  const hooks = hooksObjectOf(out) ?? {};
  for (const event of HOOK_EVENTS) {
    const cur = hooks[event];
    if (cur !== undefined && !Array.isArray(cur)) {
      throw new Error(t('settings.eventNotList', { event }));
    }
    const group = { hooks: [{ type: 'http', url: hookUrl(port), timeout: HOOK_TIMEOUT_S }] };
    hooks[event] = [...(cur ?? []), group];
  }
  out.hooks = hooks;
  return out;
}

/** Our hooks removed and every empty group/array/hooks object dropped: used only to compare. */
function canonical(settings: JsonObject, remove: (h: unknown) => boolean = isRemovableHook): JsonObject {
  const out = clone(settings);
  stripOwn(out, { groups: true, containers: true }, remove);
  const hooks = out.hooks;
  if (isPlainObject(hooks)) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const left = groups.filter((g) => !(isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
      if (left.length === 0) delete hooks[event];
      else hooks[event] = left;
    }
    if (Object.keys(hooks).length === 0) delete out.hooks;
  }
  return out;
}

function hookPorts(settings: JsonObject, match: (h: unknown) => boolean): number[] {
  const ports = new Set<number>();
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        const p = hookPort(h, match);
        if (p !== undefined) ports.add(p);
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- repo paths and manifest

export function localSettingsPath(repoRoot: string): string {
  return path.join(repoRoot, LOCAL_SETTINGS_REL);
}

export function stateDir(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR);
}

/** <repo>/.repo-synapse: the state dir of the versions named repo-synapse. */
export function legacyStateDir(repoRoot: string): string {
  return path.join(repoRoot, LEGACY_STATE_DIR);
}

// The helpers below take a state dir (current or legacy): both versions use the same layout.

function manifestPath(dir: string): string {
  return path.join(dir, 'install.json');
}

function backupPath(dir: string): string {
  return path.join(dir, 'settings.local.json.bak');
}

/** Where early repo-synapse builds kept the user settings backup (inside the repo). Only removed now. */
function legacyUserBackupPath(repoRoot: string): string {
  return path.join(legacyStateDir(repoRoot), 'user-settings.bak');
}

export function lockPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), 'lock');
}

/** The lock of a repo-synapse version running on the repo. Only read (and removed when stale). */
export function legacyLockPath(repoRoot: string): string {
  return path.join(legacyStateDir(repoRoot), 'lock');
}

function readManifestIn(dir: string): InstallManifest | null {
  const raw = readBytes(manifestPath(dir));
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    return isPlainObject(v) ? (v as unknown as InstallManifest) : null;
  } catch {
    return null;
  }
}

export function readManifest(repoRoot: string): InstallManifest | null {
  return readManifestIn(stateDir(repoRoot));
}

/** The manifest an install by a repo-synapse version left behind, or null. */
export function readLegacyManifest(repoRoot: string): InstallManifest | null {
  return readManifestIn(legacyStateDir(repoRoot));
}

function writeManifest(repoRoot: string, m: InstallManifest): void {
  writeFileAtomic(manifestPath(stateDir(repoRoot)), serialize(m));
}

/** Merges fields into an existing manifest. No-op when there is none (hooks not installed). */
export function updateManifest(repoRoot: string, patch: Partial<InstallManifest>): boolean {
  const m = readManifest(repoRoot);
  if (!m) return false;
  writeManifest(repoRoot, { ...m, ...patch });
  return true;
}

// ---------------------------------------------------------------- git exclude

function git(repoRoot: string, args: string[], input?: string): { code: number; out: string } {
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(input === undefined ? {} : { input }),
    });
    return { code: 0, out };
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    return { code: typeof status === 'number' ? status : -1, out: '' };
  }
}

/**
 * Adds `.claude/settings.local.json` and `.neurons/` to .git/info/exclude when
 * git does not ignore them yet. Returns the entries added. Not a git repo -> [].
 */
export function ensureGitExcluded(repoRoot: string): string[] {
  const excl = git(repoRoot, ['rev-parse', '--git-path', 'info/exclude']);
  if (excl.code !== 0 || excl.out.trim() === '') return [];
  const excludeFile = path.resolve(repoRoot, excl.out.trim());
  const prefix = git(repoRoot, ['rev-parse', '--show-prefix']).out.trim();
  const missing: string[] = [];
  for (const entry of EXCLUDE_ENTRIES) {
    // A path under the dir makes check-ignore match a "dir/" pattern.
    const probe = entry.endsWith('/') ? `${entry}probe` : entry;
    const r = git(repoRoot, ['check-ignore', '-q', '--', probe]);
    if (r.code === 1) missing.push(entry);
  }
  if (missing.length === 0) return [];
  const prev = readBytes(excludeFile)?.toString('utf8') ?? '';
  const lines = missing.map((e) => `/${prefix}${e}`);
  const block = `${prev === '' || prev.endsWith('\n') ? '' : '\n'}# neurons\n${lines.join('\n')}\n`;
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(excludeFile, block);
  return missing;
}

// ---------------------------------------------------------------- install / uninstall

export interface InstallResult {
  settingsPath: string;
  /** The settings file did not exist before this call. */
  created: boolean;
  /** .git/info/exclude could not be updated (the hooks are installed anyway). */
  excludeError?: string;
}

export function installHooksSync(o: { repoRoot: string; port: number }): InstallResult {
  // A repo-synapse install still on disk owns the original bytes: put them back first,
  // so the backup taken below is the user's file and not one with that version's hooks.
  undoLegacyInstallSync(o);
  const file = localSettingsPath(o.repoRoot);
  const claudeDir = path.dirname(file);
  const raw = readBytes(file);
  const current = raw ? parseSettings(raw.toString('utf8'), file) : {};
  const merged = mergeHooks(current, o.port);

  const dir = stateDir(o.repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readManifest(o.repoRoot);
  if (existing) {
    // A previous install (maybe a crashed run) owns the backup: keep it.
    writeManifest(o.repoRoot, { ...existing, port: o.port });
  } else {
    if (raw) fs.writeFileSync(backupPath(dir), raw);
    else fs.rmSync(backupPath(dir), { force: true });
    writeManifest(o.repoRoot, {
      version: 1,
      createdFile: raw === undefined,
      createdClaudeDir: !fs.existsSync(claudeDir),
      backedUpAt: raw ? new Date().toISOString() : null,
      port: o.port,
    });
  }
  writeFileAtomic(file, serialize(merged));
  const result: InstallResult = { settingsPath: file, created: raw === undefined };
  // Best effort: a read-only exclude file must not leave the hooks half installed.
  try {
    ensureGitExcluded(o.repoRoot);
  } catch (err) {
    result.excludeError = (err as Error).message;
  }
  return result;
}

export async function installHooks(o: { repoRoot: string; port: number }): Promise<InstallResult> {
  return installHooksSync(o);
}

function removeDirIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* missing or not empty */
  }
}

/**
 * Removes our hooks (current and legacy) and undoes the install recorded in the state dir
 * `dir`: the backup bytes come back when nothing else changed, a file we created is
 * deleted when only our hooks were in it. Without a manifest in `dir` it only strips.
 * `keepLegacy`: a repo-synapse viewer is running on the repo, so its hooks stay (and
 * count as content: a backup without them is not put back over them).
 */
function undoInstallIn(repoRoot: string, dir: string, keepLegacy = false): boolean {
  const file = localSettingsPath(repoRoot);
  const manifest = readManifestIn(dir);
  const raw = readBytes(file);
  const remove = keepLegacy ? isOwnHook : isRemovableHook;
  let changed = false;

  if (raw) {
    const current = parseSettings(raw.toString('utf8'), file);
    const stripped = removeOwnHooks(current, { keepLegacy }) as JsonObject;
    const backup = manifest && !manifest.createdFile ? readBytes(backupPath(dir)) : undefined;
    let backupJson: JsonObject | undefined;
    if (backup) {
      try {
        backupJson = parseSettings(backup.toString('utf8'), 'backup');
      } catch {
        backupJson = undefined;
      }
    }
    // A backup that holds hooks of ours (e.g. a repo-synapse version's, taken without its
    // manifest) cannot be put back byte for byte: it would bring them back.
    const backupClean = backupJson !== undefined && deepEqual(removeOwnHooks(backupJson), backupJson);
    if (backup && backupJson && backupClean && deepEqual(canonical(stripped, remove), canonical(backupJson, remove))) {
      if (!raw.equals(backup)) {
        writeFileAtomic(file, backup);
        changed = true;
      }
    } else if (manifest?.createdFile && Object.keys(canonical(stripped, remove)).length === 0) {
      fs.rmSync(file, { force: true });
      changed = true;
    } else if (!deepEqual(stripped, current)) {
      writeFileAtomic(file, serialize(stripped));
      changed = true;
    }
  }

  if (manifest?.createdClaudeDir && !fs.existsSync(file)) removeDirIfEmpty(path.dirname(file));
  if (manifest) {
    fs.rmSync(backupPath(dir), { force: true });
    fs.rmSync(manifestPath(dir), { force: true });
  }
  return changed;
}

/** A repo-synapse viewer (other than this process) holds a live lock on the repo. */
export function isLegacyViewerRunning(repoRoot: string): boolean {
  const lock = readLegacyLock(repoRoot);
  return lock !== null && lock.alive && lock.pid !== process.pid;
}

/**
 * Undoes an install left by a repo-synapse version (<repo>/.repo-synapse/install.json) the
 * way that version's uninstall would: its backup bytes come back, or the file it created
 * goes away. Its events.jsonl is kept (replay still reads it); a stale lock goes, and the
 * dir too when that leaves it empty. `found`: there was such an install. Nothing is
 * touched while that version's viewer is still running: its exit undoes it.
 */
export function undoLegacyInstallSync(o: { repoRoot: string }): { found: boolean; changed: boolean } {
  const dir = legacyStateDir(o.repoRoot);
  if (!readManifestIn(dir)) return { found: false, changed: false };
  if (isLegacyViewerRunning(o.repoRoot)) return { found: true, changed: false };
  const changed = undoInstallIn(o.repoRoot, dir);
  const lock = readLegacyLock(o.repoRoot);
  if (lock && !lock.alive) fs.rmSync(legacyLockPath(o.repoRoot), { force: true });
  removeDirIfEmpty(dir);
  return { found: true, changed };
}

/**
 * Removes our hooks and undoes our install. While a repo-synapse viewer runs on the repo
 * (started after this one: `start` refuses the other order), its hooks and its install
 * are left alone, so it keeps receiving events and its own exit restores the file.
 */
export function uninstallHooksSync(o: { repoRoot: string }): { changed: boolean } {
  const legacyRunning = isLegacyViewerRunning(o.repoRoot);
  const legacy = undoLegacyInstallSync(o).changed;
  const current = undoInstallIn(o.repoRoot, stateDir(o.repoRoot), legacyRunning);
  return { changed: legacy || current };
}

export async function uninstallHooks(o: { repoRoot: string }): Promise<{ changed: boolean }> {
  return uninstallHooksSync(o);
}

// ---------------------------------------------------------------- user settings: bashEditDiffEnabled

export function claudeConfigDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.claude');
}

export function userSettingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json');
}

// bashEditDiffEnabled is one key in the global user settings, shared by every viewer
// running on any repo. The record of our change lives next to that file (never inside a
// repo): <config dir>/neurons/bash-diff.json lists the viewers that need the key
// (repo + PID) and settings.json.bak holds the original bytes, both mode 0600. The key is
// restored only when the last live viewer releases it, and the record is kept when the
// restore cannot be done yet (invalid JSON, write error) so a later run can retry.
// The versions named repo-synapse kept the same files in <config dir>/repo-synapse/: they
// are moved here by the next enable or restore (migrateLegacyBashDiffState), but only once
// no repo-synapse viewer listed there is alive. Until then enable and restore work on that
// record in place, so the old viewer still sees the new ones as owners and still finds
// its record when it exits.

export interface BashDiffOwner {
  repo: string;
  pid: number;
}

export interface BashDiffState {
  version: 1;
  settingsPath: string;
  previous: BashDiffPrevious;
  owners: BashDiffOwner[];
}

export function bashDiffStateDir(): string {
  return path.join(claudeConfigDir(), 'neurons');
}

/** Where the repo-synapse versions kept the record. Only read, migrated and removed. */
export function legacyBashDiffStateDir(): string {
  return path.join(claudeConfigDir(), 'repo-synapse');
}

function bashDiffStatePath(dir = bashDiffStateDir()): string {
  return path.join(dir, 'bash-diff.json');
}

function bashDiffBackupPath(dir = bashDiffStateDir()): string {
  return path.join(dir, 'settings.json.bak');
}

export function readBashDiffState(): BashDiffState | null {
  return readBashDiffStateAt(bashDiffStatePath());
}

/** The record a repo-synapse version left, not migrated yet. */
export function readLegacyBashDiffState(): BashDiffState | null {
  return readBashDiffStateAt(bashDiffStatePath(legacyBashDiffStateDir()));
}

function readBashDiffStateAt(file: string): BashDiffState | null {
  const raw = readBytes(file);
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    if (!isPlainObject(v) || !isPlainObject(v.previous) || typeof v.settingsPath !== 'string') return null;
    const owners = Array.isArray(v.owners)
      ? v.owners.filter((x): x is BashDiffOwner => isPlainObject(x) && typeof x.repo === 'string' && typeof x.pid === 'number')
      : [];
    return { version: 1, settingsPath: v.settingsPath, previous: v.previous as unknown as BashDiffPrevious, owners };
  } catch {
    return null;
  }
}

function writePrivate(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, data, 0o600);
}

function writeBashDiffState(st: BashDiffState, dir = bashDiffStateDir()): void {
  writePrivate(bashDiffStatePath(dir), serialize(st));
}

function clearBashDiffState(dir = bashDiffStateDir()): void {
  fs.rmSync(bashDiffStatePath(dir), { force: true });
  fs.rmSync(bashDiffBackupPath(dir), { force: true });
  removeDirIfEmpty(dir);
}

function hasLiveOwner(st: BashDiffState): boolean {
  return st.owners.some((x) => isPidAlive(x.pid));
}

/**
 * The dir enable and restore work on: the repo-synapse one while its record is the only
 * one and a viewer listed there is alive (that viewer restores from it on exit), else ours.
 */
function activeBashDiffDir(): string {
  if (readBashDiffState()) return bashDiffStateDir();
  const legacy = readLegacyBashDiffState();
  return legacy && hasLiveOwner(legacy) ? legacyBashDiffStateDir() : bashDiffStateDir();
}

/**
 * Moves a repo-synapse version's record of bashEditDiffEnabled into the current dir, so
 * the last viewer still restores that change. Owners with dead PIDs are dropped. While a
 * repo-synapse viewer listed there is alive the record stays where it is, since that
 * viewer's own exit restores from it (see activeBashDiffDir). When a current record
 * exists too, it is kept and the live legacy owners join it (the legacy record then stays
 * until they are gone). Best effort: on a write error the legacy record stays for the next run.
 */
export function migrateLegacyBashDiffState(): boolean {
  const legacyDir = legacyBashDiffStateDir();
  const legacy = readLegacyBashDiffState();
  if (!legacy) return false;
  const live = legacy.owners.filter((x) => isPidAlive(x.pid));
  const cur = readBashDiffState();
  if (live.length > 0 && !cur) return false;
  try {
    if (cur) {
      const owners = [...cur.owners];
      for (const x of live) if (!owners.some((y) => y.repo === x.repo && y.pid === x.pid)) owners.push(x);
      writeBashDiffState({ ...cur, owners });
    } else {
      const backup = readBytes(bashDiffBackupPath(legacyDir));
      if (backup) writePrivate(bashDiffBackupPath(), backup);
      else fs.rmSync(bashDiffBackupPath(), { force: true });
      writeBashDiffState({ ...legacy, owners: live });
    }
  } catch {
    return false;
  }
  if (live.length > 0) return true;
  fs.rmSync(bashDiffStatePath(legacyDir), { force: true });
  fs.rmSync(bashDiffBackupPath(legacyDir), { force: true });
  removeDirIfEmpty(legacyDir);
  return true;
}

/** Live owners other than `repoRoot` (dead PIDs are crashed runs and are dropped). */
function otherLiveOwners(st: BashDiffState, repoRoot: string): BashDiffOwner[] {
  return st.owners.filter((x) => x.repo !== repoRoot && isPidAlive(x.pid));
}

export interface EnableBashDiffResult {
  changed: boolean;
  previous: BashDiffPrevious;
  settingsPath: string;
  /**
   * Why nothing changed: 'missing' file, 'invalid' JSON, 'already' true by the user,
   * or 'shared' (another viewer turned it on; this one is now registered as a user too).
   */
  reason?: 'missing' | 'invalid' | 'already' | 'shared';
}

/**
 * Sets bashEditDiffEnabled: true in the user settings when it is not already true, and
 * registers `repoRoot` (with `pid`, default this process) as a viewer that needs it.
 * Never creates the settings file. On a write error nothing is left behind and it throws.
 */
export function enableBashEditDiffSync(o: { repoRoot: string; pid?: number }): EnableBashDiffResult {
  migrateLegacyBashDiffState();
  const dir = activeBashDiffDir();
  const file = userSettingsPath();
  const me: BashDiffOwner = { repo: o.repoRoot, pid: o.pid ?? process.pid };
  const raw = readBytes(file);
  if (!raw) return { changed: false, previous: { present: false }, settingsPath: file, reason: 'missing' };
  let cur: JsonObject;
  try {
    cur = parseSettings(raw.toString('utf8'), file);
  } catch {
    return { changed: false, previous: { present: false }, settingsPath: file, reason: 'invalid' };
  }

  const st = readBashDiffStateAt(bashDiffStatePath(dir));
  if (st) {
    // Our change is already in place (another viewer, or a run that crashed): share it.
    if (cur.bashEditDiffEnabled !== true) {
      cur.bashEditDiffEnabled = true;
      writeFileAtomic(file, serialize(cur));
    }
    writeBashDiffState({ ...st, owners: [...otherLiveOwners(st, o.repoRoot), me] }, dir);
    return { changed: false, previous: st.previous, settingsPath: file, reason: 'shared' };
  }

  const present = Object.hasOwn(cur, 'bashEditDiffEnabled');
  const previous: BashDiffPrevious = present ? { present, value: cur.bashEditDiffEnabled } : { present };
  if (cur.bashEditDiffEnabled === true) return { changed: false, previous, settingsPath: file, reason: 'already' };
  try {
    writePrivate(bashDiffBackupPath(), raw);
    writeBashDiffState({ version: 1, settingsPath: file, previous, owners: [me] });
    cur.bashEditDiffEnabled = true;
    writeFileAtomic(file, serialize(cur));
  } catch (err) {
    clearBashDiffState();
    throw err;
  }
  return { changed: true, previous, settingsPath: file };
}

export async function enableBashEditDiff(o: { repoRoot: string; pid?: number }): Promise<EnableBashDiffResult> {
  return enableBashEditDiffSync(o);
}

export interface RestoreBashDiffResult {
  /** The user settings file was written. */
  changed: boolean;
  /**
   * none: there was no change of ours to undo. in-use: other live viewers still need it.
   * restored: done. untouched: the key was gone or no longer true (someone changed it).
   * pending: could not restore now (invalid JSON, write error); the record is kept.
   */
  status: 'none' | 'in-use' | 'restored' | 'untouched' | 'pending';
  settingsPath?: string;
  /** Translated reason when status is 'pending'. */
  error?: string;
}

/**
 * Releases `repoRoot`'s use of bashEditDiffEnabled. When no other live viewer needs it,
 * puts back the previous value (the exact original bytes when that is the only
 * difference). Only acts while the key is still `true`. Never creates the file.
 */
export function restoreBashEditDiffSync(o: { repoRoot: string }): RestoreBashDiffResult {
  fs.rmSync(legacyUserBackupPath(o.repoRoot), { force: true });
  migrateLegacyBashDiffState();
  const dir = activeBashDiffDir();
  const st = readBashDiffStateAt(bashDiffStatePath(dir));
  if (!st) return { changed: false, status: 'none' };
  const others = otherLiveOwners(st, o.repoRoot);
  if (others.length > 0) {
    writeBashDiffState({ ...st, owners: others }, dir);
    return { changed: false, status: 'in-use', settingsPath: st.settingsPath };
  }
  const file = st.settingsPath;
  const keep = (error: string): RestoreBashDiffResult => {
    writeBashDiffState({ ...st, owners: [] }, dir);
    return { changed: false, status: 'pending', settingsPath: file, error };
  };

  const raw = readBytes(file);
  if (!raw) {
    clearBashDiffState(dir);
    return { changed: false, status: 'untouched', settingsPath: file };
  }
  let cur: JsonObject;
  try {
    cur = parseSettings(raw.toString('utf8'), file);
  } catch {
    return keep(t('settings.restoreInvalid', { file }));
  }
  if (cur.bashEditDiffEnabled !== true) {
    clearBashDiffState(dir);
    return { changed: false, status: 'untouched', settingsPath: file };
  }
  if (st.previous.present) cur.bashEditDiffEnabled = st.previous.value;
  else delete cur.bashEditDiffEnabled;

  let data: string | Buffer = serialize(cur);
  const backup = readBytes(bashDiffBackupPath(dir));
  if (backup) {
    try {
      if (deepEqual(parseSettings(backup.toString('utf8'), 'backup'), cur)) data = backup;
    } catch {
      /* unreadable backup: write the serialized object */
    }
  }
  try {
    writeFileAtomic(file, data);
  } catch (err) {
    return keep((err as Error).message);
  }
  clearBashDiffState(dir);
  return { changed: true, status: 'restored', settingsPath: file };
}

export async function restoreBashEditDiff(o: { repoRoot: string }): Promise<RestoreBashDiffResult> {
  return restoreBashEditDiffSync(o);
}

// ---------------------------------------------------------------- lock

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Slack for the 1 s resolution of `ps -o etime` and for clock jitter. */
export const LOCK_START_SLACK_MS = 5000;

/** What Windows reports about a process: start time (epoch ms) and command line. */
interface Win32ProcessInfo {
  startMs?: number;
  command?: string;
}

const win32InfoCache = new Map<number, { at: number; info: Win32ProcessInfo | undefined }>();

/**
 * Windows has no `ps`: the start time and command line come from WMI (Win32_Process)
 * through PowerShell, one call for both, remembered for a second (isNeuronsViewer asks for
 * both in a row). undefined when PowerShell is missing or the process is gone.
 */
export function win32ProcessInfo(pid: number): Win32ProcessInfo | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const cached = win32InfoCache.get(pid);
  if (cached && Date.now() - cached.at < 1000) return cached.info;
  let info: Win32ProcessInfo | undefined;
  try {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
      `if ($p) { [Console]::Out.WriteLine($p.CreationDate.ToUniversalTime().ToString('o')); [Console]::Out.WriteLine($p.CommandLine) }`;
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    info = parseWin32ProcessInfo(text);
  } catch {
    info = undefined;
  }
  win32InfoCache.set(pid, { at: Date.now(), info });
  return info;
}

/** Parses win32ProcessInfo's output: an ISO start time line, then the command line. */
export function parseWin32ProcessInfo(text: string): Win32ProcessInfo | undefined {
  const [first = '', ...rest] = text.replace(/\r/g, '').split('\n');
  const startMs = Date.parse(first.trim());
  const command = rest.join('\n').trim();
  if (!Number.isFinite(startMs) && command === '') return undefined;
  const info: Win32ProcessInfo = {};
  if (Number.isFinite(startMs)) info.startMs = startMs;
  if (command !== '') info.command = command;
  return info;
}

/**
 * When `pid` started (epoch ms), from `ps -o etime=` ([[dd-]hh:]mm:ss, locale independent),
 * or from WMI on Windows. undefined when it cannot be known (no ps, process gone).
 */
export function processStartMs(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'win32') return win32ProcessInfo(pid)?.startMs;
  const now = Date.now();
  let text: string;
  try {
    text = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!m) return undefined;
  const [days, hours, mins, secs] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number];
  return now - (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

/** Command line of `pid` (`ps -o command=`, WMI on Windows), undefined when it cannot be read. */
export function processCommand(pid: number): string | undefined {
  if (process.platform === 'win32') return win32ProcessInfo(pid)?.command;
  try {
    const text = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

let ownCommandCache: string | null | undefined;

/** This process's own `ps` command line (cached), recorded in the lock and the registry. */
export function ownCommand(): string | undefined {
  if (ownCommandCache === undefined) ownCommandCache = processCommand(process.pid) ?? null;
  return ownCommandCache ?? undefined;
}

export interface LockInfo {
  pid: number;
  alive: boolean;
}

/**
 * True when the process `pid` started no later than `startedAt` (plus the slack): it can
 * be the process that wrote a record at that time. False when unknown (no ps).
 */
export function startedBy(pid: number, startedAt: string): boolean {
  const t = Date.parse(startedAt);
  const procStart = processStartMs(pid);
  return Number.isFinite(t) && procStart !== undefined && procStart <= t + LOCK_START_SLACK_MS;
}

/**
 * True when the `ps` command line `actual` is the one a record names: `command`, the
 * exact line the owner saw for itself, when the record has it; else one that runs the
 * script `cmd` (commandRunsScript).
 */
export function commandMatches(actual: string, rec: { cmd?: string; command?: string }): boolean {
  if (rec.command !== undefined && rec.command !== '') return actual === rec.command;
  return rec.cmd !== undefined && rec.cmd !== '' && commandRunsScript(actual, rec.cmd);
}

/**
 * Parses a lock's bytes ({"pid":N,"startedAt":ISO,"cmd":script,"command":psLine} or a
 * bare number). `alive` also requires the process to be the lock's owner: a PID reused
 * after a crash or a reboot belongs to a process that started after the lock was written.
 * A process whose command line is still the lock's (commandMatches) is taken as the owner
 * anyway, since a wall-clock step after start (NTP, VM resume) also moves the start time
 * `ps` reports. That fallback is for liveness only: signals require startedBy too (see
 * isNeuronsViewer). Locks written by a repo-synapse version have the same format.
 */
export function lockStatus(raw: Buffer): LockInfo {
  const text = raw.toString('utf8').trim();
  let pid = Number.NaN;
  let startedAt = Number.NaN;
  let cmd: string | undefined;
  let recorded: string | undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === 'number') pid = v;
    else if (isPlainObject(v) && typeof v.pid === 'number') {
      pid = v.pid;
      if (typeof v.startedAt === 'string') startedAt = Date.parse(v.startedAt);
      if (typeof v.cmd === 'string' && v.cmd.length > 0) cmd = v.cmd;
      if (typeof v.command === 'string' && v.command.length > 0) recorded = v.command;
    }
  } catch {
    pid = Number.parseInt(text, 10);
  }
  if (!Number.isInteger(pid)) return { pid: 0, alive: false };
  if (!isPidAlive(pid)) return { pid, alive: false };
  if (pid !== process.pid && Number.isFinite(startedAt)) {
    const procStart = processStartMs(pid);
    if (procStart !== undefined && procStart > startedAt + LOCK_START_SLACK_MS) {
      if (cmd === undefined && recorded === undefined) return { pid, alive: false };
      const command = processCommand(pid);
      const alive = command !== undefined && commandMatches(command, { cmd, command: recorded });
      return { pid, alive };
    }
  }
  return { pid, alive: true };
}

/**
 * True when the `ps` command line `command` runs the lock's script `cmd`: that path, or,
 * when `cmd` is one of the CLI's bins (BIN_NAMES), any of them in the same directory, so
 * a lock written through `repo-synapse` or `neurons` still matches a run through `neu`.
 * The path must be a whole argument (whitespace or the line's ends around it): a longer
 * path that starts with it (`/usr/local/bin/neutron`, `cli.js.bak`) is another program.
 */
export function commandRunsScript(command: string, cmd: string): boolean {
  if (hasArgument(command, cmd)) return true;
  if (!(BIN_NAMES as readonly string[]).includes(path.basename(cmd))) return false;
  const dir = path.dirname(cmd);
  return BIN_NAMES.some((name) => hasArgument(command, path.join(dir, name)));
}

/**
 * `arg` appears in the command line `command` as a whole argument: whitespace or the
 * line's ends around it, or double quotes (Windows command lines quote paths with spaces).
 */
function hasArgument(command: string, arg: string): boolean {
  if (arg === '') return false;
  for (let i = command.indexOf(arg); i !== -1; i = command.indexOf(arg, i + 1)) {
    const before = i === 0 ? ' ' : command.charAt(i - 1);
    const after = i + arg.length >= command.length ? ' ' : command.charAt(i + arg.length);
    if ((/\s/.test(before) && /\s/.test(after)) || (before === '"' && after === '"')) return true;
  }
  return false;
}

/** Reads <repo>/.neurons/lock; null when there is none. See lockStatus. */
export function readLock(repoRoot: string): LockInfo | null {
  const raw = readBytes(lockPath(repoRoot));
  return raw ? lockStatus(raw) : null;
}

/** Reads <repo>/.repo-synapse/lock (a repo-synapse version's viewer); null when there is none. */
export function readLegacyLock(repoRoot: string): LockInfo | null {
  const raw = readBytes(legacyLockPath(repoRoot));
  return raw ? lockStatus(raw) : null;
}

/**
 * Creates `file` only if it does not exist, with its full content in place from the first
 * instant (temp file + hard link), so a racing reader never sees it empty or partial.
 */
function createExclusive(file: string, data: string): boolean {
  const tmpFile = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpFile, data, { flag: 'wx' });
  try {
    fs.linkSync(tmpFile, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // No hard links on this file system: fall back to an exclusive create.
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** A takeover guard older than this, or whose PID is gone, was left by a crash. */
const TAKEOVER_GUARD_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Removes a stale lock, but only while it still holds `expected`. Takeovers are serialized
 * behind an exclusive guard file: holding it, nobody else can remove the lock, and nobody
 * can create one while the stale one is there, so the check and the removal cannot be
 * interleaved with another start's. A fresh lock is never moved or deleted.
 */
function removeStaleLock(file: string, expected: Buffer): 'removed' | 'changed' | 'busy' {
  const guard = `${file}.takeover`;
  if (!createExclusive(guard, JSON.stringify({ pid: process.pid }) + '\n')) {
    clearCrashedGuard(guard);
    return 'busy';
  }
  try {
    const current = readBytes(file);
    if (!current || !current.equals(expected)) return 'changed';
    fs.rmSync(file, { force: true });
    return 'removed';
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

/** Deletes a takeover guard whose holder died inside its (microseconds long) critical section. */
function clearCrashedGuard(guard: string): void {
  let st: fs.Stats;
  let raw: Buffer | undefined;
  try {
    st = fs.statSync(guard);
    raw = readBytes(guard);
  } catch {
    return;
  }
  let pid = 0;
  try {
    const v: unknown = JSON.parse(raw?.toString('utf8') ?? '');
    if (isPlainObject(v) && typeof v.pid === 'number') pid = v.pid;
  } catch {
    /* unreadable: judged by age alone */
  }
  const crashed = (pid > 0 && !isPidAlive(pid)) || Date.now() - st.mtimeMs > TAKEOVER_GUARD_STALE_MS;
  if (crashed) fs.rmSync(guard, { force: true });
}

export type LockAcquireResult =
  | { ok: true; /** PID of the stale lock that was replaced. */ tookOver?: number }
  | { ok: false; reason: 'live'; pid: number }
  | { ok: false; reason: 'busy' };

/**
 * Takes <repo>/.neurons/lock for this process. A stale lock (dead PID, or a PID
 * reused by a process that is not its owner) is taken over; any number of starts racing
 * on it end with exactly one owner. `busy`: other starts kept the lock in flux until
 * `timeoutMs`.
 */
export function acquireLockSync(repoRoot: string, o: { timeoutMs?: number } = {}): LockAcquireResult {
  fs.mkdirSync(stateDir(repoRoot), { recursive: true });
  const file = lockPath(repoRoot);
  const own: Record<string, unknown> = { pid: process.pid, startedAt: new Date().toISOString() };
  if (process.argv[1]) own.cmd = process.argv[1];
  const command = ownCommand();
  if (command) own.command = command;
  const data = JSON.stringify(own) + '\n';
  const deadline = Date.now() + (o.timeoutMs ?? 3000);
  let tookOver: number | undefined;
  for (;;) {
    if (createExclusive(file, data)) return tookOver === undefined ? { ok: true } : { ok: true, tookOver };
    const raw = readBytes(file);
    let wait = false;
    if (raw) {
      const lock = lockStatus(raw);
      if (lock.alive && lock.pid !== process.pid) return { ok: false, reason: 'live', pid: lock.pid };
      const r = removeStaleLock(file, raw);
      if (r === 'removed') tookOver = lock.pid;
      wait = r === 'busy';
    }
    if (Date.now() > deadline) return { ok: false, reason: 'busy' };
    if (wait) sleepSync(5 + Math.floor(Math.random() * 10));
  }
}

// ---------------------------------------------------------------- doctor

function managedSettingsPath(): string | undefined {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'linux') return '/etc/claude-code/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return undefined;
}

function nodeVersionOk(v: string): boolean {
  const [maj = 0, min = 0] = v.replace(/^v/, '').split('.').map(Number);
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

/** `*` matches any run of characters; everything else is literal. */
export function urlPatternMatches(pattern: string, url: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(url);
}

/** True when NO_PROXY makes 127.0.0.1 bypass the proxy. */
export function noProxyCovers(noProxy: string | undefined, host = '127.0.0.1'): boolean {
  if (!noProxy) return false;
  return noProxy
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((e) => {
      if (e === '*' || e === host) return true;
      const noPort = e.replace(/:\d+$/, '');
      if (noPort === host) return true;
      if (/^127\.0\.0\.0\/(8|16|24)$/.test(noPort) || noPort === '127.0.0.1/32') return true;
      return false;
    });
}

export function checkEnvironmentSync(repoRoot: string): DoctorReport {
  const checks: DoctorCheck[] = [];
  const nodeVersion = process.version;
  const nodeOk = nodeVersionOk(nodeVersion);
  checks.push({
    id: 'node',
    status: nodeOk ? 'ok' : 'error',
    message: nodeOk ? `Node ${nodeVersion}` : t('doctor.node.old', { version: nodeVersion, min: `${MIN_NODE[0]}.${MIN_NODE[1]}` }),
  });

  const specs: Array<{ scope: SettingsSourceInfo['scope']; path: string | undefined }> = [
    { scope: 'managed', path: managedSettingsPath() },
    { scope: 'user', path: userSettingsPath() },
    { scope: 'project', path: path.join(repoRoot, '.claude', 'settings.json') },
    { scope: 'local', path: localSettingsPath(repoRoot) },
  ];
  const scopeName = (scope: SettingsSourceInfo['scope']): string => t(`doctor.scope.${scope}`);
  const sources: SettingsSourceInfo[] = [];
  const parsed: Array<{ scope: SettingsSourceInfo['scope']; path: string; json: JsonObject }> = [];
  for (const s of specs) {
    if (!s.path) continue;
    let raw: Buffer | undefined;
    try {
      raw = readBytes(s.path);
    } catch {
      raw = undefined;
    }
    if (!raw) {
      sources.push({ scope: s.scope, path: s.path, exists: false, valid: true });
      continue;
    }
    try {
      const json = parseSettings(raw.toString('utf8'), s.path);
      sources.push({ scope: s.scope, path: s.path, exists: true, valid: true });
      parsed.push({ scope: s.scope, path: s.path, json });
    } catch {
      sources.push({ scope: s.scope, path: s.path, exists: true, valid: false });
      checks.push({
        id: `json-${s.scope}`,
        status: s.scope === 'local' ? 'error' : 'warn',
        message: t('doctor.json.invalid', { scope: scopeName(s.scope), path: s.path }),
      });
    }
  }

  const local = parsed.find((p) => p.scope === 'local');
  const installedPorts = local ? hookPorts(local.json, isOwnHook) : [];
  const legacyPorts = local ? hookPorts(local.json, isLegacyHook) : [];
  const manifest = readManifest(repoRoot);
  const lock = readLock(repoRoot);
  const legacyLock = readLegacyLock(repoRoot);
  const port = installedPorts[0] ?? manifest?.port ?? DEFAULT_PORT;
  const url = hookUrl(port);

  if (installedPorts.length > 0) {
    checks.push({
      id: 'installed',
      status: lock?.alive ? 'ok' : 'warn',
      message: lock?.alive
        ? t('doctor.installed.running', { ports: installedPorts.join(', '), pid: lock.pid })
        : t('doctor.installed.orphan', { ports: installedPorts.join(', ') }),
    });
  } else {
    checks.push({ id: 'installed', status: 'info', message: t('doctor.installed.none') });
  }

  if (legacyPorts.length > 0) {
    checks.push({
      id: 'legacy-hooks',
      status: 'warn',
      message: legacyLock?.alive
        ? t('doctor.legacyHooks.running', { ports: legacyPorts.join(', '), pid: legacyLock.pid })
        : t('doctor.legacyHooks.stale', { ports: legacyPorts.join(', ') }),
    });
  }

  if (lock) {
    checks.push({
      id: 'lock',
      status: lock.alive ? 'info' : 'warn',
      message: lock.alive ? t('doctor.lock.running', { pid: lock.pid }) : t('doctor.lock.stale', { pid: lock.pid }),
    });
  }
  if (legacyLock?.alive) {
    checks.push({
      id: 'legacy-lock',
      status: 'warn',
      message: t('doctor.legacyLock', { pid: legacyLock.pid }),
    });
  }

  let allowlistSeen = false;
  for (const p of parsed) {
    const scope = scopeName(p.scope);
    const allowed = p.json.allowedHttpHookUrls;
    if (allowed !== undefined) {
      allowlistSeen = true;
      const patterns = Array.isArray(allowed) ? allowed.filter((x): x is string => typeof x === 'string') : [];
      const ok = patterns.some((pat) => urlPatternMatches(pat, url));
      checks.push({
        id: `allowlist-${p.scope}`,
        status: ok ? 'ok' : 'error',
        message: ok ? t('doctor.allowlist.ok', { scope, url }) : t('doctor.allowlist.missing', { scope, url }),
      });
    }
    if (p.json.allowManagedHooksOnly === true) {
      checks.push({
        id: `managed-only-${p.scope}`,
        status: p.scope === 'managed' ? 'error' : 'warn',
        message: p.scope === 'managed' ? t('doctor.managedOnly.managed') : t('doctor.managedOnly.other', { scope }),
      });
    }
    if (p.json.disableAllHooks === true) {
      checks.push({
        id: `disable-all-${p.scope}`,
        status: 'error',
        message: t('doctor.disableAll', { scope }),
      });
    }
    const strict = p.json.strictPluginOnlyCustomization;
    if (p.scope === 'managed' && (strict === true || (Array.isArray(strict) && strict.includes('hooks')))) {
      checks.push({
        id: 'strict-plugin-only',
        status: 'error',
        message: t('doctor.strictPlugin'),
      });
    }
  }
  if (!allowlistSeen) {
    checks.push({ id: 'allowlist', status: 'ok', message: t('doctor.allowlist.none') });
  }

  const env = process.env;
  const proxies = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].filter(
    (k) => (env[k] ?? '').trim() !== '',
  );
  if (proxies.length > 0) {
    const covered = noProxyCovers(env.NO_PROXY) || noProxyCovers(env.no_proxy);
    checks.push({
      id: 'proxy',
      status: covered ? 'ok' : 'warn',
      message: covered ? t('doctor.proxy.ok', { vars: proxies.join(', ') }) : t('doctor.proxy.warn', { vars: proxies.join(', ') }),
    });
  }

  const user = parsed.find((p) => p.scope === 'user');
  const userSource = sources.find((s) => s.scope === 'user');
  if (user?.json.bashEditDiffEnabled === true) {
    checks.push({ id: 'bash-diff', status: 'ok', message: t('doctor.bashDiff.on') });
  } else if (userSource && !userSource.exists) {
    checks.push({
      id: 'bash-diff',
      status: 'info',
      message: t('doctor.bashDiff.noFile', { path: userSource.path }),
    });
  } else {
    checks.push({ id: 'bash-diff', status: 'info', message: t('doctor.bashDiff.off') });
  }

  // Read only: the legacy record is migrated by the next enable or restore, not by doctor.
  const bashState = readBashDiffState() ?? readLegacyBashDiffState();
  if (bashState) {
    const live = bashState.owners.filter((x) => isPidAlive(x.pid));
    checks.push(
      live.length > 0
        ? { id: 'bash-diff-owners', status: 'info', message: tn('doctor.bashDiff.owners', live.length) }
        : { id: 'bash-diff-pending', status: 'warn', message: t('doctor.bashDiff.pending', { path: bashState.settingsPath }) },
    );
  }

  return { repoRoot, nodeVersion, nodeOk, sources, installedPorts, legacyPorts, manifest, lock, checks };
}

export async function checkEnvironment(repoRoot: string): Promise<DoctorReport> {
  return checkEnvironmentSync(repoRoot);
}
