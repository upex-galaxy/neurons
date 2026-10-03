#!/usr/bin/env node
// Neurons CLI (bins `neu` and `neurons`): start | install | uninstall | replay | doctor |
// ls | stop | open. `neu` alone is `neu start`, and `neu <dir>` is `neu start <dir>`.
// All console output is Spanish; identifiers and comments stay in English.

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
} from './install/settings.ts';
import { route, type Options } from './cli/args.ts';
import { STOP_TIMEOUT_MS, stopViewer, type StopTarget } from './cli/control.ts';
import { CliError, err, fail, out } from './cli/output.ts';
import { listViewers, removeViewerEntry, viewerForRepo, viewerFromLock, writeViewerEntry, type ViewerEntry } from './cli/registry.ts';
import { resolveRepoRoot } from './cli/repo-root.ts';
import { findClaudeSessions, sessionWarning } from './cli/sessions.ts';
import { DEFAULT_PORT, LEGACY_STATE_DIR_NAME, STATE_DIR_NAME } from './shared/types.ts';

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

const HELP = `Neurons ${version()}
Vista 3D en vivo de lo que Claude Code lee, edita, crea y borra en un repositorio.

Uso:
  neu [repo] [opciones]           Lo mismo que "neu start [repo]"
  neu start [repo] [opciones]     Levanta el visor e instala los hooks mientras corre
  neu ls                          Lista los visores que están corriendo
  neu open [repo]                 Abre en el navegador el visor de un repo
  neu stop [repo] [--force]       Cierra el visor de un repo (sus hooks se quitan al salir)
  neu stop --all                  Cierra todos los visores
  neu install [repo] [--port N]   Instala los hooks a mano
  neu uninstall [repo]            Quita los hooks (y revierte bashEditDiffEnabled)
  neu replay [repo|archivo.jsonl] Reproduce un registro grabado
  neu doctor [repo]               Revisa el entorno
  neu help                        Muestra esta ayuda

Opciones:
  --port N         Puerto (por defecto ${DEFAULT_PORT}; si está ocupado se usa el siguiente libre)
  --strict-port    Falla si el puerto está ocupado en lugar de buscar otro
  --no-open        No abre el navegador
  --no-install     start: no instala los hooks
  --no-bash-diff   start: no activa bashEditDiffEnabled en la configuración de usuario
  --all            stop: cierra todos los visores
  --force          stop: si el visor no cierra en ${STOP_TIMEOUT_MS / 1000} s, lo mata (SIGKILL) y quita sus hooks
  -h, --help       Muestra esta ayuda
  -v, --version    Muestra la versión

[repo] es el directorio actual si no se indica. Dentro de un repositorio git se usa
su raíz, aunque estés en una subcarpeta. "neu open" sin repo abre el visor del repo
en el que estás; si ahí no corre ninguno, abre el único que haya o los lista.
"neurons" funciona igual que "neu".

Ejemplos:
  neu                          Visor del repo en el que estás
  neu ~/proyectos/api          Visor de otro repo (uno por repo, cada uno en su puerto)
  neu --port 8080 --no-open    Puerto fijo y sin abrir el navegador
  neu ls                       Qué visores están corriendo y en qué URL
  neu open ~/proyectos/api     Vuelve a abrir el visor de ese repo
  neu stop                     Cierra el visor del repo en el que estás
  neu stop --all               Cierra todos
  neu replay                   Reproduce .neurons/events.jsonl del repo actual`;

// ---------------------------------------------------------------- repo

/**
 * The repo a command works on: `arg` (default: the cwd) moved up to its git root, with a
 * line saying so when that changed the directory. `treeNote`: also say when it is not git.
 */
function resolveRepo(arg: string | undefined, o: { treeNote?: boolean } = {}): string {
  const r = resolveRepoRoot(arg);
  if (r.root !== r.given) out(`Usando la raíz del repositorio: ${r.root}`);
  if (!r.isGit && o.treeNote) {
    out('No es un repositorio git: el árbol se arma recorriendo la carpeta (sin node_modules, dist ni build).');
  }
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

/**
 * Opens `url` in the default browser (open / xdg-open / start, via execFile). Resolves
 * true when the opener exited cleanly; `start` does not wait for it, `open` does.
 */
function openBrowser(url: string): Promise<boolean> {
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
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (e) => {
        if (e) err(`No se pudo abrir el navegador (${e.message}). Abrí ${url} a mano.`);
        resolve(!e);
      });
      child.unref();
    } catch (e) {
      err(`No se pudo abrir el navegador (${(e as Error).message}). Abrí ${url} a mano.`);
      resolve(false);
    }
  });
}

