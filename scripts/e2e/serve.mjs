#!/usr/bin/env node
// Playwright webServer launcher: builds a throwaway repo under os.tmpdir() and runs the
// real CLI (dist/cli.mjs) on it. Usage: node scripts/e2e/serve.mjs <live|replay|perf> <port>
//
//   live    probe repo (docs/PAYLOADS.md layout), `start --no-install`
//   replay  probe repo; records a real log first (`start` + run1 fixtures posted 200 ms
//           apart), then serves it with `replay`
//   perf    synthetic repo with 2,000 files, `start --no-install`
//
// Every run points CLAUDE_CONFIG_DIR at a temp dir holding a sentinel settings.json, and
// on exit checks that neither that file nor <repo>/.claude/settings.local.json changed.
// The whole temp dir is removed on SIGTERM/SIGINT.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eDir, fixturePayloads, makePerfRepo, makeProbeRepo, SENTINEL_SETTINGS } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../../dist/cli.mjs');

const [mode, portArg] = process.argv.slice(2);
if (!['live', 'replay', 'perf'].includes(mode ?? '') || !/^\d+$/.test(portArg ?? '')) {
  process.stderr.write('Uso: node scripts/e2e/serve.mjs <live|replay|perf> <puerto>\n');
  process.exit(2);
}
if (!fs.existsSync(CLI)) {
  process.stderr.write('Falta dist/cli.mjs: ejecutá npm run build antes de las pruebas e2e.\n');
  process.exit(2);
}
const port = Number(portArg);
const base = path.join(e2eDir(), mode);
const repo = path.join(base, 'repo');
const configDir = path.join(base, 'claude-config');
const settingsFile = path.join(configDir, 'settings.json');

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(settingsFile, SENTINEL_SETTINGS);
if (mode === 'perf') makePerfRepo(repo, 2000);
else makeProbeRepo(repo);
const realRepo = fs.realpathSync(repo);

const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, REPO_SYNAPSE_DEBUG: '1' };

/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
let stopping = false;

function runCli(args) {
  const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  child = c;
  return c;
}

function waitExit(c) {
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) resolve(c.exitCode);
    else c.once('exit', (code) => resolve(code));
  });
}

async function waitHealth(p, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`el servidor no respondió en el puerto ${p}`);
}

/**
 * Records a real events.jsonl: live server + run1 payloads with a gap between posts. It
 * listens on another port so Playwright does not see /health before the replay is up.
 */
async function recordLog() {
  const recPort = port + 100;
  const c = runCli(['start', realRepo, '--no-open', '--no-install', '--no-bash-diff', '--strict-port', '--port', String(recPort)]);
  await waitHealth(recPort);
  for (const body of fixturePayloads('run1.jsonl', realRepo, path.join(base, 'home'))) {
    const res = await fetch(`http://127.0.0.1:${recPort}/hook?src=repo-synapse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (res.status !== 204) throw new Error(`POST /hook devolvió ${res.status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  // Let the server write the last lines, then stop it.
  await new Promise((r) => setTimeout(r, 300));
  c.kill('SIGTERM');
  await waitExit(c);
}

/** Removes this mode's dir and, when it was the last one, the run's temp root. */
function cleanup() {
  fs.rmSync(base, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(base));
  } catch {
    /* other modes still running */
  }
}

function verifyUntouched() {
  const problems = [];
  if (!fs.existsSync(settingsFile) || fs.readFileSync(settingsFile, 'utf8') !== SENTINEL_SETTINGS) problems.push(`${settingsFile} cambió`);
  if (fs.existsSync(path.join(realRepo, '.claude', 'settings.local.json'))) problems.push('se creó .claude/settings.local.json');
  for (const p of problems) process.stderr.write(`[e2e] ERROR: ${p} con --no-install\n`);
  return problems.length === 0;
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    await waitExit(child);
  }
  const ok = verifyUntouched();
  cleanup();
  process.exit(ok ? 0 : 1);
}

for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => void stop(s === 'SIGHUP' ? 'SIGTERM' : s));

try {
  if (mode === 'replay') {
    await recordLog();
    runCli(['replay', realRepo, '--no-open', '--strict-port', '--port', String(port)]);
  } else {
    runCli(['start', realRepo, '--no-open', '--no-install', '--no-bash-diff', '--strict-port', '--port', String(port)]);
  }
  child?.once('exit', (code) => {
    if (stopping) return;
    process.stderr.write(`[e2e] el CLI terminó solo (código ${code})\n`);
    cleanup();
    process.exit(1);
  });
} catch (e) {
  process.stderr.write(`[e2e] ${e instanceof Error ? e.message : String(e)}\n`);
  child?.kill('SIGTERM');
  cleanup();
  process.exit(1);
}
