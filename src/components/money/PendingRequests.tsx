import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Clock } from 'lucide-react';
import type { UserRequest } from '@/lib/useUserRequests';
import { timeAgo } from '@/lib/moneyAmounts';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

/**
 * Top of the Money page, on every tab: requests still being checked, so a
 * player always sees their money is on its way. Tapping opens History.
 */
export default function PendingRequests({ requests, note, onOpen }: {
  requests: UserRequest[];
  /** The admin's "usually approved within …" note, if set. */
  note: string;
  onOpen: () => void;
}) {
  const { t, locale } = useT();
  const { formatNumber } = useFormat();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pending = requests.filter((request) => request.status === 'pending');
  useVisibleInterval(() => setNowMs(Date.now()), 30_000, pending.length > 0);
  if (pending.length === 0) return null;

  return (
    <section aria-label={t('money.pending.title')} className="space-y-2">
      {pending.map((request) => {
        const deposit = request.kind === 'deposit';
        const Icon = deposit ? ArrowDownLeft : ArrowUpRight;
        return (
          <button
            key={`${request.kind}:${request.id}`}
            type="button"
            onClick={onOpen}
            className="flex w-full items-center gap-3 rounded-card border border-amber-800/70 bg-amber-950/30 px-4 py-3 text-left transition-colors hover:bg-amber-950/50"
          >
            <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-500/15" aria-hidden="true">
              <Icon className="h-5 w-5 text-amber-300" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-ink-strong">
                {interpolate(t(deposit ? 'money.pending.deposit' : 'money.pending.withdrawal'), { amount: `₹${formatNumber(request.amount)}` })}
              </span>
              <span className="flex items-center gap-1 text-xs text-amber-200/90">
                <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {interpolate(t('money.pending.status'), { ago: timeAgo(request.created_at, nowMs, locale) })}
              </span>
              {note && <span className="mt-0.5 block truncate text-xs text-ink-muted">{note}</span>}
            </span>
            <span className="flex shrink-0 items-center text-xs font-semibold text-amber-200">
              {t('money.pending.track')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </button>
        );
      })}
    </section>
  );
}
