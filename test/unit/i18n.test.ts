import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLang, dictionaries, getLang, langArg, onLangChange, parseLang, setLang, t, tn } from '../../src/i18n.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

afterEach(() => setLang('en'));

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(e.parentPath, e.name));
}

describe('CLI dictionaries', () => {
  const { en, es } = dictionaries();

  it('en and es have the same keys, all non-empty', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const dict of [en, es]) for (const [k, v] of Object.entries(dict)) expect(v.trim(), k).not.toBe('');
  });

  it('use the same {params} in both languages', () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en)) expect(params(es[k] as string), k).toEqual(params(en[k] as string));
  });

  it('have no em or en dashes', () => {
    for (const dict of [en, es]) for (const [k, v] of Object.entries(dict)) expect(v, k).not.toMatch(/[\u2013\u2014]/);
  });

  it('every literal key used in src exists, and the dynamic families are complete', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1] as string);
      for (const m of text.matchAll(/\btn\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        used.add(`${m[1]}.one`);
        used.add(`${m[1]}.other`);
      }
    }
    expect(used.size).toBeGreaterThan(50);
    for (const k of used) expect(en, k).toHaveProperty([k]);
    for (const s of ['ok', 'info', 'warn', 'error']) expect(en).toHaveProperty([`doctor.status.${s}`]);
    for (const s of ['managed', 'user', 'project', 'local']) {
      expect(en).toHaveProperty([`doctor.scope.${s}`]);
      expect(en).toHaveProperty([`doctor.scopeColumn.${s}`]);
    }
    for (const a of ['open', 'install']) expect(en).toHaveProperty([`legacy.action.${a}`]);
  });
});

describe('language detection', () => {
  it('--lang wins over NEURONS_LANG, which wins over the locale', () => {
    expect(detectLang(['start', '--lang', 'es'], { NEURONS_LANG: 'en', LANG: 'en_US.UTF-8' })).toBe('es');
    expect(detectLang(['--lang=en'], { NEURONS_LANG: 'es' })).toBe('en');
    expect(detectLang([], { NEURONS_LANG: 'es', LANG: 'en_US.UTF-8' })).toBe('es');
    expect(detectLang([], { NEURONS_LANG: 'EN', LANG: 'es_AR.UTF-8' })).toBe('en');
  });

  it('LC_ALL, then LC_MESSAGES, then LANG; "es*" is Spanish, anything else English', () => {
    expect(detectLang([], { LANG: 'es_AR.UTF-8' })).toBe('es');
    expect(detectLang([], { LC_MESSAGES: 'es_ES', LANG: 'en_US' })).toBe('es');
    expect(detectLang([], { LC_ALL: 'C', LC_MESSAGES: 'es_ES', LANG: 'es_AR' })).toBe('en');
    expect(detectLang([], { LC_ALL: '', LANG: 'es' })).toBe('es');
    expect(detectLang([], { LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLang([], {}, '')).toBe('en');
  });

  it('with no locale variable set, the system locale decides (Windows terminals, GUI shells)', () => {
    expect(detectLang([], {}, 'es-AR')).toBe('es');
    expect(detectLang([], { LANG: '' }, 'es-ES')).toBe('es');
    expect(detectLang([], {}, 'en-US')).toBe('en');
    expect(detectLang([], {}, 'pt-BR')).toBe('en');
    // A variable that is set wins over the system locale, and so do NEURONS_LANG and --lang.
    expect(detectLang([], { LANG: 'en_US.UTF-8' }, 'es-AR')).toBe('en');
    expect(detectLang([], { LC_ALL: 'C' }, 'es-AR')).toBe('en');
    expect(detectLang([], { NEURONS_LANG: 'en' }, 'es-AR')).toBe('en');
    expect(detectLang(['--lang', 'en'], {}, 'es-AR')).toBe('en');
  });

  it('an invalid --lang or NEURONS_LANG falls through; --lang after -- is not an option', () => {
    expect(detectLang(['--lang', 'fr'], { LANG: 'es_AR' })).toBe('es');
    expect(detectLang([], { NEURONS_LANG: 'xx', LANG: 'es_AR' })).toBe('es');
    expect(langArg(['--', '--lang', 'es'])).toBeUndefined();
    expect(parseLang('es_AR.UTF-8')).toBe('es');
    expect(parseLang('pt')).toBeUndefined();
  });
});

describe('t / tn / setLang', () => {
  it('interpolates params, falls back to the key, and switches language', () => {
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t('start.listening', { url: 'http://x' })).toBe('Neurons listening on http://x');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(t('start.portBusy', { port: 1 })).toBe('Port 1 is taken: using {actual}.');
    const seen: string[] = [];
    const off = onLangChange((l) => seen.push(l));
    setLang('es');
    setLang('es');
    off();
    setLang('en');
    expect(seen).toEqual(['es']);
    setLang('es');
    expect(t('start.listening', { url: 'http://x' })).toBe('Neurons escuchando en http://x');
  });

  it('plural keys by count', () => {
    setLang('es');
    expect(tn('sessions.found', 1, { pids: '7' })).toBe('Hay 1 sesión de Claude Code abierta en este repositorio (PID 7).');
    expect(tn('sessions.found', 2, { pids: '7, 9' })).toBe('Hay 2 sesiones de Claude Code abiertas en este repositorio (PID 7, 9).');
    setLang('en');
    expect(tn('sessions.found', 3, { pids: '1, 2, 3' })).toBe('There are 3 Claude Code sessions open in this repository (PID 1, 2, 3).');
  });

  it('doctor counts agree with a count of one in both languages', () => {
    const summary = (errors: number, warns: number) => t('doctor.summary', { errors: tn('doctor.errors', errors), warns: tn('doctor.warns', warns) });
    setLang('en');
    expect(tn('doctor.bashDiff.owners', 1)).toBe('Neurons turned on bashEditDiffEnabled; 1 open viewer uses it.');
    expect(tn('doctor.bashDiff.owners', 2)).toBe('Neurons turned on bashEditDiffEnabled; 2 open viewers use it.');
    expect(summary(1, 0)).toBe('1 error and 0 warnings.');
    setLang('es');
    expect(tn('doctor.bashDiff.owners', 1)).toBe('Neurons activó bashEditDiffEnabled; lo usa 1 visor abierto.');
    expect(tn('doctor.bashDiff.owners', 3)).toBe('Neurons activó bashEditDiffEnabled; lo usan 3 visores abiertos.');
    expect(summary(1, 0)).toBe('1 error y 0 avisos.');
    expect(summary(2, 1)).toBe('2 errores y 1 aviso.');
  });
});
