#!/usr/bin/env node
// Embeds the docs dictionaries into their pages, between the "i18n:embedded:start" and
// "i18n:embedded:end" markers:
//   docs/i18n/guide.{en,es}.json         -> docs/guide.html         (#guide-i18n)
//   docs/i18n/architecture.{en,es}.json  -> docs/architecture.html  (#architecture-i18n)
// The pages read that copy when they are opened from disk (file://), where browsers block
// fetch; served over http they load the JSON files themselves. Run it after editing the
// dictionaries.
//
// Usage: node scripts/sync-guide-i18n.mjs [--check]
//   --check  exits with 1 if an embedded copy is out of date, without writing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['en', 'es'];
/** Each docs page with embedded dictionaries: its file and its dictionary name (the script id is `<name>-i18n`). */
export const PAGES = [
  { file: 'guide.html', name: 'guide' },
  { file: 'architecture.html', name: 'architecture' },
];

function block(name) {
  return new RegExp(`(<!-- i18n:embedded:start[^>]*-->\\s*<script type="application\\/json" id="${name}-i18n">)([\\s\\S]*?)(<\\/script>)`);
}

/** The JSON text embedded in a page: both dictionaries, with "<" escaped so no "</script>" can appear. */
export function embeddedJson(root = ROOT, name = 'guide') {
  const dicts = {};
  for (const lang of LANGS) {
    dicts[lang] = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'i18n', `${name}.${lang}.json`), 'utf8'));
  }
  return JSON.stringify(dicts).replace(/</g, '\\u003c');
}

function main() {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const { file, name } of PAGES) {
    const page = path.join(ROOT, 'docs', file);
    const html = fs.readFileSync(page, 'utf8');
    const re = block(name);
    const match = re.exec(html);
    if (!match) {
      console.error(`sync-guide-i18n: markers not found in docs/${file}`);
      process.exit(1);
    }
    const json = embeddedJson(ROOT, name);
    if (match[2] === json) {
      console.log(`sync-guide-i18n: docs/${file} up to date`);
      continue;
    }
    if (check) {
      console.error(`sync-guide-i18n: docs/${file} is out of date; run node scripts/sync-guide-i18n.mjs`);
      stale = true;
      continue;
    }
    fs.writeFileSync(page, html.replace(re, (_, open, _old, close) => open + json + close));
    console.log(`sync-guide-i18n: docs/${file} updated`);
  }
  if (stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
