import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyDocumentLanguage, dictionaries, I18nContext, localeFor, storedLanguage, storeLanguage, type Language } from './context';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setState] = useState<Language>(storedLanguage);
  const setLanguage = useCallback((next: Language) => {
    // The UI switches even if the choice cannot be persisted.
    storeLanguage(next);
    setState(next);
  }, []);
  useEffect(() => { applyDocumentLanguage(language); }, [language]);
  const t = useCallback((key: keyof typeof dictionaries.en) => dictionaries[language][key], [language]);
  const value = useMemo(() => ({
    language,
    setLanguage,
    t,
    locale: localeFor(language),
  }), [language, setLanguage, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
