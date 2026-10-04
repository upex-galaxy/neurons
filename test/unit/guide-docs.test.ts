// Checks for the user guide (docs/guide.html) and the READMEs: dictionaries in sync, every
// key the page uses exists, the embedded copy matches the JSON files, internal links resolve,
// and the setup prompt in the READMEs is the same one the guide shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANGS = ['en', 'es'] as const;
const DASHES = /[–—]/;

const html = fs.readFileSync(path.join(ROOT, 'docs/guide.html'), 'utf8');
const dicts = Object.fromEntries(
  LANGS.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `docs/i18n/guide.${l}.json`), 'utf8')) as Record<string, string>]),
) as Record<(typeof LANGS)[number], Record<string, string>>;

/** Keys the page markup asks for through data-i18n, data-i18n-html and data-i18n-attr. */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]!);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1]!.split(';')) keys.add(pair.split(':')[1]!.trim());
  }
  // Read by the script: t('copy.button'), t('meta.title')...
  for (const m of html.matchAll(/\bt\('([a-z][\w.-]*)'\)/g)) keys.add(m[1]!);
  return keys;
}

describe('docs/guide.html dictionaries', () => {
  it('has the same keys in English and Spanish, none empty', () => {
    expect(Object.keys(dicts.es).sort()).toEqual(Object.keys(dicts.en).sort());
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(dicts[lang])) {
        expect(value.trim(), `${lang} ${key}`).not.toBe('');
      }
    }
  });

  it('uses no em or en dashes', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(dicts[lang])) {
        expect(DASHES.test(value), `${lang} ${key}`).toBe(false);
      }
    }
    expect(DASHES.test(html)).toBe(false);
  });

  it('defines every key the page uses, and the page uses every key', () => {
    const used = usedKeys();
    for (const key of used) expect(dicts.en, key).toHaveProperty([key]);
    for (const key of Object.keys(dicts.en)) expect(used.has(key), `unused key ${key}`).toBe(true);
  });

  it('embeds the current dictionaries (node scripts/sync-guide-i18n.mjs)', () => {
    const m = /<script type="application\/json" id="guide-i18n">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(JSON.stringify(dicts).replace(/</g, '\\u003c'));
  });

  it('gives every FAQ entry a unique id and resolves every in-page link', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const faq = ids.filter((id) => id.startsWith('faq-') && id !== 'faq-search' && id !== 'faq-empty');
    expect(faq.length).toBeGreaterThanOrEqual(20);
    for (const lang of LANGS) {
      for (const value of Object.values(dicts[lang])) {
        for (const m of value.matchAll(/href="#([^"]+)"/g)) expect(ids, `${lang} #${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('keeps answer markup to the tags the page styles', () => {
    const allowed = new Set(['p', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span']);
    const htmlKeys = [...html.matchAll(/data-i18n-html="([^"]+)"/g)].map((m) => m[1]!);
    for (const lang of LANGS) {
      for (const key of htmlKeys) {
        const value = dicts[lang][key] ?? '';
        for (const m of value.matchAll(/<\/?([a-z0-9]+)/g)) expect(allowed.has(m[1]!), `${lang} ${key}: <${m[1]}>`).toBe(true);
        expect(/<script|on\w+=/i.test(value), `${lang} ${key}`).toBe(false);
      }
    }
  });
});

describe('READMEs', () => {
  const readmes = { en: 'README.md', es: 'README.es.md' } as const;

  it('show the same setup prompt as the guide, in their language', () => {
    for (const lang of LANGS) {
      const text = fs.readFileSync(path.join(ROOT, readmes[lang]), 'utf8');
      expect(text).toContain(dicts[lang]['ai.prompt']);
    }
  });

  it('link to each other, the guide and the architecture page, without dashes', () => {
    for (const lang of LANGS) {
      const text = fs.readFileSync(path.join(ROOT, readmes[lang]), 'utf8');
      expect(text).toContain(lang === 'en' ? '(README.es.md)' : '(README.md)');
      expect(text).toContain('(docs/guide.html)');
      expect(text).toContain('(docs/architecture.html)');
      expect(DASHES.test(text), readmes[lang]).toBe(false);
      for (const m of text.matchAll(/\]\(((?:docs|scripts)\/[^)#]+)/g)) {
        expect(fs.existsSync(path.join(ROOT, m[1]!)), `${readmes[lang]} -> ${m[1]}`).toBe(true);
      }
    }
  });
});
