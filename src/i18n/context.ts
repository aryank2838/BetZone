import { createContext } from 'react';
import en from './en';
import hi from './hi';
import mr from './mr';

export type Language = 'en' | 'hi' | 'mr';
export type TranslationKey = keyof typeof en;
export interface I18nValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
  locale: string;
}

export const STORAGE_KEY = 'betzone_language';
export const dictionaries = { en, hi, mr };

export const localeFor = (language: Language) =>
  language === 'hi' ? 'hi-IN' : language === 'mr' ? 'mr-IN' : 'en-IN';

// localStorage can be missing or throw (private mode, blocked storage, quota).
export function storedLanguage(): Language {
  let value: string | null = null;
  try {
    value = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
  } catch {
    value = null;
  }
  return value === 'hi' || value === 'mr' ? value : 'en';
}

/** Persists the language; returns false if storage is unavailable. */
export function storeLanguage(language: Language): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(STORAGE_KEY, language);
    return true;
  } catch {
    return false;
  }
}

/** Sets <html lang> so screen readers and fonts use the active language. */
export function applyDocumentLanguage(language: Language) {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function translate(key: TranslationKey, language = storedLanguage()): string {
  return dictionaries[language][key];
}

/** Replaces {name} placeholders; unknown placeholders are left as-is. */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    (name in values ? String(values[name]) : placeholder));
}

export const defaultValue: I18nValue = {
  language: 'en',
  setLanguage: (language) => { storeLanguage(language); },
  t: (key) => en[key],
  locale: 'en-IN',
};

export const I18nContext = createContext<I18nValue>(defaultValue);
