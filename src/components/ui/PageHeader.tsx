import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useT } from '@/i18n/useT';

/** Sticky page header used by every screen. `onBack` adds a back arrow. */
export default function PageHeader({ title, subtitle, onBack, actions, leading }: {
  title: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  const { t } = useT();
  return (
    <header className="sticky top-0 z-20 border-b border-surface-border/80 bg-surface-page/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 sm:px-5">
        {onBack && (
          <button type="button" onClick={onBack} aria-label={t('common.back')} className="tap-target -ml-2 rounded-lg text-ink-muted hover:text-ink-strong">
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        {leading}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-bold leading-tight text-ink-strong">{title}</h1>
          {subtitle && <p className="truncate text-xs leading-tight text-ink-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
