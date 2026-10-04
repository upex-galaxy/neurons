import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_COLORS, type Action } from '../../src/shared/types.ts';
import { detectLang, dictionaries, getLang, interpolate, onLangChange, setLang, t, tn } from '../src/i18n.ts';
import { STREAM_ACTIONS } from '../src/labels.ts';

const { en, es } = dictionaries();

describe('dictionaries', () => {
  it('have the same keys in English and Spanish', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('have no empty values, no em or en dashes and balanced {params}', () => {
    for (const dict of [en, es]) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), key).not.toBe('');
        expect(value, key).not.toMatch(/[–—]/);
      }
    }
    for (const key of Object.keys(en)) {
      const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(params(es[key]!), key).toEqual(params(en[key]!));
    }
  });

  it('name every action, stream verb, phase and tool group', () => {
    for (const a of Object.keys(ACTION_COLORS) as Action[]) expect(en[`action.${a}`], a).toBeDefined();
    for (const a of STREAM_ACTIONS) expect(en[`stream.verb.${a}`], a).toBeDefined();
    for (const p of ['pre', 'post', 'fail', 'info']) expect(en[`phase.${p}`]).toBeDefined();
    for (const g of ['skills', 'mcp', 'cli', 'builtin']) expect(en[`tools.empty.${g}`]).toBeDefined();
    for (const k of ['builtin', 'mcp', 'skill']) expect(en[`tool.kind.${k}`]).toBeDefined();
  });

  it('keep plural pairs complete', () => {
    for (const key of Object.keys(en)) {
      if (key.endsWith('.one')) expect(en[key.replace(/\.one$/, '.other')], key).toBeDefined();
      if (key.endsWith('.other')) expect(en[key.replace(/\.other$/, '.one')], key).toBeDefined();
    }
  });
});

describe('t', () => {
  afterEach(() => setLang('en'));

  it('interpolates params and leaves unknown ones', () => {
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(interpolate('plain')).toBe('plain');
  });

  it('switches language, formats numbers and picks plural forms', () => {
    setLang('en');
    expect(t('toast.collapsed', { path: 'src/api' })).toBe('Collapsed src/api');
    expect(tn('toast.expanded', 1, { path: 'src/api' })).toBe('Opened src/api: 1 item');
    expect(tn('toast.expanded', 6, { path: 'src/api' })).toBe('Opened src/api: 6 items');
    expect(tn('top.nodes', 2000)).toBe('2,000 nodes');
    setLang('es');
    expect(getLang()).toBe('es');
    expect(tn('toast.expanded', 6, { path: 'src/api' })).toBe('Abriste src/api: 6 elementos');
    expect(tn('top.nodes', 2000)).toBe('2.000 nodos');
    expect(t('action.edit')).toBe('edición');
  });

  it('words counts of one in the singular (timeline and collapsed folders)', () => {
    setLang('en');
    expect(tn('timeline.rowMarks', 1, { time: '10:02:03' })).toBe('1 mark · at 10:02:03');
    expect(tn('timeline.rowMarks', 3, { time: '10:02:03' })).toBe('3 marks · first at 10:02:03');
    expect(tn('timeline.groupRows', 1)).toBe('1 row in this folder');
    expect(t('timeline.rowsCount', { rows: tn('timeline.rows', 1), marks: tn('timeline.marks', 1) })).toBe('1 row · 1 mark');
    expect(tn('node.expand', 1)).toBe('Click to expand (1 hidden)');
    setLang('es');
    expect(tn('timeline.rowMarks', 1, { time: '10:02:03' })).toBe('1 marca · a las 10:02:03');
    expect(tn('timeline.groupRows', 1)).toBe('1 fila en esta carpeta');
    expect(tn('timeline.groupRows', 2)).toBe('2 filas en esta carpeta');
    expect(t('timeline.rowsCount', { rows: tn('timeline.rows', 1), marks: tn('timeline.marks', 2) })).toBe('1 fila · 2 marcas');
    expect(tn('node.expand', 1)).toBe('Clic para abrir (1 oculto)');
    expect(tn('node.expand', 4)).toBe('Clic para abrir (4 ocultos)');
  });

  it('falls back to the key when it is missing', () => {
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('notifies listeners only on a real change', () => {
    setLang('en');
    const cb = vi.fn();
    const off = onLangChange(cb);
    setLang('en');
    expect(cb).not.toHaveBeenCalled();
    setLang('es');
    expect(cb).toHaveBeenCalledWith('es');
    off();
    setLang('en');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('detectLang', () => {
  it('prefers the stored choice, then a Spanish browser, then English', () => {
    expect(detectLang('es', 'en-US')).toBe('es');
    expect(detectLang('en', 'es-AR')).toBe('en');
    expect(detectLang(null, 'es-AR')).toBe('es');
    expect(detectLang('fr', 'ES')).toBe('es');
    expect(detectLang(null, 'pt-BR')).toBe('en');
    expect(detectLang(undefined, undefined)).toBe('en');
  });
});
