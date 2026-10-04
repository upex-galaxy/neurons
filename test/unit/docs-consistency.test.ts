import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Cross-file consistency of the docs: one version everywhere, the guide's ?lang=, no
// dead images, no dangling DEMO.md, and the same open-session fallback in every place.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, string>;

describe('docs version', () => {
  const version = (JSON.parse(read('package.json')) as { version: string }).version;

  it('is the package version in every footer and heading that names one', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const lang of ['en', 'es']) {
      expect(json(`docs/i18n/guide.${lang}.json`)['footer.text']).toContain(`Neurons ${version} `);
      expect(json(`docs/i18n/architecture.${lang}.json`)['page.footer']).toContain(`Neurons ${version} `);
    }
    expect(read('docs/architecture.html')).toContain(`<span data-i18n="page.footer">Neurons ${version} `);
    const minor = version.split('.').slice(0, 2).join('.');
    expect(read('docs/DECISIONS.md')).toContain(`## Round 4: ${minor}.0 `);
  });

  it('never shortens a release to two parts (0.3 instead of 0.3.0)', () => {
    const shortRelease = /\b(?:Neurons|in|since|Round \d+:|changed in) 0\.\d+(?![.\d])/;
    for (const rel of ['docs/DECISIONS.md', 'docs/IMPLEMENTATION_PLAN.md', 'docs/i18n/guide.en.json', 'docs/i18n/guide.es.json',
      'docs/i18n/architecture.en.json', 'docs/i18n/architecture.es.json', 'README.md', 'README.es.md']) {
      expect(read(rel), rel).not.toMatch(shortRelease);
    }
  });
});

describe('docs/guide.html language', () => {
  it('reads ?lang= before the stored choice and the browser language, like the architecture page', () => {
    const page = read('docs/guide.html');
    const fn = /function detectLang\(\) \{([\s\S]*?)\n {4}\}/.exec(page)?.[1] ?? '';
    const query = fn.indexOf("new URLSearchParams(location.search).get('lang')");
    expect(query).toBeGreaterThan(-1);
    expect(query).toBeLessThan(fn.indexOf('readStored()'));
    expect(fn.indexOf('readStored()')).toBeLessThan(fn.indexOf('navigator.language'));
  });
});

describe('docs/img', () => {
  it('holds only images a page or README references (build-docs ships the whole folder)', () => {
    const sources = ['README.md', 'README.es.md', 'docs/guide.html', 'docs/architecture.html',
      ...fs.readdirSync(path.join(ROOT, 'docs/i18n')).map((f) => `docs/i18n/${f}`)].map(read).join('\n');
    const images = fs.readdirSync(path.join(ROOT, 'docs/img'));
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(sources, `docs/img/${img} is not referenced`).toContain(`img/${img}`);
  });
});

describe('removed docs/DEMO.md', () => {
  it('is gone, and every doc that still names it points to the guide', () => {
    expect(fs.existsSync(path.join(ROOT, 'docs/DEMO.md'))).toBe(false);
    for (const rel of ['docs/DECISIONS.md', 'docs/IMPLEMENTATION_PLAN.md', 'README.md', 'README.es.md']) {
      const text = read(rel);
      if (!text.includes('DEMO.md')) continue;
      expect(text, rel).toContain('`docs/DEMO.md` was removed in 0.3.0');
      expect(text, rel).toContain('docs/guide.html#faq-demo');
      expect(text, rel).toContain('#faq-demo-small');
    }
    const guide = read('docs/guide.html');
    expect(guide).toContain('id="faq-demo"');
    expect(guide).toContain('id="faq-demo-small"');
  });
});

describe('open-session fallback', () => {
  /** True when `text` names the three steps in order: live, /reload-plugins, /exit + claude --continue. */
  const ordered = (text: string) => {
    const reload = text.indexOf('/reload-plugins');
    const exit = text.indexOf('/exit');
    return reload > -1 && exit > reload && text.indexOf('claude --continue') > exit;
  };

  it('the start notice offers /reload-plugins first, then /exit and claude --continue, in both languages', () => {
    for (const lang of ['en', 'es']) {
      const d = json(`src/i18n/${lang}.json`);
      for (const key of ['sessions.restart.one', 'sessions.restart.other']) expect(ordered(d[key] ?? ''), `${lang} ${key}`).toBe(true);
      for (const key of ['sessions.live.one', 'sessions.live.other', 'sessions.unknown']) {
        expect(d[key], `${lang} ${key}`).toContain('{version}');
        expect(d[key], `${lang} ${key}`).toContain('macOS');
      }
      // No longer framed as something only older versions need.
      expect(d['sessions.restart.one']).not.toMatch(/older version|versión anterior/);
    }
  });

  it('the guide FAQ, the architecture page, the READMEs and DECISIONS say the same', () => {
    for (const lang of ['en', 'es']) {
      const faq = json(`docs/i18n/guide.${lang}.json`)['faq.restart.a'] ?? '';
      expect(ordered(faq), `guide ${lang}`).toBe(true);
      expect(faq).toContain('2.1.288');
      expect(faq).toContain('macOS');
      expect(ordered(json(`docs/i18n/architecture.${lang}.json`)['ch2.p'] ?? ''), `architecture ${lang}`).toBe(true);
    }
    expect(ordered(read('README.md'))).toBe(true);
    expect(ordered(read('README.es.md'))).toBe(true);
    const row = read('docs/DECISIONS.md').split('\n').find((l) => l.startsWith('| I') && l.includes('Open-session fallback'));
    expect(row && ordered(row)).toBe(true);
    expect(row).toContain('reported by the user');
  });
});

describe('scripts/e2e/serve.mjs', () => {
  it('prints its messages in English (developer tool)', () => {
    for (const file of ['scripts/e2e/serve.mjs', 'scripts/e2e/fixtures.mjs']) {
      const src = read(file);
      expect(src, file).not.toMatch(/[áéíóúñ¿¡]/);
      expect(src, file).not.toMatch(/\b(Uso|Falta|cambió|devolvió|respondió|terminó|puerto|definido)\b/);
    }
  });
});

describe('privacy claims', () => {
  it('the READMEs no longer say only paths are handled (commands are stored, redacted)', () => {
    expect(read('README.md')).not.toMatch(/only handles paths/);
    expect(read('README.es.md')).not.toMatch(/solo maneja rutas/);
    expect(read('README.md')).toMatch(/Bash commands/);
    expect(read('README.es.md')).toMatch(/comandos de Bash/);
  });

  it('faq.restart says open sessions are listed on macOS and Linux only', () => {
    const en = JSON.parse(read('docs/i18n/guide.en.json')) as Record<string, string>;
    const es = JSON.parse(read('docs/i18n/guide.es.json')) as Record<string, string>;
    expect(en['faq.restart.a']).toMatch(/on macOS and Linux/);
    expect(es['faq.restart.a']).toMatch(/en macOS y Linux/);
  });

  it('DECISIONS records the round-4 redaction and the Linux watcher (I51)', () => {
    const d = read('docs/DECISIONS.md');
    expect(d).toMatch(/\| I51 \|/);
    expect(d).toMatch(/redactSecrets/);
    expect(d).toMatch(/one non-recursive watch per directory/);
  });
});
