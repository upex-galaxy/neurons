// UI strings in English and Spanish. Dictionaries are flat JSON files (web/src/i18n/*.json)
// with dotted keys and simple {param} interpolation; plurals are separate `.one` / `.other`
// keys. No DOM access at import time, so pure modules can use it in unit tests.
import en from './i18n/en.json';
import es from './i18n/es.json';

export type Lang = 'en' | 'es';
export type Params = Record<string, string | number>;

export const LANGS: readonly Lang[] = ['en', 'es'];
export const LANG_KEY = 'neurons.lang';

const DICTS: Record<Lang, Record<string, string>> = { en, es };

let current: Lang | null = null;
const listeners = new Set<(lang: Lang) => void>();

function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'es';
}

/** localStorage 'neurons.lang' > navigator.language starting with "es" > English. */
export function detectLang(stored: string | null | undefined, navLang: string | undefined): Lang {
  if (isLang(stored)) return stored;
  return navLang?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The page's storage; undefined outside a browser (Node 26 warns when its global is read). */
function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readStored(): string | null {
  try {
    return storage()?.getItem(LANG_KEY) ?? null;
  } catch {
    return null;
  }
}

export function getLang(): Lang {
  current ??= detectLang(readStored(), globalThis.navigator?.language);
  return current;
}

/** Switches the language, persists it and notifies listeners (only when it changed). */
export function setLang(lang: Lang): void {
  if (!isLang(lang)) return;
  const changed = lang !== getLang();
  current = lang;
  try {
    storage()?.setItem(LANG_KEY, lang);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  if (!changed) return;
  for (const cb of [...listeners]) cb(lang);
}

/** Subscribes to language changes; returns the unsubscribe function. */
export function onLangChange(cb: (lang: Lang) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return typeof v === 'number' ? formatNumber(v) : v;
  });
}

/** Translates `key`; falls back to English, then to the key itself. */
export function t(key: string, params?: Params): string {
  const text = DICTS[getLang()][key] ?? DICTS.en[key] ?? key;
  return interpolate(text, params);
}

/** Plural form: `key.one` when count is 1, `key.other` otherwise; {count} is filled in. */
export function tn(key: string, count: number, params?: Params): string {
  return t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });
}

/** True when the key exists in the current dictionary or in English. */
export function has(key: string): boolean {
  return key in DICTS[getLang()] || key in DICTS.en;
}

export function formatNumber(n: number): string {
  return n.toLocaleString(getLang() === 'es' ? 'es-AR' : 'en-US');
}

/** "3 s ago" / "hace 3 s", via Intl so no strings are hardcoded. */
export function formatRelative(ms: number): string {
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto', style: 'short' });
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 60) return rtf.format(-s, 'second');
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(-h, 'hour');
  return rtf.format(-Math.round(h / 24), 'day');
}

/** Raw dictionaries, for the key parity test. */
export function dictionaries(): Readonly<Record<Lang, Readonly<Record<string, string>>>> {
  return DICTS;
}

/**
 * Fills elements marked with data-i18n (text), data-i18n-title and data-i18n-aria
 * (aria-label) under `root`. Called again on every change.
 */
export function applyDom(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const text = t(el.dataset.i18n!);
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria!));
}
