import { useT } from '@/i18n/useT';
import type { Language } from '@/i18n/context';

export default function LanguageSelector({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, t } = useT();
  return (
    <label className={compact ? 'inline-flex items-center gap-2 text-xs text-slate-400' : 'block text-xs text-slate-400'}>
      {!compact && <span className="mb-1.5 block">{t('language.label')}</span>}
      <select
        aria-label={t('language.label')}
        value={language}
        onChange={(event) => setLanguage(event.target.value as Language)}
        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
      >
        <option value="en">{t('language.en')}</option>
        <option value="hi">{t('language.hi')}</option>
        <option value="mr">{t('language.mr')}</option>
      </select>
    </label>
  );
}
