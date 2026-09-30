#!/usr/bin/env node
// repo-synapse CLI: start | install | uninstall | replay | doctor.
// All console output is Spanish; identifiers and comments stay in English.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSynapseServer, type SynapseServer } from './server/server.ts';
import {
  checkEnvironmentSync,
  enableBashEditDiffSync,
  ensureGitExcluded,
  installHooksSync,
  lockPath,
  readLock,
  readManifest,
  restoreBashEditDiffSync,
  stateDir,
  uninstallHooksSync,
  type DoctorCheck,
  type RestoreBashDiffResult,
} from './install/settings.ts';
import { DEFAULT_PORT } from './shared/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- output

function out(msg = ''): void {
  process.stdout.write(msg + '\n');
}

function err(msg: string): void {
  process.stderr.write(msg + '\n');
}

class CliError extends Error {}

function fail(msg: string): never {
  throw new CliError(msg);
}

function version(): string {
  // dist/cli.mjs and src/cli.ts both sit one level under the package root.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `repo-synapse ${version()}
Vista 3D en vivo de lo que Claude Code lee, edita, crea y borra en un repositorio.

Uso:
  repo-synapse start [repo] [opciones]     Levanta el visor e instala los hooks mientras corre
  repo-synapse install [repo] [--port N]   Instala los hooks a mano
  repo-synapse uninstall [repo]            Quita los hooks (y revierte bashEditDiffEnabled)
  repo-synapse replay [repo|archivo.jsonl] Reproduce un registro grabado
  repo-synapse doctor [repo]               Revisa el entorno

Opciones:
  --port N         Puerto (por defecto ${DEFAULT_PORT}; si está ocupado se usa el siguiente libre)
  --strict-port    Falla si el puerto está ocupado en lugar de buscar otro
  --no-open        No abre el navegador
  --no-install     start: no instala los hooks
  --no-bash-diff   start: no activa bashEditDiffEnabled en la configuración de usuario
  -h, --help       Muestra esta ayuda
  -v, --version    Muestra la versión

[repo] es el directorio actual si no se indica.`;

// ---------------------------------------------------------------- args

interface Options {
  port: number;
  portGiven: boolean;
  open: boolean;
  install: boolean;
  bashDiff: boolean;
  strictPort: boolean;
}

function parsePort(v: string | undefined): number {
  if (v === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(v) || Number(v) > 65535) fail(`Puerto inválido: "${v}". Usá un número entre 0 y 65535.`);
  return Number(v);
}

function parse(argv: string[]): { command: string | undefined; positionals: string[]; opts: Options; help: boolean; version: boolean } {
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
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\nEjecutá "repo-synapse --help" para ver las opciones.`);
  }
  const v = parsed.values;
  const [command, ...positionals] = parsed.positionals;
  return {
    command,
    positionals,
    help: v.help === true,
    version: v.version === true,
    opts: {
      port: parsePort(v.port),
      portGiven: v.port !== undefined,
      open: v['no-open'] !== true,
      install: v['no-install'] !== true,
      bashDiff: v['no-bash-diff'] !== true,
      strictPort: v['strict-port'] === true,
    },
  };
}

function resolveRepo(arg: string | undefined): string {
  const given = path.resolve(arg ?? process.cwd());
  let real: string;
  try {
    real = fs.realpathSync(given);
  } catch {
    fail(`No existe el directorio ${given}.`);
  }
  if (!fs.statSync(real).isDirectory()) fail(`${given} no es un directorio.`);
  return real;
}

// ---------------------------------------------------------------- helpers

function resolveWebDir(): string | undefined {
  const candidates = [
    path.resolve(HERE, 'web'), // dist/cli.mjs -> dist/web
    path.resolve(HERE, '..', 'dist', 'web'), // src/cli.ts via tsx -> dist/web
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
}

function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = execFile(cmd, args, { windowsHide: true }, (e) => {
      if (e) err(`No se pudo abrir el navegador (${e.message}). Abrí ${url} a mano.`);
    });
    child.unref();
  } catch (e) {
    err(`No se pudo abrir el navegador (${(e as Error).message}). Abrí ${url} a mano.`);
  }
}