function onServerError(e: unknown): void {
  if (process.env.NEURONS_DEBUG || process.env.REPO_SYNAPSE_DEBUG) err(`[neurons] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}

/** Spanish lines about the bashEditDiffEnabled release, for the user. */
function bashDiffMessages(r: RestoreBashDiffResult | undefined): { info: string[]; warn: string[] } {
  if (!r) return { info: [], warn: [] };
  switch (r.status) {
    case 'restored':
      return { info: ['bashEditDiffEnabled volvió a su valor anterior.'], warn: [] };
    case 'in-use':
      return { info: ['bashEditDiffEnabled sigue activo: lo usa otro visor de Neurons abierto.'], warn: [] };
    case 'pending':
      return {
        info: [],
        warn: [
          `No se pudo revertir bashEditDiffEnabled en ${r.settingsPath ?? 'la configuración de usuario'} (${r.error ?? 'error desconocido'}).`,
          'Se reintenta en el próximo "neu start" o "neu uninstall"; también podés quitar la clave a mano.',
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
    err(`Aviso: no se pudo actualizar .git/info/exclude (${(e as Error).message}). No agregues ${STATE_DIR_NAME}/ a git.`);
  }
}

/** Fails when a repo-synapse version (before the rename) is running on the repo. */
function failIfLegacyRunning(repo: string, action: string): void {
  const legacy = readLegacyLock(repo);
  if (legacy?.alive && legacy.pid !== process.pid) {
    fail(
      `La versión anterior (repo-synapse) está corriendo sobre ${repo} (PID ${legacy.pid}). Cerrala antes de ${action}.\n` +
        `Si ese proceso no es repo-synapse, borrá ${legacyLockPath(repo)} y volvé a intentar.`,
    );
  }
}

/** Takes the repo's lock or fails (see acquireLockSync). */
function acquireLock(repo: string): void {
  // Both would install hooks in the same settings file, and each removes the other's.
  failIfLegacyRunning(repo, 'abrir Neurons');
  const r = acquireLockSync(repo);
  if (r.ok) {
    if (r.tookOver !== undefined) {
      out(`Se encontró un lock viejo (PID ${r.tookOver || '?'}, ya no es de Neurons): se toma el control.`);
    }
    return;
  }
  if (r.reason === 'live') {
    fail(
      `Ya hay un visor de Neurons corriendo sobre ${repo} (PID ${r.pid}). Cerralo antes de abrir otro.\n` +
        `Si ese proceso no es de Neurons, borrá ${lockPath(repo)} y volvé a intentar.`,
    );
  }
  fail(`No se pudo tomar el lock de ${repo}: otro visor de Neurons está arrancando sobre el mismo repo.`);
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
        if (r.hooksChanged) out('Hooks quitados de .claude/settings.local.json.');
        const msg = bashDiffMessages(r.bashDiff);
        for (const line of msg.info) out(line);
        for (const line of msg.warn) err(line);
      } catch (e) {
        err(`No se pudieron quitar los hooks: ${(e as Error).message}`);
        err('Ejecutá "neu uninstall" para limpiarlos.');
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
    if (o.install && (readManifest(repo) || readLegacyManifest(repo))) {
      // Leftovers of a run that did not clean up (or of a repo-synapse version): undo
      // them before a fresh install.
      installed = true;
      undoInstall(repo);
      installed = false;
    }
    const webDir = resolveWebDir();
    if (!webDir) err('Aviso: la interfaz web no está compilada (npm run build:web). El servidor igual recibe hooks.');
    server = await startNeuronsServer({
      root: repo,
      port: o.port,
      portStrict: o.strictPort,
      mode: 'live',
      ...(webDir ? { webDir } : {}),
      onError: onServerError,
    });
    if (o.port !== 0 && server.port !== o.port) out(`El puerto ${o.port} está ocupado: se usa ${server.port}.`);
    try {
      writeViewerEntry({ repo, port: server.port, url: server.url });
      registered = true;
    } catch (e) {
      err(`Aviso: no se pudo registrar el visor (${(e as Error).message}): "neu ls", "neu open" y "neu stop" no lo van a ver.`);
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
      out(`Hooks instalados en ${path.relative(repo, inst.settingsPath)} (puerto ${server.port}).`);
      if (inst.excludeError) {
        err(`Aviso: no se pudo actualizar .git/info/exclude (${inst.excludeError}). No agregues .claude/settings.local.json ni ${STATE_DIR_NAME}/ a git.`);
      }
      if (o.bashDiff) {
        try {
          const r = enableBashEditDiffSync({ repoRoot: repo });
          if (r.changed) {
            bashNote = `bashEditDiffEnabled activado en ${r.settingsPath} mientras corre el visor.`;
          } else if (r.reason === 'shared') {
            bashNote = `bashEditDiffEnabled ya lo activó otro visor de Neurons: sigue activo mientras alguno esté abierto.`;
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
    out(`Neurons escuchando en ${server.url}`);
    out(`Repositorio: ${repo}`);
    out('');
    if (o.install) {
      const sessions = await findClaudeSessions(repo);
      if (sessions === undefined) {
        out('Abrí Claude Code en este repositorio (si ya estaba abierto y no ves eventos, reinicialo).');
      } else if (sessions.length === 0) {
        out('Abrí Claude Code en este repositorio.');
      } else {
        for (const line of sessionWarning(sessions)) out(line);
      }
    } else {
      out('Los hooks no se instalaron (--no-install): Claude Code no va a enviar eventos.');
    }
    out(o.install ? 'Ctrl+C para salir: los hooks se quitan al cerrar.' : 'Ctrl+C para salir.');

    if (o.open) void openBrowser(server.url);
  } catch (e) {
    err(e instanceof CliError ? e.message : `No se pudo arrancar: ${(e as Error).message}`);
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
    fail(
      `Neurons está corriendo sobre ${repo} (PID ${lock.pid}) y sus hooks ya están instalados: no se tocan.\n` +
        'Cerralo antes de instalar los hooks a mano.',
    );
  }
  // Installing removes that version's hooks (and undoes its install) while it runs.
  if (readLegacyManifest(repo)) failIfLegacyRunning(repo, 'instalar los hooks a mano');
  const r = installHooksSync({ repoRoot: repo, port: o.port });
  out(`Hooks instalados en ${r.settingsPath} (puerto ${o.port}).`);
  out(`Mientras no haya un servidor en el puerto ${o.port}, Claude Code va a mostrar "hook error" en cada herramienta.`);
  out('Quitalos con "neu uninstall".');
  return 0;
}

function cmdUninstall(positionals: string[]): number {
  const repo = resolveRepo(positionals[0]);
  const lock = readLock(repo);
  if (lock?.alive && lock.pid !== process.pid) {
    out(`Aviso: Neurons sigue corriendo sobre este repo (PID ${lock.pid}).`);
  }
  const legacy = readLegacyLock(repo);
  if (legacy?.alive && legacy.pid !== process.pid) {
    out(`Aviso: la versión anterior (repo-synapse) sigue corriendo sobre este repo (PID ${legacy.pid}).`);
  }
  const r = undoInstall(repo);
  out(r.hooksChanged ? 'Hooks quitados.' : 'No había hooks de Neurons para quitar.');
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
  if (!fs.existsSync(file)) fail(`No hay registro para reproducir: ${file} no existe.`);

  const webDir = resolveWebDir();
  if (!webDir) err('Aviso: la interfaz web no está compilada (npm run build:web).');
  const server = await startNeuronsServer({
    root,
    port: o.port,
    portStrict: o.strictPort,
    mode: 'replay',
    replayFile: file,
    ...(webDir ? { webDir } : {}),
    onError: onServerError,
  });
  out(`Neurons (replay) escuchando en ${server.url}`);
  out(`Registro: ${file}`);
  out('Ctrl+C para salir.');
  if (o.open) void openBrowser(server.url);
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
  out(`Neurons ${version()}: diagnóstico de ${repo}`);
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

// ---------------------------------------------------------------- ls / open / stop

/** `p` ready to paste in a shell: single-quoted when it has anything but plain path characters. */
function shellArg(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
}

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
    ['Repositorio', 'Puerto', 'URL', 'PID', 'Desde'],
    ...viewers.map((v) => [homeShort(v.repo), String(v.port), v.url, String(v.pid), formatSince(v.startedAt)]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '));
}

function cmdLs(positionals: string[]): number {
  if (positionals.length > 0) fail('"neu ls" no lleva argumentos: lista todos los visores.');
  const viewers = listViewers();
  if (viewers.length === 0) {
    out('No hay visores corriendo.');
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
    if (!target) fail(`No hay un visor de Neurons corriendo sobre ${repo}.\nArrancalo con: neu start ${shellArg(repo)}`);
  }
  const viewers = target ? [] : listViewers();
  if (!target) {
    // Like `stop`: the viewer of the repo you are in. Otherwise the only one running.
    const here = cwdRepo();
    target = here === undefined ? undefined : viewerForRepo(here, viewers);
  }
  if (!target) {
    if (viewers.length === 0) fail('No hay visores corriendo. Arrancá uno con "neu" dentro del repositorio.');
    if (viewers.length > 1) {
      out('Hay varios visores corriendo:');
      out('');
      for (const line of viewersTable(viewers)) out(`  ${line}`);
      out('');
      out('Indicá cuál querés abrir: neu open <repo>');
      return 1;
    }
    target = viewers[0]!;
  }
  out(`Abriendo ${target.url} (${homeShort(target.repo)}).`);
  return (await openBrowser(target.url)) ? 0 : 1;
}

/** Stops one viewer and returns what to print. `ok` false makes `stop` exit 1. */
async function stopOne(t: StopTarget & { repo: string }, force: boolean): Promise<{ ok: boolean; info: string[]; warn: string[] }> {
  const where = `${homeShort(t.repo)} (PID ${t.pid})`;
  const r = await stopViewer(t, { force });
  switch (r.status) {
    case 'stopped': {
      // The viewer removes its hooks before exiting; leftovers mean its cleanup failed.
      const info = [`Visor de ${where} cerrado.`];
      const lock = readLock(t.repo);
      if (readManifest(t.repo) && !lock?.alive) {
        return { ok: false, info, warn: [`Quedaron hooks de Neurons en ${t.repo}: quitalos con "neu uninstall ${shellArg(t.repo)}".`] };
      }
      return { ok: true, info, warn: [] };
    }
    case 'timeout':
      return {
        ok: false,
        info: [],
        warn: [
          `El visor de ${where} no se cerró en ${STOP_TIMEOUT_MS / 1000} s.`,
          `Revisá con "neu ls" en un rato, o forzalo con "neu stop --force ${shellArg(t.repo)}" (después quita sus hooks).`,
        ],
      };
    case 'killed': {
      const info = [`Visor de ${where} terminado con SIGKILL.`];
      const warn: string[] = [];
      let ok = true;
      try {
        removeViewerEntry(t.pid);
        const lock = readLock(t.repo);
        if (lock && lock.pid === t.pid && !lock.alive) fs.rmSync(lockPath(t.repo), { force: true });
        const u = undoInstall(t.repo);
        info.push(u.hooksChanged ? 'Hooks quitados.' : 'No había hooks de Neurons para quitar.');
        const msg = bashDiffMessages(u.bashDiff);
        info.push(...msg.info);
        warn.push(...msg.warn);
        if (msg.warn.length > 0) ok = false;
      } catch (e) {
        warn.push(`No se pudieron quitar los hooks: ${(e as Error).message}`, `Ejecutá "neu uninstall ${shellArg(t.repo)}" para limpiarlos.`);
        ok = false;
      }
      return { ok, info, warn };
    }
    case 'not-viewer':
      return { ok: false, info: [], warn: [`El PID ${t.pid} anotado para ${homeShort(t.repo)} no es un visor de Neurons: no se le envió ninguna señal.`] };
    case 'error':
      return { ok: false, info: [], warn: [`No se pudo cerrar el visor de ${where}: ${r.message}`] };
  }
}

async function cmdStop(positionals: string[], o: Options): Promise<number> {
  let targets: Array<StopTarget & { repo: string }>;
  if (o.all) {
    if (positionals.length > 0) fail('"neu stop --all" no lleva repo: cierra todos los visores.');
    targets = listViewers().map((v) => ({ pid: v.pid, cmd: v.cmd, startedAt: v.startedAt, repo: v.repo, ...(v.command ? { command: v.command } : {}) }));
    if (targets.length === 0) {
      out('No hay visores corriendo.');
      return 0;
    }
  } else {
    const repo = resolveRepo(positionals[0]);
    const v = viewerForRepo(repo) ?? viewerFromLock(repo);
    if (!v) {
      out(`No hay un visor de Neurons corriendo sobre ${repo}.`);
      return 1;
    }
    targets = [{ pid: v.pid, cmd: v.cmd, startedAt: v.startedAt, repo, ...(v.command ? { command: v.command } : {}) }];
  }
  if (targets.length > 1) out(`Cerrando ${targets.length} visores...`);
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
  const r = route(argv, isDirectoryArg, isFileArg);
  if (r.kind === 'version') {
    out(version());
    return 0;
  }
  if (r.kind === 'help') {
    out(HELP);
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
    err(e instanceof CliError ? e.message : `Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
