// docs/architecture.html is bilingual: the markup carries the English text and every
// translatable element names its key (data-i18n, data-i18n-html, data-i18n-aria, or a CSS
// variable listed in <html data-i18n-vars>). These checks keep the page and its two
// dictionaries (docs/i18n/architecture.{en,es}.json) in step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');
const page = fs.readFileSync(path.join(DOCS, 'architecture.html'), 'utf8');
const load = (lang: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(DOCS, 'i18n', `architecture.${lang}.json`), 'utf8'));
const en = load('en');
const es = load('es');

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, '&');

/** The language script (the inline <script> right before the diagram controller). */
function languageScript(): string {
  const end = page.indexOf('<script data-diagram-controls>');
  const start = page.lastIndexOf('<script>', end);
  return page.slice(start, end);
}

/** The diagram controller, which stays byte-identical to the diagram-design template. */
function controller(): string {
  const start = page.indexOf('<script data-diagram-controls>');
  return page.slice(start, page.indexOf('</script>', start));
}

function cssVarKeys(): Map<string, string> {
  const attr = /<html[^>]*\sdata-i18n-vars="([^"]*)"/.exec(page)?.[1] ?? '';
  return new Map(attr.split(';').filter(Boolean).map((pair) => pair.split(':') as [string, string]).map(([name, key]) => [key, name]));
}

describe('architecture page dictionaries', () => {
  it('en and es have the same keys, all non-empty', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const dict of [en, es]) for (const [k, v] of Object.entries(dict)) expect(v.trim(), k).not.toBe('');
  });

  it('have no em or en dashes', () => {
    for (const dict of [en, es]) for (const [k, v] of Object.entries(dict)) expect(v, k).not.toMatch(/[–—]/);
  });

  it('every key the page uses exists, and every key is used', () => {
    const used = new Set([...page.matchAll(/data-i18n(?:-html|-aria)?="([^"]+)"/g)].map((m) => m[1] as string));
    for (const key of cssVarKeys().keys()) used.add(key);
    // Keys only the language script reads (the diagram status announcements).
    for (const m of languageScript().matchAll(/'(motion\.[\w.]+)'/g)) used.add(m[1] as string);
    expect([...used].filter((k) => !(k in en)), 'missing in the dictionaries').toEqual([]);
    expect(Object.keys(en).filter((k) => !used.has(k)), 'unused in the page').toEqual([]);
  });

  it('the English in the markup matches architecture.en.json', () => {
    let checked = 0;
    for (const m of page.matchAll(/data-i18n="([^"]+)">([^<]*)</g)) {
      expect(decode(m[2] as string), m[1]).toBe(en[m[1] as string]);
      checked++;
    }
    for (const m of page.matchAll(/aria-label="([^"]*)" data-i18n-aria="([^"]+)"/g)) {
      expect(decode(m[1] as string), m[2]).toBe(en[m[2] as string]);
      checked++;
    }
    for (const [key, name] of cssVarKeys()) {
      const value = new RegExp(`${name}:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(page)?.[1];
      expect(value && JSON.parse(value), key).toBe(en[key]);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('keeps a single diagram controller, apart from the language script', () => {
    expect(page.match(/<script data-diagram-controls>/g)).toHaveLength(1);
    // The language script runs before the controller and outside every figure.
    expect(page.indexOf('neurons.lang')).toBeLessThan(page.indexOf('<script data-diagram-controls>'));
    expect(page.lastIndexOf('</figure>')).toBeLessThan(page.indexOf('neurons.lang'));
  });
});

describe('architecture page offline and accessibility', () => {
  it('embeds the current dictionaries, so it switches language opened from disk (node scripts/sync-guide-i18n.mjs)', () => {
    const m = /<script type="application\/json" id="architecture-i18n">([\s\S]*?)<\/script>/.exec(page);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(JSON.stringify({ en, es }).replace(/</g, '\\u003c'));
    // The embedded copy comes before the script that reads it.
    expect(page.indexOf('id="architecture-i18n"')).toBeLessThan(page.indexOf('neurons.lang'));
  });

  it('translates every status the diagram controller announces', () => {
    const script = languageScript();
    const patterns = [...script.matchAll(/\[\/(\^[^\n]*?)\/, '(motion\.\w+)'\]/g)].map((m) => [new RegExp(m[1] as string), m[2] as string] as const);
    expect(patterns.length).toBe(7);
    const fill = (text: string) => text.replace('{step}', '3').replace('{count}', '6').replace('{label}', 'X');
    // The English dictionary says exactly what the controller writes, so the patterns match it.
    for (const [re, key] of patterns) {
      expect(en[key], key).toBeDefined();
      expect(re.test(fill(en[key] as string)), key).toBe(true);
    }
    // And the controller still writes those templates.
    const ctl = controller();
    for (const literal of ['`Step ${step} of ${count}: ', '`Paused at step ${step} of ${count}`', '`Complete · step ${count} of ${count}`', '`Ready · step ', '`Test frame · step ', "'Reduced motion · complete static frame · playback controls unavailable'", "'Static frame · complete diagram · playback controls unavailable'"]) {
      expect(ctl, literal).toContain(literal);
    }
  });

  it('shows the no-JavaScript note in both languages', () => {
    const notes = [...page.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map((m) => m[1] as string);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).toContain('lang="en"');
      expect(note).toContain('lang="es"');
    }
  });

  it('uses English ids, and every anchor, aria reference and marker resolves', () => {
    const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
    for (const id of ['lifecycle', 'event', 'attribution', 'network', 'machine']) expect(ids.has(id), id).toBe(true);
    for (const id of ids) expect(id, id).not.toMatch(/^(ciclo|evento|atribucion|red|maquina)\b/);
    expect(page).not.toMatch(/#(ciclo|evento|atribucion|red|maquina)\b/);
    const refs = new Set<string>();
    for (const m of page.matchAll(/href="#([^"]+)"/g)) refs.add(m[1] as string);
    for (const m of page.matchAll(/url\(#([^)]+)\)/g)) refs.add(m[1] as string);
    for (const m of page.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) for (const id of (m[1] as string).split(/\s+/)) refs.add(id);
    expect(refs.size).toBeGreaterThan(10);
    for (const ref of refs) expect(ids.has(ref), `#${ref}`).toBe(true);
  });
});
