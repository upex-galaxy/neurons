// Append-only JSONL log of what the viewer showed: tree snapshots, events and
// tree deltas (LogLine). Events are already sanitized by the normalizer.

import fs from 'node:fs';
import path from 'node:path';
import type { LogLine, TreeEntry, TreeSnapshot, VizEvent } from '../shared/types.ts';

export class EventLog {
  readonly file: string;
  readonly #stream: fs.WriteStream;
  readonly #now: () => number;
  #closed = false;

  constructor(file: string, opts: { now?: () => number } = {}) {
    this.file = file;
    this.#now = opts.now ?? Date.now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    // A failing disk must not take the server down; lines are best effort.
    this.#stream.on('error', () => {});
  }

  writeTree(t: TreeSnapshot): void {
    this.#write({ kind: 'tree', ts: this.#now(), tree: t });
  }

  writeEvent(e: VizEvent): void {
    this.#write({ kind: 'event', event: e });
  }

  writeDelta(added: TreeEntry[], removed: string[]): void {
    if (added.length === 0 && removed.length === 0) return;
    this.#write({ kind: 'treeDelta', ts: this.#now(), added, removed });
  }

  /** Resolves once every line written so far reached the file. */
  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.#stream.write('', () => resolve());
    });
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return new Promise((resolve) => {
      this.#stream.end(() => resolve());
    });
  }

  #write(line: LogLine): void {
    if (this.#closed) return;
    this.#stream.write(JSON.stringify(line) + '\n');
  }
}

function isLogLine(v: unknown): v is LogLine {
  if (typeof v !== 'object' || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === 'tree' || kind === 'event' || kind === 'treeDelta';
}

/** Reads a JSONL log. Missing file -> []. Unparseable lines (a truncated tail) are skipped. */
export function readLog(file: string): LogLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LogLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isLogLine(v)) out.push(v);
    } catch {
      /* truncated or corrupt line */
    }
  }
  return out;
}