function onServerError(e: unknown): void {
  if (process.env.REPO_SYNAPSE_DEBUG) err(`[repo-synapse] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}

/** Spanish lines about the bashEditDiffEnabled release, for the user. */
function bashDiffMessages(r: RestoreBashDiffResult | undefined): { info: string[]; warn: string[] } {
  if (!r) return { info: [], warn: [] };
  switch (r.status) {
    case 'restored':
      return { info: ['bashEditDiffEnabled volvió a su valor anterior.'], warn: [] };
    case 'in-use':
      return { info: ['bashEditDiffEnabled sigue activo: lo usa otro visor de repo-synapse abierto.'], warn: [] };
    case 'pending':
      return {
        info: [],
        warn: [
          `No se pudo revertir bashEditDiffEnabled en ${r.settingsPath ?? 'la configuración de usuario'} (${r.error ?? 'error desconocido'}).`,
          'Se reintenta en el próximo "repo-synapse start" o "repo-synapse uninstall"; también podés quitar la clave a mano.',
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

/** Keeps .repo-synapse/ out of git even without hooks (events.jsonl lists the repo). Best effort. */
function excludeStateDir(repo: string): void {
  try {
    ensureGitExcluded(repo);
  } catch (e) {
    err(`Aviso: no se pudo actualizar .git/info/exclude (${(e as Error).message}). No agregues .repo-synapse/ a git.`);
  }
}

/** Takes the lock or fails. A stale lock (dead PID) is taken over after undoing its install. */
function acquireLock(repo: string): void {
  fs.mkdirSync(stateDir(repo), { recursive: true });
  const file = lockPath(repo);
  const data = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n';
  try {
    fs.writeFileSync(file, data, { flag: 'wx' });
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const lock = readLock(repo);
  if (lock?.alive && lock.pid !== process.pid) {
    fail(`Ya hay un repo-synapse corriendo sobre ${repo} (PID ${lock.pid}). Cerralo antes de abrir otro.`);
  }
  out(`Se encontró un lock viejo (PID ${lock?.pid ?? '?'}, ya no existe): se toma el control.`);
  fs.writeFileSync(file, data);
}

function releaseLock(repo: string): void {
  const lock = readLock(repo);
  if (lock && lock.pid !== process.pid) return;
  fs.rmSync(lockPath(repo), { force: true });
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(s, () => resolve(s));
  });
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);
}

// ---------------------------------------------------------------- commands

async function cmdStart(positionals: string[], o: Options): Promise<number> {
  const repo = resolveRepo(positionals[0]);
  acquireLock(repo);

  let server: SynapseServer | undefined;
  let installed = false;
  let cleaned = false;
  /** Synchronous part of the cleanup: safe to run from an `exit` handler, runs once. */
  const cleanupSync = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (installed) {
      try {
        const r = undoInstall(repo);
        if (r.hooksChanged) out('Hooks quitados de .claude/settings.local.json.');
        const msg = bashDiffMessages(r.bashDiff);
        for (const line of msg.info) out(line);
        for (const line of msg.warn) err(line);
      } catch (e) {
        err(`No se pudieron quitar los hooks: ${(e as Error).message}`);
        err('Ejecutá "repo-synapse uninstall" para limpiarlos.');
      }
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
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    // A second signal while closing skips the wait for the server (cleanup already ran).
    process.on(s, () => {
      if (!exiting) out(`\nRecibí ${s}, cerrando...`);
      void shutdown(0);
    });
  }
  process.on('uncaughtException', (e) => {
    err(`Error inesperado: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown(1);
  });
  process.on('unhandledRejection', (e) => {
    err(`Error inesperado: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    void shutdown(1);
  });

  try {
    excludeStateDir(repo);
    if (o.install && readManifest(repo)) {
      // Leftovers of a run that did not clean up: undo them before a fresh install.
      installed = true;
      undoInstall(repo);
      installed = false;
    }
    const webDir = resolveWebDir();
    if (!webDir) err('Aviso: la interfaz web no está compilada (npm run build:web). El servidor igual recibe hooks.');
    server = await startSynapseServer({
      root: repo,
      port: o.port,
      portStrict: o.strictPort,
      mode: 'live',
      ...(webDir ? { webDir } : {}),
      onError: onServerError,
    });
    if (o.port !== 0 && server.port !== o.port) out(`El puerto ${o.port} está ocupado: se usa ${server.port}.`);

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
      out(`Hooks instalados en ${path.relative(repo, inst.settingsPath)} (puerto ${server.port}).`);
      if (inst.excludeError) {
        err(`Aviso: no se pudo actualizar .git/info/exclude (${inst.excludeError}). No agregues .claude/settings.local.json ni .repo-synapse/ a git.`);
      }
      if (o.bashDiff) {
        try {
          const r = enableBashEditDiffSync({ repoRoot: repo });
          if (r.changed) {
            bashNote = `bashEditDiffEnabled activado en ${r.settingsPath} mientras corre el visor.`;
          } else if (r.reason === 'shared') {
            bashNote = `bashEditDiffEnabled ya lo activó otro visor de repo-synapse: sigue activo mientras alguno esté abierto.`;
          } else if (r.reason === 'missing') {
            bashNote = `No existe ${r.settingsPath}: no se activa bashEditDiffEnabled.`;
          } else if (r.reason === 'invalid') {
            bashNote = `${r.settingsPath} no es JSON válido: no se activa bashEditDiffEnabled.`;
          }
        } catch (e) {
          bashNote = `No se pudo activar bashEditDiffEnabled (${(e as Error).message}): se sigue sin él (los borrados por Bash se atribuyen por el watcher).`;
        }
      }
    }
    if (bashNote) out(bashNote);

    out('');
    out(`repo-synapse escuchando en ${server.url}`);
    out(`Repositorio: ${repo}`);
    out('');
    if (o.install) {
      out('Abrí Claude Code en este repositorio (si ya estaba abierto, reinicialo para que tome los hooks).');
    } else {
      out('Los hooks no se instalaron (--no-install): Claude Code no va a enviar eventos.');
    }
    out('Ctrl+C para salir: los hooks se quitan al cerrar.');

    if (o.open) openBrowser(server.url);
  } catch (e) {
    err(e instanceof CliError ? e.message : `No se pudo arrancar: ${(e as Error).message}`);
    return shutdown(1);
  }

  // Runs until a signal calls shutdown().
  return new Promise<number>(() => {});
}

function cmdInstall(positionals: string[], o: Options): number {
  const repo = resolveRepo(positionals[0]);
  const r = installHooksSync({ repoRoot: repo, port: o.port });
  out(`Hooks instalados en ${r.settingsPath} (puerto ${o.port}).`);
  out(`Mientras no haya un servidor en el puerto ${o.port}, Claude Code va a mostrar "hook error" en cada herramienta.`);
  out('Quitalos con "repo-synapse uninstall".');
  return 0;
}

function cmdUninstall(positionals: string[]): number {
  const repo = resolveRepo(positionals[0]);
  const lock = readLock(repo);
  if (lock?.alive && lock.pid !== process.pid) {
    out(`Aviso: repo-synapse sigue corriendo sobre este repo (PID ${lock.pid}).`);
  }
  const r = undoInstall(repo);
  out(r.hooksChanged ? 'Hooks quitados.' : 'No había hooks de repo-synapse para quitar.');
  const msg = bashDiffMessages(r.bashDiff);
  for (const line of msg.info) out(line);
  for (const line of msg.warn) err(line);
  return msg.warn.length > 0 ? 1 : 0;
}

async function cmdReplay(positionals: string[], o: Options): Promise<number> {
  const target = path.resolve(positionals[0] ?? process.cwd());
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st) fail(`No existe ${target}.`);
  let root: string;
  let file: string;
  if (st.isDirectory()) {
    root = fs.realpathSync(target);
    file = path.join(root, '.repo-synapse', 'events.jsonl');
  } else {
    file = fs.realpathSync(target);
    const dir = path.dirname(file);
    root = path.basename(dir) === '.repo-synapse' ? path.dirname(dir) : dir;
  }
  if (!fs.existsSync(file)) fail(`No hay registro para reproducir: ${file} no existe.`);

  const webDir = resolveWebDir();
  if (!webDir) err('Aviso: la interfaz web no está compilada (npm run build:web).');
  const server = await startSynapseServer({
    root,
    port: o.port,
    portStrict: o.strictPort,
    mode: 'replay',
    replayFile: file,
    ...(webDir ? { webDir } : {}),
    onError: onServerError,
  });
  out(`repo-synapse (replay) escuchando en ${server.url}`);
  out(`Registro: ${file}`);
  out('Ctrl+C para salir.');
  if (o.open) openBrowser(server.url);
  await waitForSignal();
  await withTimeout(server.close(), 2000);
  return 0;
}

const STATUS_LABEL: Record<DoctorCheck['status'], string> = {
  ok: '[ok]    ',
  info: '[info]  ',
  warn: '[aviso] ',
  error: '[error] ',
};

function cmdDoctor(positionals: string[]): number {
  const repo = resolveRepo(positionals[0]);
  const report = checkEnvironmentSync(repo);
  out(`repo-synapse ${version()}: diagnóstico de ${repo}`);
  out('');
  out('Archivos de configuración:');
  for (const s of report.sources) {
    const state = !s.exists ? 'no existe' : s.valid ? 'ok' : 'JSON inválido';
    out(`  ${s.scope.padEnd(8)} ${s.path} (${state})`);
  }
  out('');
  for (const c of report.checks) out(`${STATUS_LABEL[c.status]}${c.message}`);
  const webDir = resolveWebDir();
  out(`${STATUS_LABEL[webDir ? 'ok' : 'warn']}${webDir ? `Interfaz web compilada en ${webDir}.` : 'La interfaz web no está compilada (npm run build:web).'}`);
  const errors = report.checks.filter((c) => c.status === 'error').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  out('');
  out(errors + warns === 0 ? 'Todo en orden.' : `${errors} error(es) y ${warns} aviso(s).`);
  return 0;
}

// ---------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
  const a = parse(argv);
  if (a.version) {
    out(version());
    return 0;
  }
  if (a.help || a.command === undefined || a.command === 'help') {
    out(HELP);
    return 0;
  }
  switch (a.command) {
    case 'start':
      return cmdStart(a.positionals, a.opts);
    case 'install':
      return cmdInstall(a.positionals, a.opts);
    case 'uninstall':
      return cmdUninstall(a.positionals);
    case 'replay':
      return cmdReplay(a.positionals, a.opts);
    case 'doctor':
      return cmdDoctor(a.positionals);
    default:
      fail(`Comando desconocido: "${a.command}". Ejecutá "repo-synapse --help".`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    err(e instanceof CliError ? e.message : `Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
