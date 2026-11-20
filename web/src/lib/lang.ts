import { DEFAULT_LANG, isLang, type Lang, localeTag, setLang } from '../../../src/i18n.js';

const LANG_KEY = 'ares1.language';

/** The language chosen in this browser; null = follow the Master's. */
export function storedLang(): Lang | null {
  try {
    const v = window.localStorage.getItem(LANG_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

export function storeLang(l: Lang): void {
  try {
    window.localStorage.setItem(LANG_KEY, l);
  } catch {
    // private mode etc.: the choice just is not remembered
  }
}

/** The dashboard's language: this browser's choice, else the Master's, else the default. */
export function dashboardLang(stored: Lang | null, master: Lang | undefined): Lang {
  return stored ?? master ?? DEFAULT_LANG;
}

/** Use a language for every text rendered from now on, and tell the browser. */
export function applyLang(l: Lang): void {
  setLang(l);
  document.documentElement.lang = localeTag(l);
}
