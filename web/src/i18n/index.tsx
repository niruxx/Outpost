import { Children, Fragment, createContext, isValidElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { es } from './locales/es.js';
import { de } from './locales/de.js';
import { fr } from './locales/fr.js';
import { pt } from './locales/pt.js';

/**
 * Translations. Strings are written in English in the code and looked up in a per-language
 * dictionary keyed by that English text — anything not translated yet simply stays English.
 *
 * `t()` works anywhere (components, helpers, constant tables read at render). Shared components
 * (buttons, field labels, card titles, badges, navigation, dialogs) translate their plain-text
 * content themselves, so most screens need no changes. Switching language remounts the app.
 */

export type Locale = 'en' | 'es' | 'de' | 'fr' | 'pt';
export type Dictionary = Record<string, string>;

export const LANGUAGES: { code: Locale; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'pt', name: 'Português (Brasil)' },
];

const DICTIONARIES: Record<Locale, Dictionary> = { en: {}, es, de, fr, pt };
const STORAGE_KEY = 'outpost-language';

function detect(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (saved && saved in DICTIONARIES) return saved;
  } catch {
    // storage blocked
  }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toLowerCase();
  return (nav in DICTIONARIES ? nav : 'en') as Locale;
}

let current: Locale = detect();

export function currentLocale(): Locale {
  return current;
}

/** Translates English UI text; `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const trimmed = text.trim();
  let out = DICTIONARIES[current][trimmed];
  if (out !== undefined && trimmed !== text) {
    // keep the surrounding spaces JSX often leaves around text
    out = text.replace(trimmed, out);
  }
  out ??= text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return out;
}

/** Translates the plain-text parts of React children (elements are left alone). */
export function tc(children: ReactNode): ReactNode {
  if (typeof children === 'string') return t(children);
  if (Array.isArray(children)) {
    return Children.map(children, (c) => (typeof c === 'string' ? t(c) : c)) ?? children;
  }
  if (isValidElement(children) && children.type === Fragment) return children;
  return children;
}

const I18nContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({ locale: current, setLocale: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState<Locale>(current);
  const setLocale = useCallback((l: Locale) => {
    current = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // storage blocked — still switch for this visit
    }
    setState(l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <I18nContext.Provider value={{ locale, setLocale }}>
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

export function useLanguage() {
  return useContext(I18nContext);
}

/** A compact language menu (Configuration → Appearance, sign-in page). */
export function LanguageSelect({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLanguage();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label={t('Language')}
      className={`ui-input rounded-lg border border-surface-500 bg-transparent px-3 py-2 text-sm text-ink-100 outline-none focus:border-accent-400 ${className}`}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
