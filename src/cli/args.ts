// Argument parsing and command routing. Pure apart from the injected file system checks,
// so the routing rules are unit tested without spawning the CLI.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT } from '../shared/types.ts';
import { fail } from './output.ts';

export const COMMANDS = ['start', 'install', 'uninstall', 'replay', 'doctor', 'ls', 'stop', 'open', 'help'] as const;
export type Command = (typeof COMMANDS)[number];

export interface Options {
  port: number;
  portGiven: boolean;
  open: boolean;
  install: boolean;
  bashDiff: boolean;
  strictPort: boolean;
  /** stop: every running viewer. */
  all: boolean;
  /** stop: SIGKILL a viewer that did not exit, then uninstall its hooks. */
  force: boolean;
}

export type Route =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; command: Exclude<Command, 'help'>; positionals: string[]; opts: Options };

function parsePort(v: string | undefined): number {
  if (v === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(v) || Number(v) > 65535) fail(`Puerto inválido: "${v}". Usá un número entre 0 y 65535.`);
  return Number(v);
}

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

/** Levenshtein distance, for the "did you mean" hint. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function closestCommand(word: string): Command | undefined {
  let best: Command | undefined;
  let bestD = 3;
  for (const c of COMMANDS) {
    const d = distance(word.toLowerCase(), c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Routes argv:
 * - no command -> `start` on the current directory;
 * - `help`, `--help`, `-h` -> help; `--version`, `-v` -> version;
 * - a word that is not a command but names an existing directory -> `start <dir>`;
 * - anything else -> CliError with a Spanish hint (a file gets its own: it is not a folder,
 *   and a .jsonl is probably a log for `replay`).
 * `isDirectory` and `isFile` receive the word as typed (relative to the cwd).
 */
export function route(argv: string[], isDirectory: (p: string) => boolean, isFile: (p: string) => boolean = () => false): Route {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string', short: 'p' },
        'no-open': { type: 'boolean' },
        'no-install': { type: 'boolean' },
        'no-bash-diff': { type: 'boolean' },
        'strict-port': { type: 'boolean' },
        all: { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\nEjecutá "neu --help" para ver las opciones.`);
  }
  const v = parsed.values;
  if (v.version === true) return { kind: 'version' };
  const [first, ...rest] = parsed.positionals;
  if (v.help === true || first === 'help') return { kind: 'help' };

  let command: Exclude<Command, 'help'>;
  let positionals: string[];
  if (first === undefined) {
    command = 'start';
    positionals = [];
  } else if (isCommand(first)) {
    command = first as Exclude<Command, 'help'>;
    positionals = rest;
  } else if (isDirectory(first)) {
    command = 'start';
    positionals = [first, ...rest];
  } else {
    const near = closestCommand(first);
    const looksLikePath = first.includes('/') || first.includes(path.sep) || first.startsWith('.') || first.startsWith('~');
    const hints: string[] = [];
    if (isFile(first)) {
      hints.push(`${path.resolve(first)} es un archivo, no una carpeta.`);
      if (first.endsWith('.jsonl')) hints.push(`Si es un registro grabado, reproducilo con: neu replay ${first}`);
    } else {
      if (near) hints.push(`¿Quisiste decir "neu ${near}"?`);
      if (looksLikePath || !near) hints.push(`Si es un repositorio, la carpeta ${path.resolve(first)} no existe.`);
    }
    hints.push('Ejecutá "neu --help" para ver los comandos.');
    fail(`Comando desconocido: "${first}".\n${hints.join('\n')}`);
  }

  return {
    kind: 'run',
    command,
    positionals,
    opts: {
      port: parsePort(v.port),
      portGiven: v.port !== undefined,
      open: v['no-open'] !== true,
      install: v['no-install'] !== true,
      bashDiff: v['no-bash-diff'] !== true,
      strictPort: v['strict-port'] === true,
      all: v.all === true,
      force: v.force === true,
    },
  };
}
