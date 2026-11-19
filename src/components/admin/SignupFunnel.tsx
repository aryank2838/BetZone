import { useEffect, useState } from 'react';
import { Filter } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { useFormat } from '@/i18n/useFormat';
import { FUNNEL_STEPS, biggestDrop, shareOf, type FunnelData } from './funnelSteps';

const PERIODS: Array<{ days: number | null; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: null, label: 'All time' },
];

/** Admin: how far new players get, from sign-up to their first withdrawal. */
export default function SignupFunnel() {
  const { formatNumber } = useFormat();
  const [days, setDays] = useState<number | null>(30);
  const [data, setData] = useState<FunnelData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const { data: result, error: rpcError } = await supabase.rpc('admin_signup_funnel', { p_days: days });
        if (rpcError) throw rpcError;
        if (active) { setData(result as FunnelData); setError(''); }
      } catch (caught) {
        if (!active) return;
        const friendly = friendlyErrorDetails(caught);
        setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [days]);

  const drop = data ? biggestDrop(data) : null;

  return (
    <section aria-labelledby="signup-funnel" className="space-y-3 rounded-card border border-surface-border bg-surface/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="signup-funnel" className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
          <Filter className="h-3.5 w-3.5" aria-hidden="true" /> New players: how far they get
        </h4>
        <div className="flex gap-1" role="group" aria-label="Sign-up period">
          {PERIODS.map((period) => (
            <button
              key={period.label}
              type="button"
              aria-pressed={days === period.days}
              onClick={() => setDays(period.days)}
              className={`min-h-[36px] rounded-full border px-2.5 text-xs font-semibold ${
                days === period.days ? 'border-emerald-400 bg-emerald-950 text-emerald-200' : 'border-surface-strong text-ink-muted'
              }`}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-rose-300">{error}</p>
      ) : loading && !data ? (
        <div className="h-40 animate-pulse rounded-control bg-surface-raised" />
      ) : data && data.signed_up === 0 ? (
        <p className="text-sm text-ink-muted">No sign-ups in this period.</p>
      ) : data && (
        <ol className={`space-y-2.5 ${loading ? 'opacity-60' : ''}`}>
          {FUNNEL_STEPS.map((step, index) => {
            const count = data[step.key];
            const pct = shareOf(count, data.signed_up);
            const previous = index > 0 ? data[FUNNEL_STEPS[index - 1].key] : null;
            const isDrop = step.key === drop;
            return (
              <li key={step.key}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className={isDrop ? 'font-semibold text-amber-200' : 'text-ink-soft'}>{step.label}</span>
                  <span className="tabular-nums text-ink-strong">
                    {formatNumber(count)} <span className="text-xs text-ink-muted">({pct}%)</span>
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-raised" aria-hidden="true">
                  <div className={`h-full rounded-full ${isDrop ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                </div>
                {isDrop && previous !== null && (
                  <p className="mt-1 text-xs text-amber-300">
                    Biggest drop: {formatNumber(previous - count)} players stop here.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-xs text-ink-muted">
        Players who signed up in this period (admins left out). Each step counts players who did it at any time.
      </p>
    </section>
  );
}
