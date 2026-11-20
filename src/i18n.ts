// The language of everything shown to people or sent to agents. Pure logic, shared by the
// Master and the dashboard: each runtime holds its own current language. The Master takes it
// from config.yaml; the dashboard from the browser's choice, falling back to the Master's.
//
// Texts are written where they are used, both languages side by side:
//   t({ zh: `加载中…`, en: 'Loading…' })
// Never call `t` at module top level: such a constant would keep the language of import time.

export const LANGUAGES = ['zh', 'en'] as const;
export type Lang = (typeof LANGUAGES)[number];

/** The language when nothing chooses one. */
export const DEFAULT_LANG: Lang = 'zh';

let current: Lang = DEFAULT_LANG;

/** Switch the language of every text produced from now on. */
export function setLang(lang: Lang): void {
  current = lang;
}

/** The language in use. */
export function lang(): Lang {
  return current;
}

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** The text (or any value) for the language in use. */
export function t<T>(texts: Record<Lang, T>): T {
  return texts[current];
}

/** BCP 47 tag of a language, for `<html lang>` and `Intl` formatting. */
export function localeTag(l: Lang = current): string {
  return l === 'zh' ? 'zh-CN' : 'en';
}

/** The name of a language in that language, for a language switch. */
export const LANG_NAMES: Record<Lang, string> = { zh: '中文', en: 'English' };

/**
 * List separator of the language in use: Chinese enumerations use 、, English ", ".
 * `join(list)` joins with it.
 */
export function listSep(): string {
  return t({ zh: '、', en: ', ' });
}

export function join(items: readonly string[]): string {
  return items.join(listSep());
}

/**
 * The language a system locale such as `zh_CN.UTF-8`, `en-US` or `zh-Hans` asks for;
 * Chinese for any zh locale, English for every other one, null when there is none.
 */
export function langOfLocale(locale: string | undefined | null): Lang | null {
  if (!locale || locale === 'C' || locale === 'POSIX') return null;
  return /^zh\b|^zh[-_]/i.test(locale) ? 'zh' : 'en';
}
