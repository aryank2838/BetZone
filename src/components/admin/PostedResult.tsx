import { CheckCircle2, Clock, Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { formatClockTime } from '@/lib/countdown';
import { useFormat } from '@/i18n/useFormat';

const PHASE_LABEL = { open: 'Open', close: 'Close' } as const;

/** Shown in place of the "Post result" form once that result is in. */
export function PostedResultCard({ phase, gameLabel, dateLabel, patti, digit, paid, postedAt, payout }: {
  phase: 'open' | 'close';
  gameLabel: string;
  dateLabel: string;
  patti: string | null;
  digit: string;
  /** null when not known (e.g. an older round). */
  paid: boolean | null;
  postedAt: string | null;
  /** Payout summary when it was posted just now. */
  payout: { winners: number; total_paid: number } | null;
}) {
  const { formatNumber, formatDate } = useFormat();
  return (
    <Card className="border-brand-800 bg-brand-950/30" aria-label={`${PHASE_LABEL[phase]} result posted`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-bold text-brand-200">
            <CheckCircle2 className="h-5 w-5 text-brand-400" aria-hidden="true" />
            {PHASE_LABEL[phase]} result posted
          </h3>
          <p className="mt-0.5 text-sm text-ink-muted">{gameLabel} · {dateLabel}</p>
        </div>
        {paid !== null && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${paid ? 'bg-brand-950 text-brand-300' : 'bg-amber-950 text-amber-300'}`}>
            {paid ? 'Paid out' : 'Paying out…'}
          </span>
        )}
      </div>

      <div className="mt-4 flex items-baseline justify-center gap-3" aria-label={`${patti ?? ''} ${digit}`}>
        {patti && <span className="text-2xl font-bold tabular-nums tracking-wider text-ink-soft">{patti}</span>}
        {patti && <span className="text-xl text-ink-muted" aria-hidden="true">–</span>}
        <span className={`text-4xl font-extrabold tabular-nums ${phase === 'open' ? 'text-brand-400' : 'text-accent-400'}`}>{digit}</span>
      </div>

      <p className="mt-4 text-center text-sm text-ink-muted">
        {payout
          ? `${formatNumber(payout.winners)} winner${payout.winners === 1 ? '' : 's'} · ₹${formatNumber(payout.total_paid)} paid`
          : postedAt
            ? `Posted ${formatDate(postedAt, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
            : 'Already posted for this round.'}
      </p>
    </Card>
  );
}

/** Close result before the open one is in: nothing to fill in yet. */
export function LockedResultCard({ gameLabel, dateLabel, dueAt }: { gameLabel: string; dateLabel: string; dueAt?: string | null }) {
  return (
    <Card className="border-dashed">
      <h3 className="flex items-center gap-2 font-bold text-ink-soft">
        <Lock className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        Close result
      </h3>
      <p className="mt-0.5 text-sm text-ink-muted">{gameLabel} · {dateLabel}</p>
      <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
        Post the open result first. The close form appears here after that{dueAt ? ` (due ${formatClockTime(dueAt)} IST)` : ''}.
      </p>
    </Card>
  );
}
