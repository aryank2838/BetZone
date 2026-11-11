import { useMemo } from 'react';
import { useT } from './useT';
import { formatDate as formatDateWithLocale, formatNumber as formatNumberWithLocale } from './format';

/**
 * Locale-aware formatters bound to the active language. Components that use
 * this hook re-render when the language changes, unlike the plain helpers in
 * ./format, which read the stored language at call time.
 */
export function useFormat() {
  const { locale } = useT();
  return useMemo(() => ({
    locale,
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      formatNumberWithLocale(value, options, locale),
    formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) =>
      formatDateWithLocale(value, options, locale),
  }), [locale]);
}
