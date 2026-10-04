// Shared by the e2e launcher (serve.mjs) and the Playwright specs: temp dirs, the probe
// repo of phase 0 and the recorded hook payloads re-rooted to a real directory.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(HERE, '../../test/fixtures/payloads');

/** One server per mode, started by playwright.config.ts. */
export const E2E_PORTS = { live: 7791, replay: 7792, perf: 7793 };

/** Settings file written into the temp CLAUDE_CONFIG_DIR; it must never change. */
export const SENTINEL_SETTINGS = '{\n  "e2eSentinel": true\n}\n';

/** Files of the phase 0 probe repo (docs/PAYLOADS.md). */
export const PROBE_FILES = {
  'CLAUDE.md': '# Probe\n',
  'src/CLAUDE.md': '# src rules\n',
  '.claude/rules/api.md': '---\npaths: src/api/**/*.ts\n---\n',
  'src/api/user.ts': "export function getUser(id: string) {\n  // TODO: validate id\n  return { id, name: 'Ada' };\n}\n",
  'src/api/order.ts': 'export function getOrder(id: string) {\n  return { id, total: 42 };\n}\n',
  'src/utils/format.ts': 'export function formatMoney(n: number) {\n  // TODO: locale\n  return `$${n.toFixed(2)}`;\n}\n',
  'src/utils/legacy.ts': 'legacy\n',
  'docs/old.md': 'old notes\n',
};

/** Root of every e2e temp dir for this Playwright run (set by playwright.config.ts). */
export function e2eDir() {
  const dir = process.env.RS_E2E_DIR;
  if (!dir) throw new Error('RS_E2E_DIR is not set: run the tests with playwright test');
  return dir;
}

/** Absolute repo path used by a launcher mode (the realpath, as the server sees it). */
export function e2eRepo(mode) {
  return fs.realpathSync(path.join(e2eDir(), mode, 'repo'));
}

function git(repo, args) {
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
}

function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** Git repo with the probe files, committed. */
export function makeProbeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  writeFiles(repo, PROBE_FILES);
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'probe']);
}

/** Git repo with `count` small files spread over nested dirs (about 20 files per dir). */
export function makePerfRepo(repo, count) {
  fs.mkdirSync(repo, { recursive: true });
  const files = {};
  for (let i = 0; i < count; i++) {
    const a = Math.floor(i / 400);
    const b = Math.floor(i / 20) % 20;
    files[`pkg${a}/mod${b}/file${i}.ts`] = `export const v${i} = ${i};\n`;
  }
  files['README.md'] = '# perf\n';
  writeFiles(repo, files);
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'perf']);
  return Object.keys(files);
}

/** Raw payload lines of a fixture file with __REPO__ and __HOME__ replaced. */
export function fixturePayloads(name, repo, home) {
  return fs
    .readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.replaceAll('__REPO__', repo).replaceAll('__HOME__', home));
}
