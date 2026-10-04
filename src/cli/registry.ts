// Registry of running viewers, one file per process: $NEURONS_HOME/viewers/<pid>.json
// (NEURONS_HOME defaults to ~/.neurons). `start` writes its entry once it listens and
// removes it on exit; readers prune entries whose process is gone or is no longer the
// viewer (same identity rules as the repo lock, see lockStatus). Nothing here signals a
// process unless isNeuronsViewer() confirmed it is the viewer that wrote the record: same
// command line and started no later than the record.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandMatches, isPidAlive, lockPath, lockStatus, ownCommand, processCommand, startedBy, writeFileAtomic } from '../install/settings.ts';

export interface ViewerEntry {
  pid: number;
  /** Real path of the repo root the viewer watches. */
  repo: string;
  port: number;
  url: string;
  /** ISO time the viewer started (same meaning as the lock's startedAt). */
  startedAt: string;
  /** The CLI script the viewer runs (process.argv[1]). */
  cmd: string;
  /**
   * The viewer's own `ps` command line, as it saw it at start. Matched exactly: argv[1] is
   * absolute while `ps` shows a relative script path as typed (`tsx src/cli.ts`).
   * Missing in entries written before it existed: `cmd` is matched then.
   */
  command?: string;
  /**
   * False for a viewer started with --no-install: it installs no hooks, so whatever hooks
   * the repo has were put there by hand and outlive it. Missing in entries written before
   * it existed (taken as true).
   */
  installs?: boolean;
}

export function neuronsHome(): string {
  const env = process.env.NEURONS_HOME;
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.neurons');
}

export function viewersDir(): string {
  return path.join(neuronsHome(), 'viewers');
}

function entryPath(pid: number): string {
  return path.join(viewersDir(), `${pid}.json`);
}

function isEntry(v: unknown): v is ViewerEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.pid === 'number' &&
    Number.isInteger(e.pid) &&
    typeof e.repo === 'string' &&
    typeof e.port === 'number' &&
    typeof e.url === 'string' &&
    typeof e.startedAt === 'string' &&
    typeof e.cmd === 'string' &&
    (e.command === undefined || typeof e.command === 'string') &&
    (e.installs === undefined || typeof e.installs === 'boolean')
  );
}

/** Writes this process's entry. Returns its path. */
export function writeViewerEntry(o: {
  repo: string;
  port: number;
  url: string;
  startedAt?: string;
  pid?: number;
  cmd?: string;
  command?: string;
  installs?: boolean;
}): string {
  const entry: ViewerEntry = {
    pid: o.pid ?? process.pid,
    repo: o.repo,
    port: o.port,
    url: o.url,
    startedAt: o.startedAt ?? new Date().toISOString(),
    cmd: o.cmd ?? process.argv[1] ?? '',
  };
  // Another PID's command line is only known when given (tests).
  const command = o.command ?? (o.pid === undefined ? ownCommand() : undefined);
  if (command) entry.command = command;
  if (o.installs !== undefined) entry.installs = o.installs;
  const file = entryPath(entry.pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(entry, null, 2) + '\n');
  return file;
}

/** Removes the entry of `pid` (default: this process). */
export function removeViewerEntry(pid = process.pid): void {
  fs.rmSync(entryPath(pid), { force: true });
}

/** An entry describes a live viewer: its PID is alive and still the process that wrote it. */
export function isEntryLive(e: ViewerEntry): boolean {
  return lockStatus(Buffer.from(JSON.stringify({ pid: e.pid, startedAt: e.startedAt, cmd: e.cmd, command: e.command }))).alive;
}

/** What identifies a viewer process before it is signaled. */
export interface ViewerIdentity {
  pid: number;
  cmd: string;
  /** When given, the process must have started no later than this (plus slack). */
  startedAt?: string;
  command?: string;
}

/**
 * Stricter than isEntryLive, for signals: the process is alive, its command line is the
 * record's (exact `command` when recorded, else it runs `cmd` as a whole argument) and,
 * with `startedAt`, it started no later than the record. No fallback for a clock step
 * here: a PID reused by another program (or by another viewer launched the same way) is
 * never signaled. Unknown command line or start time (no ps) -> false.
 */
export function isNeuronsViewer(e: ViewerIdentity): boolean {
  if (e.pid === process.pid || (e.cmd === '' && !e.command) || !isPidAlive(e.pid)) return false;
  const command = processCommand(e.pid);
  if (command === undefined || !commandMatches(command, e)) return false;
  return e.startedAt === undefined || startedBy(e.pid, e.startedAt);
}

/**
 * Live viewers, oldest first. Unreadable entries and entries of dead or reused PIDs are
 * deleted on the way (`prune: false` only reads).
 */
export function listViewers(o: { prune?: boolean } = {}): ViewerEntry[] {
  const prune = o.prune ?? true;
  let names: string[];
  try {
    names = fs.readdirSync(viewersDir());
  } catch {
    return [];
  }
  const live: ViewerEntry[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(viewersDir(), name);
    let entry: unknown;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // Being written right now (atomic rename makes this rare) or corrupt.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      entry = undefined;
    }
    if (isEntry(entry) && String(entry.pid) === m[1] && isEntryLive(entry)) live.push(entry);
    else if (prune) fs.rmSync(file, { force: true });
  }
  return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.pid - b.pid);
}

/**
 * The viewer that holds `<repo>/.neurons/lock`, when the lock is live and names its CLI
 * script: covers a viewer whose registry entry is missing (another NEURONS_HOME). Stricter
 * than lockStatus, since the result is a stop target: the process must have started no
 * later than the lock (a stale lock whose PID a newer viewer reused is not its owner), and
 * a PID the registry lists for another repo belongs to that repo's viewer.
 */
export function viewerFromLock(repoRoot: string): ViewerIdentity & { startedAt: string } | undefined {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(lockPath(repoRoot));
  } catch {
    return undefined;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const l = v as Record<string, unknown>;
  if (typeof l.pid !== 'number' || typeof l.cmd !== 'string' || l.cmd === '' || typeof l.startedAt !== 'string') return undefined;
  if (!lockStatus(raw).alive || !startedBy(l.pid, l.startedAt)) return undefined;
  if (listViewers({ prune: false }).some((v) => v.pid === l.pid && v.repo !== repoRoot)) return undefined;
  const found: ViewerIdentity & { startedAt: string } = { pid: l.pid, cmd: l.cmd, startedAt: l.startedAt };
  if (typeof l.command === 'string' && l.command !== '') found.command = l.command;
  return found;
}

/** The live viewer watching `repoRoot` (a real path), if any. */
export function viewerForRepo(repoRoot: string, viewers = listViewers()): ViewerEntry | undefined {
  return viewers.find((v) => v.repo === repoRoot);
}
