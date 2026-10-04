#!/usr/bin/env node
// Copies the static docs pages into dist/docs, where the viewer serves them:
//   docs/guide.html         -> dist/docs/guide.html         (GET /help)
//   docs/architecture.html  -> dist/docs/architecture.html  (GET /architecture)
//   docs/i18n/*.json        -> dist/docs/i18n/
//   docs/img/*              -> dist/docs/img/
// A missing source is skipped with a note, so the build works before the pages exist.
//
// Usage: node scripts/build-docs.mjs [--src <docs dir>] [--out <output dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
}

const src = option('--src', path.join(ROOT, 'docs'));
const out = option('--out', path.join(ROOT, 'dist', 'docs'));

/** Files directly inside `dir` (no recursion), optionally filtered by extension. */
function filesIn(dir, ext) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (!ext || e.name.toLowerCase().endsWith(ext)))
      .map((e) => e.name)
      .sort();
  } catch {
    return undefined;
  }
}

// Start clean: a page removed from docs/ must not keep being served.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let copied = 0;
for (const page of ['guide.html', 'architecture.html']) {
  const from = path.join(src, page);
  if (!fs.existsSync(from)) {
    console.log(`build-docs: skipped ${path.relative(ROOT, from) || from} (not found)`);
    continue;
  }
  fs.copyFileSync(from, path.join(out, page));
  copied++;
}

for (const [dir, ext] of [
  ['i18n', '.json'],
  ['img', undefined],
]) {
  const names = filesIn(path.join(src, dir), ext);
  if (names === undefined || names.length === 0) {
    console.log(`build-docs: skipped ${dir}/ (nothing to copy)`);
    continue;
  }
  fs.mkdirSync(path.join(out, dir), { recursive: true });
  for (const name of names) {
    fs.copyFileSync(path.join(src, dir, name), path.join(out, dir, name));
    copied++;
  }
}

console.log(`build-docs: ${copied} file(s) copied to ${path.relative(ROOT, out) || out}`);
