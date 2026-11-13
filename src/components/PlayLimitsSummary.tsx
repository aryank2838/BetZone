import { ChevronRight, ShieldCheck } from 'lucide-react';
import type { MyLimits } from '@/lib/useMyLimits';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const { formatNumber } = useFormat();
  const { t } = useT();
  const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const color = ratio >= 1 ? 'bg-rose-500' : ratio >= 0.8 ? 'bg-amber-400' : 'bg-brand-500';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-ink-soft">{label}</span>
        <span className="tabular-nums text-ink-muted">
          {interpolate(t('limits.usage'), { used: formatNumber(Math.max(0, used)), limit: formatNumber(limit) })}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-raised"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.max(0, Math.min(used, limit))}
      >
        <div className={`h-full rounded-full ${color}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Today's usage against the player's own daily limits. With no limits set it
 * shows a gentle prompt to set some instead.
 */
export default function PlayLimitsSummary({ limits, onOpen }: { limits: MyLimits | null; onOpen: () => void }) {
  const { t } = useT();
  if (!limits) return null;
  const lossLimit = limits.daily_loss_limit;
  const depositLimit = limits.daily_deposit_limit;
  const hasUsage = typeof limits.today_net_loss === 'number' || typeof limits.today_deposits === 'number';

  if (lossLimit === null && depositLimit === null) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-card border border-surface-border bg-surface/60 px-4 py-3 text-left hover:border-surface-strong"
      >
        <ShieldCheck className="h-5 w-5 shrink-0 text-brand-400" aria-hidden="true" />
        <span className="flex-1 text-sm text-ink-soft">{t('limits.prompt')}</span>
        <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full space-y-3 rounded-card border border-surface-border bg-surface/60 px-4 py-4 text-left hover:border-surface-strong"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          <ShieldCheck className="h-4 w-4 text-brand-400" aria-hidden="true" /> {t('limits.today')}
        </span>
        <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
      </span>
      {hasUsage ? (
        <>
          {lossLimit !== null && <UsageBar label={t('limits.lossLabel')} used={limits.today_net_loss ?? 0} limit={lossLimit} />}
          {depositLimit !== null && <UsageBar label={t('limits.depositLabel')} used={limits.today_deposits ?? 0} limit={depositLimit} />}
        </>
      ) : (
        <span className="block text-sm text-ink-soft">
          {[lossLimit !== null ? interpolate(t('limits.lossSet'), { limit: lossLimit }) : null,
            depositLimit !== null ? interpolate(t('limits.depositSet'), { limit: depositLimit }) : null]
            .filter(Boolean).join(' · ')}
        </span>
      )}
    </button>
  );
}
