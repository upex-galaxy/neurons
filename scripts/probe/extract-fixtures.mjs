#!/usr/bin/env node
// Turns a recorder JSONL into test fixtures: replaces the probe repo root with
// __REPO__ and the home directory with __HOME__ so tests can re-root them.
// Usage: node scripts/probe/extract-fixtures.mjs <run.jsonl> <repoRoot> <outDir> <name>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runFile, repoRoot, outDir, name] = process.argv.slice(2);
if (!runFile || !repoRoot || !outDir || !name) {
  console.error('usage: extract-fixtures <run.jsonl> <repoRoot> <outDir> <name>');
  process.exit(1);
}
const root = fs.realpathSync(repoRoot);
const home = os.homedir();
const scrub = (s) => s.split(root).join('__REPO__').split(home).join('__HOME__');

const lines = fs.readFileSync(runFile, 'utf8').trim().split('\n');
const bodies = lines.map((l) => JSON.parse(scrub(l)).body);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${name}.jsonl`), bodies.map((b) => JSON.stringify(b)).join('\n') + '\n');
console.log(`${bodies.length} payloads -> ${name}.jsonl`);
