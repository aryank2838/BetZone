import { localeFor, storedLanguage } from './context';

// Plain helpers read the stored language at call time. Components should use
// useFormat() instead so they re-render when the language changes.
export function formatNumber(value: number, options?: Intl.NumberFormatOptions, localeOverride?: string) {
  return new Intl.NumberFormat(localeOverride ?? localeFor(storedLanguage()), options).format(value);
}

export function formatDate(value: string | number | Date, options?: Intl.DateTimeFormatOptions, localeOverride?: string) {
  return new Intl.DateTimeFormat(localeOverride ?? localeFor(storedLanguage()), { timeZone: 'Asia/Kolkata', ...options }).format(new Date(value));
}
