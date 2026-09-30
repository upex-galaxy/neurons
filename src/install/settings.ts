// Installs and removes repo-synapse's HTTP hooks in <repo>/.claude/settings.local.json,
// toggles bashEditDiffEnabled in the user settings, and inspects the environment
// for `doctor`.
//
// Rules (docs/IMPLEMENTATION_PLAN.md §8):
// - Our hooks are identified by the exact URL http://127.0.0.1:<port>/hook?src=repo-synapse.
//   Foreign hooks are never touched, even when they point at the same host and port.
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
import { DEFAULT_PORT, HOOK_QUERY_MARKER } from '../shared/types.ts';

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
export const STATE_DIR = '.repo-synapse';
export const LOCAL_SETTINGS_REL = path.join('.claude', 'settings.local.json');
export const EXCLUDE_ENTRIES = ['.claude/settings.local.json', '.repo-synapse/'] as const;

const OWN_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/hook\?src=repo-synapse$/;
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
  /** Spanish, one line. */
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

export function isOwnHook(h: unknown): boolean {
  if (!isPlainObject(h)) return false;
  return h.type === 'http' && typeof h.url === 'string' && OWN_URL_RE.test(h.url);
}

function ownHookPort(h: unknown): number | undefined {
  if (!isOwnHook(h)) return undefined;
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

/** Parses a settings file. Blank file = {}. Throws a Spanish error on invalid JSON or a non-object. */
function parseSettings(raw: string, file: string): JsonObject {
  const text = stripBom(raw);
  if (text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} no es JSON válido (${(err as Error).message}). No se modificó.`);
  }
  if (!isPlainObject(v)) throw new Error(`${file} no contiene un objeto JSON. No se modificó.`);
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
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------- pure merge / unmerge

function hooksObjectOf(settings: JsonObject): JsonObject | undefined {
  const hooks = settings.hooks;
  if (hooks === undefined) return undefined;
  if (!isPlainObject(hooks)) throw new Error('La clave "hooks" de la configuración no es un objeto. No se modificó.');
  return hooks;
}

/**
 * Removes our hook objects (mutates `settings`). `groups`: drop groups that became
 * empty because of that removal. `containers`: also drop event arrays and the
 * "hooks" object that became empty because of it. Containers that were already
 * empty are never dropped. Returns the number of hooks removed.
 */
function stripOwn(settings: JsonObject, prune: { groups: boolean; containers: boolean }): number {
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
        const kept = g.hooks.filter((h) => !isOwnHook(h));
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

/** Pure. Our hooks removed, containers emptied by that removal dropped. Foreign entries untouched. */
export function removeOwnHooks(settings: object): object {
  const out = clone(settings) as JsonObject;
  stripOwn(out, { groups: true, containers: true });
  return out;
}

/**
 * Pure. Removes our previous entries (any port) and appends one group per event,
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
      throw new Error(`hooks.${event} no es una lista. No se modificó.`);
    }
    const group = { hooks: [{ type: 'http', url: hookUrl(port), timeout: HOOK_TIMEOUT_S }] };
    hooks[event] = [...(cur ?? []), group];
  }
  out.hooks = hooks;
  return out;
}

/** Our hooks removed and every empty group/array/hooks object dropped: used only to compare. */
function canonical(settings: JsonObject): JsonObject {
  const out = clone(settings);
  stripOwn(out, { groups: true, containers: true });
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

function ownPorts(settings: JsonObject): number[] {
  const ports = new Set<number>();
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        const p = ownHookPort(h);
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

function manifestPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), 'install.json');
}

function backupPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), 'settings.local.json.bak');
}

/** Where builds before the fix kept the user settings backup (inside the repo). Only removed now. */
function legacyUserBackupPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), 'user-settings.bak');
}

export function lockPath(repoRoot: string): string {
  return path.join(stateDir(repoRoot), 'lock');
}

export function readManifest(repoRoot: string): InstallManifest | null {
  const raw = readBytes(manifestPath(repoRoot));
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw.toString('utf8'));
    return isPlainObject(v) ? (v as unknown as InstallManifest) : null;
  } catch {
    return null;
  }
}

function writeManifest(repoRoot: string, m: InstallManifest): void {
  writeFileAtomic(manifestPath(repoRoot), serialize(m));
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
 * Adds `.claude/settings.local.json` and `.repo-synapse/` to .git/info/exclude when
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
  const block = `${prev === '' || prev.endsWith('\n') ? '' : '\n'}# repo-synapse\n${lines.join('\n')}\n`;
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
  const file = localSettingsPath(o.repoRoot);
  const claudeDir = path.dirname(file);
  const raw = readBytes(file);
  const current = raw ? parseSettings(raw.toString('utf8'), file) : {};
  const merged = mergeHooks(current, o.port);

  fs.mkdirSync(stateDir(o.repoRoot), { recursive: true });
  const existing = readManifest(o.repoRoot);
  if (existing) {
    // A previous install (maybe a crashed run) owns the backup: keep it.
    writeManifest(o.repoRoot, { ...existing, port: o.port });
  } else {
    if (raw) fs.writeFileSync(backupPath(o.repoRoot), raw);
    else fs.rmSync(backupPath(o.repoRoot), { force: true });
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

export function uninstallHooksSync(o: { repoRoot: string }): { changed: boolean } {
  const file = localSettingsPath(o.repoRoot);
  const manifest = readManifest(o.repoRoot);
  const raw = readBytes(file);
  let changed = false;

  if (raw) {
    const current = parseSettings(raw.toString('utf8'), file);
    const stripped = removeOwnHooks(current) as JsonObject;
    const backup = manifest && !manifest.createdFile ? readBytes(backupPath(o.repoRoot)) : undefined;
    let backupJson: JsonObject | undefined;
    if (backup) {
      try {
        backupJson = parseSettings(backup.toString('utf8'), 'backup');
      } catch {
        backupJson = undefined;
      }
    }
    if (backup && backupJson && deepEqual(canonical(stripped), canonical(backupJson))) {
      if (!raw.equals(backup)) {
        writeFileAtomic(file, backup);
        changed = true;
      }
    } else if (manifest?.createdFile && Object.keys(canonical(stripped)).length === 0) {
      fs.rmSync(file, { force: true });
      changed = true;
    } else if (!deepEqual(stripped, current)) {
      writeFileAtomic(file, serialize(stripped));
      changed = true;
    }
  }

  if (manifest?.createdClaudeDir && !fs.existsSync(file)) removeDirIfEmpty(path.dirname(file));
  if (manifest) {
    fs.rmSync(backupPath(o.repoRoot), { force: true });
    fs.rmSync(manifestPath(o.repoRoot), { force: true });
  }
  return { changed };
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
// repo): <config dir>/repo-synapse/bash-diff.json lists the viewers that need the key
// (repo + PID) and settings.json.bak holds the original bytes, both mode 0600. The key is
// restored only when the last live viewer releases it, and the record is kept when the
// restore cannot be done yet (invalid JSON, write error) so a later run can retry.

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
  return path.join(claudeConfigDir(), 'repo-synapse');
}

function bashDiffStatePath(): string {
  return path.join(bashDiffStateDir(), 'bash-diff.json');
}

function bashDiffBackupPath(): string {
  return path.join(bashDiffStateDir(), 'settings.json.bak');
}

export function readBashDiffState(): BashDiffState | null {
  const raw = readBytes(bashDiffStatePath());
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

function writeBashDiffState(st: BashDiffState): void {
  writePrivate(bashDiffStatePath(), serialize(st));
}

function clearBashDiffState(): void {
  fs.rmSync(bashDiffStatePath(), { force: true });
  fs.rmSync(bashDiffBackupPath(), { force: true });
  removeDirIfEmpty(bashDiffStateDir());
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

  const st = readBashDiffState();
  if (st) {
    // Our change is already in place (another viewer, or a run that crashed): share it.
    if (cur.bashEditDiffEnabled !== true) {
      cur.bashEditDiffEnabled = true;
      writeFileAtomic(file, serialize(cur));
    }
    writeBashDiffState({ ...st, owners: [...otherLiveOwners(st, o.repoRoot), me] });
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
  /** Spanish reason when status is 'pending'. */
  error?: string;
}

/**
 * Releases `repoRoot`'s use of bashEditDiffEnabled. When no other live viewer needs it,
 * puts back the previous value (the exact original bytes when that is the only
 * difference). Only acts while the key is still `true`. Never creates the file.
 */
export function restoreBashEditDiffSync(o: { repoRoot: string }): RestoreBashDiffResult {
  fs.rmSync(legacyUserBackupPath(o.repoRoot), { force: true });
  const st = readBashDiffState();
  if (!st) return { changed: false, status: 'none' };
  const others = otherLiveOwners(st, o.repoRoot);
  if (others.length > 0) {
    writeBashDiffState({ ...st, owners: others });
    return { changed: false, status: 'in-use', settingsPath: st.settingsPath };
  }
  const file = st.settingsPath;
  const keep = (error: string): RestoreBashDiffResult => {
    writeBashDiffState({ ...st, owners: [] });
    return { changed: false, status: 'pending', settingsPath: file, error };
  };

  const raw = readBytes(file);
  if (!raw) {
    clearBashDiffState();
    return { changed: false, status: 'untouched', settingsPath: file };
  }
  let cur: JsonObject;
  try {
    cur = parseSettings(raw.toString('utf8'), file);
  } catch {
    return keep(`${file} no es JSON válido`);
  }
  if (cur.bashEditDiffEnabled !== true) {
    clearBashDiffState();
    return { changed: false, status: 'untouched', settingsPath: file };
  }
  if (st.previous.present) cur.bashEditDiffEnabled = st.previous.value;
  else delete cur.bashEditDiffEnabled;

  let data: string | Buffer = serialize(cur);
  const backup = readBytes(bashDiffBackupPath());
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
  clearBashDiffState();
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
const LOCK_START_SLACK_MS = 5000;

/**
 * When `pid` started (epoch ms), from `ps -o etime=` ([[dd-]hh:]mm:ss, locale independent).
 * undefined when it cannot be known (Windows, no ps, process gone).
 */
export function processStartMs(pid: number): number | undefined {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return undefined;
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

/** Command line of `pid` (`ps -o command=`), undefined when it cannot be read. */
function processCommand(pid: number): string | undefined {
  if (process.platform === 'win32') return undefined;
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

export interface LockInfo {
  pid: number;
  alive: boolean;
}

/**
 * Parses a lock's bytes ({"pid":N,"startedAt":ISO,"cmd":script} or a bare number).
 * `alive` also requires the process to be the lock's owner: a PID reused after a crash
 * or a reboot belongs to a process that started after the lock was written. A process
 * whose command line still names the lock's script is taken as the owner anyway, since a
 * wall-clock step after start (NTP, VM resume) also moves the start time `ps` reports.
 */
export function lockStatus(raw: Buffer): LockInfo {
  const text = raw.toString('utf8').trim();
  let pid = Number.NaN;
  let startedAt = Number.NaN;
  let cmd: string | undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === 'number') pid = v;
    else if (isPlainObject(v) && typeof v.pid === 'number') {
      pid = v.pid;
      if (typeof v.startedAt === 'string') startedAt = Date.parse(v.startedAt);
      if (typeof v.cmd === 'string' && v.cmd.length > 0) cmd = v.cmd;
    }
  } catch {
    pid = Number.parseInt(text, 10);
  }
  if (!Number.isInteger(pid)) return { pid: 0, alive: false };
  if (!isPidAlive(pid)) return { pid, alive: false };
  if (pid !== process.pid && Number.isFinite(startedAt)) {
    const procStart = processStartMs(pid);
    if (procStart !== undefined && procStart > startedAt + LOCK_START_SLACK_MS) {
      const alive = cmd !== undefined && (processCommand(pid)?.includes(cmd) ?? false);
      return { pid, alive };
    }
  }
  return { pid, alive: true };
}

/** Reads <repo>/.repo-synapse/lock; null when there is none. See lockStatus. */
export function readLock(repoRoot: string): LockInfo | null {
  const raw = readBytes(lockPath(repoRoot));
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
 * Takes <repo>/.repo-synapse/lock for this process. A stale lock (dead PID, or a PID
 * reused by a process that is not its owner) is taken over; any number of starts racing
 * on it end with exactly one owner. `busy`: other starts kept the lock in flux until
 * `timeoutMs`.
 */
export function acquireLockSync(repoRoot: string, o: { timeoutMs?: number } = {}): LockAcquireResult {
  fs.mkdirSync(stateDir(repoRoot), { recursive: true });
  const file = lockPath(repoRoot);
  const own: Record<string, unknown> = { pid: process.pid, startedAt: new Date().toISOString() };
  if (process.argv[1]) own.cmd = process.argv[1];
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
    message: nodeOk
      ? `Node ${nodeVersion}`
      : `Node ${nodeVersion}: se necesita Node ${MIN_NODE[0]}.${MIN_NODE[1]} o superior.`,
  });

  const specs: Array<{ scope: SettingsSourceInfo['scope']; path: string | undefined }> = [
    { scope: 'managed', path: managedSettingsPath() },
    { scope: 'user', path: userSettingsPath() },
    { scope: 'project', path: path.join(repoRoot, '.claude', 'settings.json') },
    { scope: 'local', path: localSettingsPath(repoRoot) },
  ];
  const scopeName: Record<SettingsSourceInfo['scope'], string> = {
    managed: 'administrada',
    user: 'de usuario',
    project: 'del proyecto',
    local: 'local',
  };
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
        message: `La configuración ${scopeName[s.scope]} (${s.path}) no es JSON válido.`,
      });
    }
  }

  const local = parsed.find((p) => p.scope === 'local');
  const installedPorts = local ? ownPorts(local.json) : [];
  const manifest = readManifest(repoRoot);
  const lock = readLock(repoRoot);
  const port = installedPorts[0] ?? manifest?.port ?? DEFAULT_PORT;
  const url = hookUrl(port);

  if (installedPorts.length > 0) {
    checks.push({
      id: 'installed',
      status: lock?.alive ? 'ok' : 'warn',
      message: lock?.alive
        ? `Hooks instalados en el puerto ${installedPorts.join(', ')} (repo-synapse corriendo, PID ${lock.pid}).`
        : `Hay hooks de repo-synapse en el puerto ${installedPorts.join(', ')} pero el visor no está corriendo: Claude Code mostrará "hook error". Ejecutá "repo-synapse uninstall".`,
    });
  } else {
    checks.push({ id: 'installed', status: 'info', message: 'Los hooks no están instalados (se instalan al ejecutar "start").' });
  }

  if (lock) {
    checks.push({
      id: 'lock',
      status: lock.alive ? 'info' : 'warn',
      message: lock.alive
        ? `repo-synapse está corriendo sobre este repo (PID ${lock.pid}).`
        : `Hay un lock viejo (PID ${lock.pid}, ya no es de repo-synapse). El próximo "start" lo reemplaza.`,
    });
  }

  let allowlistSeen = false;
  for (const p of parsed) {
    const scope = scopeName[p.scope];
    const allowed = p.json.allowedHttpHookUrls;
    if (allowed !== undefined) {
      allowlistSeen = true;
      const patterns = Array.isArray(allowed) ? allowed.filter((x): x is string => typeof x === 'string') : [];
      const ok = patterns.some((pat) => urlPatternMatches(pat, url));
      checks.push({
        id: `allowlist-${p.scope}`,
        status: ok ? 'ok' : 'error',
        message: ok
          ? `allowedHttpHookUrls en la configuración ${scope} permite ${url}.`
          : `allowedHttpHookUrls en la configuración ${scope} no incluye ${url}. Agregá "http://127.0.0.1:*/hook?src=repo-synapse".`,
      });
    }
    if (p.json.allowManagedHooksOnly === true) {
      checks.push({
        id: `managed-only-${p.scope}`,
        status: p.scope === 'managed' ? 'error' : 'warn',
        message:
          p.scope === 'managed'
            ? 'allowManagedHooksOnly está activo en la configuración administrada: los hooks de settings.local.json no se ejecutan.'
            : `allowManagedHooksOnly aparece en la configuración ${scope}; solo tiene efecto en la administrada.`,
      });
    }
    if (p.json.disableAllHooks === true) {
      checks.push({
        id: `disable-all-${p.scope}`,
        status: 'error',
        message: `disableAllHooks está activo en la configuración ${scope}: ningún hook se ejecuta.`,
      });
    }
    const strict = p.json.strictPluginOnlyCustomization;
    if (p.scope === 'managed' && (strict === true || (Array.isArray(strict) && strict.includes('hooks')))) {
      checks.push({
        id: 'strict-plugin-only',
        status: 'error',
        message: 'strictPluginOnlyCustomization bloquea los hooks de la configuración del proyecto.',
      });
    }
  }
  if (!allowlistSeen) {
    checks.push({ id: 'allowlist', status: 'ok', message: 'No hay allowedHttpHookUrls: los hooks HTTP a 127.0.0.1 están permitidos.' });
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
      message: covered
        ? `Hay proxy (${proxies.join(', ')}) y NO_PROXY cubre 127.0.0.1.`
        : `Hay proxy (${proxies.join(', ')}) y NO_PROXY no cubre 127.0.0.1: los hooks podrían salir por el proxy. Agregá 127.0.0.1 a NO_PROXY.`,
    });
  }

  const user = parsed.find((p) => p.scope === 'user');
  const userSource = sources.find((s) => s.scope === 'user');
  if (user?.json.bashEditDiffEnabled === true) {
    checks.push({ id: 'bash-diff', status: 'ok', message: 'bashEditDiffEnabled está activo en la configuración de usuario.' });
  } else if (userSource && !userSource.exists) {
    checks.push({
      id: 'bash-diff',
      status: 'info',
      message: `No existe ${userSource.path}: "start" no puede activar bashEditDiffEnabled (los borrados por Bash se atribuyen por el watcher).`,
    });
  } else {
    checks.push({ id: 'bash-diff', status: 'info', message: 'bashEditDiffEnabled está apagado; "start" lo activa mientras corre.' });
  }

  const bashState = readBashDiffState();
  if (bashState) {
    const live = bashState.owners.filter((x) => isPidAlive(x.pid));
    checks.push(
      live.length > 0
        ? { id: 'bash-diff-owners', status: 'info', message: `repo-synapse activó bashEditDiffEnabled; lo usan ${live.length} visor(es) abierto(s).` }
        : {
            id: 'bash-diff-pending',
            status: 'warn',
            message: `Quedó pendiente revertir bashEditDiffEnabled en ${bashState.settingsPath}. Ejecutá "repo-synapse uninstall" o quitá la clave a mano.`,
          },
    );
  }

  return { repoRoot, nodeVersion, nodeOk, sources, installedPorts, manifest, lock, checks };
}

export async function checkEnvironment(repoRoot: string): Promise<DoctorReport> {
  return checkEnvironmentSync(repoRoot);
}
