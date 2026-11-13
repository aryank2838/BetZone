import { useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Info, TriangleAlert } from 'lucide-react';
import { useT } from '@/i18n/useT';

export type AlertTone = 'error' | 'warning' | 'info' | 'success';

const TONES: Record<AlertTone, { box: string; icon: ReactNode }> = {
  error: { box: 'border-rose-900 bg-rose-950/40 text-rose-200', icon: <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" /> },
  warning: { box: 'border-amber-800 bg-amber-950/30 text-amber-100', icon: <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" /> },
  info: { box: 'border-surface-strong bg-surface-raised/60 text-ink-soft', icon: <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent-400" aria-hidden="true" /> },
  success: { box: 'border-brand-900 bg-brand-950/40 text-brand-200', icon: <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden="true" /> },
};

/**
 * One alert style for the whole app. Technical error text (`details`) is kept
 * behind a "Show details" toggle so players see a plain message first, while
 * support can still ask them to open it.
 */
export default function Alert({ tone = 'error', title, children, details, onRetry, action, className = '' }: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  details?: string | null;
  onRetry?: () => void;
  action?: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const [showDetails, setShowDetails] = useState(false);
  const style = TONES[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2.5 rounded-control border px-4 py-3 text-sm ${style.box} ${className}`}>
      {style.icon}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
        {details && (
          <>
            <button
              type="button"
              onClick={() => setShowDetails((value) => !value)}
              aria-expanded={showDetails}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium opacity-80 hover:opacity-100"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
              {showDetails ? t('common.hideDetails') : t('common.showDetails')}
            </button>
            {showDetails && <p className="mt-1 break-words font-mono text-xs opacity-80">{details}</p>}
          </>
        )}
        {(onRetry || action) && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {onRetry && (
              <button type="button" onClick={onRetry} className="min-h-[36px] rounded-lg border border-white/20 px-3 text-xs font-semibold hover:bg-white/5">
                {t('common.retry')}
              </button>
            )}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}
