// User-facing text of the CLI and the server, in English and Spanish. The strings live in
// src/i18n/{en,es}.json (flat dotted keys, `{param}` interpolation, plurals as `.one` and
// `.other` keys); code only refers to keys.
//
// Language: --lang en|es > NEURONS_LANG > LC_ALL / LC_MESSAGES / LANG (the first one set)
// starting with "es" > the system locale (Intl; what Windows terminals and shells launched
// without LANG report) starting with "es" > English.

import en from './i18n/en.json' with { type: 'json' };
import es from './i18n/es.json' with { type: 'json' };

export const LANGS = ['en', 'es'] as const;
export type Lang = (typeof LANGS)[number];
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Record<string, string>> = { en, es };

let current: Lang | undefined;
const listeners = new Set<(lang: Lang) => void>();

/** `en` or `es` from a value like "es", "es_AR.UTF-8" or "EN"; undefined for anything else. */
export function parseLang(value: string | undefined): Lang | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v.startsWith('es')) return 'es';
  if (v.startsWith('en')) return 'en';
  return undefined;
}

/** `--lang` takes exactly `en` or `es` (any case). */
export function langOption(value: string | undefined): Lang | undefined {
  const v = (value ?? '').trim().toLowerCase();
  return (LANGS as readonly string[]).includes(v) ? (v as Lang) : undefined;
}

/** The value of `--lang X` or `--lang=X` in argv (before a `--`), as typed. */
export function langArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') break;
    if (a === '--lang') return argv[i + 1];
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

/** The operating system's locale as the JS runtime sees it ("es-AR", "en-US"), or "" if unknown. */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  } catch {
    return '';
  }
}

/** The language for these arguments, this environment and this system locale (see the module comment). */
export function detectLang(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  osLocale: string = systemLocale(),
): Lang {
  const fromArg = langOption(langArg(argv));
  if (fromArg) return fromArg;
  const fromEnv = parseLang(env.NEURONS_LANG);
  if (fromEnv) return fromEnv;
  // A locale variable that is set decides, even "C" (English): it is how a terminal says its language.
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v !== undefined && v.trim() !== '') ?? osLocale;
  return locale.trim().toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function getLang(): Lang {
  current ??= detectLang();
  return current;
}

export function setLang(lang: Lang): void {
  if (current === lang) return;
  current = lang;
  for (const cb of listeners) cb(lang);
}

/** Calls `cb` after every language change. Returns the unsubscribe function. */
export function onLangChange(cb: (lang: Lang) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** The text of `key` in the current language (English, then the key itself, as fallbacks). */
export function t(key: string, params?: Params): string {
  const text = DICTS[getLang()][key] ?? DICTS.en[key] ?? key;
  return interpolate(text, params);
}

/** `key.one` when `count` is 1, else `key.other`; `{count}` is filled in too. */
export function tn(key: string, count: number, params?: Params): string {
  return t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });
}

/** Both dictionaries, for tests. */
export function dictionaries(): Readonly<Record<Lang, Readonly<Record<string, string>>>> {
  return DICTS;
}
