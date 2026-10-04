import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/build-docs.mjs');
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function build(src: string, out: string): string {
  return execFileSync(process.execPath, [SCRIPT, '--src', src, '--out', out], { encoding: 'utf8' });
}

describe('scripts/build-docs.mjs', () => {
  it('copies the pages, their dictionaries and images', () => {
    const src = tmp('rs-docsrc-');
    const out = path.join(tmp('rs-docsout-'), 'docs');
    fs.writeFileSync(path.join(src, 'guide.html'), '<title>g</title>');
    fs.writeFileSync(path.join(src, 'architecture.html'), '<title>a</title>');
    fs.writeFileSync(path.join(src, 'arquitectura.html'), 'old page, not copied');
    fs.mkdirSync(path.join(src, 'i18n'));
    for (const f of ['guide.en.json', 'guide.es.json', 'notes.txt']) fs.writeFileSync(path.join(src, 'i18n', f), '{}');
    fs.mkdirSync(path.join(src, 'img'));
    fs.writeFileSync(path.join(src, 'img', 'a.png'), 'png');
    build(src, out);
    expect(fs.readdirSync(out).sort()).toEqual(['architecture.html', 'guide.html', 'i18n', 'img']);
    expect(fs.readdirSync(path.join(out, 'i18n')).sort()).toEqual(['guide.en.json', 'guide.es.json']);
    expect(fs.readdirSync(path.join(out, 'img'))).toEqual(['a.png']);
  });

  it('succeeds without the pages, says what it skipped, and drops pages removed since the last build', () => {
    const src = tmp('rs-docsrc-');
    const out = path.join(tmp('rs-docsout-'), 'docs');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'guide.html'), 'stale');
    const log = build(src, out);
    expect(log).toContain('skipped');
    expect(log).toContain('guide.html');
    expect(fs.existsSync(path.join(out, 'guide.html'))).toBe(false);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
