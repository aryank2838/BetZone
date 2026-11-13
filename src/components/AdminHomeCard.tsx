import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Shield } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

interface PendingStats {
  pending_withdrawals_count: number;
  pending_withdrawals_amount: number;
  pending_addfunds_count: number;
  pending_addfunds_amount: number;
}

/** Today's date in India (YYYY-MM-DD), which admin_get_stats expects. */
function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Admin-only shortcut at the top of Home: opens the admin panel and shows how
 * many add-money and withdrawal requests are waiting, refreshed every minute.
 */
export default function AdminHomeCard({ onOpen }: { onOpen: (tab: 'stats' | 'requests') => void }) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const [stats, setStats] = useState<PendingStats | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_get_stats', { p_round_date: istToday() });
    if (error || !data) {
      setFailed(true);
      return;
    }
    setStats(data as PendingStats);
    setFailed(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const waiting = stats ? stats.pending_addfunds_count + stats.pending_withdrawals_count : 0;

  return (
    <section aria-labelledby="admin-card-title" className="rounded-card border border-amber-700/60 bg-gradient-to-br from-amber-950/50 to-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-control bg-amber-500/15" aria-hidden="true">
            <Shield className="h-5 w-5 text-amber-400" />
          </span>
          <div>
            <h2 id="admin-card-title" className="font-bold text-ink-strong">{t('dashboard.adminPanel')}</h2>
            <p className="text-sm text-ink-muted">{t('admin.cardSubtitle')}</p>
          </div>
        </div>
        {stats && (
          <Badge tone={waiting > 0 ? 'warning' : 'success'}>
            {waiting > 0 ? interpolate(t('admin.waiting'), { count: waiting }) : t('admin.allClear')}
          </Badge>
        )}
      </div>

      {stats && waiting > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
            <dt className="text-xs text-ink-muted">{t('admin.addMoney')}</dt>
            <dd className="text-sm font-semibold text-ink-strong">
              {stats.pending_addfunds_count} · ₹{formatNumber(stats.pending_addfunds_amount)}
            </dd>
          </div>
          <div className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
            <dt className="text-xs text-ink-muted">{t('admin.withdrawals')}</dt>
            <dd className="text-sm font-semibold text-ink-strong">
              {stats.pending_withdrawals_count} · ₹{formatNumber(stats.pending_withdrawals_amount)}
            </dd>
          </div>
        </dl>
      )}
      {failed && <p className="mt-3 text-sm text-amber-200/80">{t('admin.countsFailed')}</p>}

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button size="lg" variant="admin" onClick={() => onOpen('stats')}>
          {t('admin.open')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        {waiting > 0 && (
          <Button size="lg" variant="secondary" onClick={() => onOpen('requests')}>
            {t('admin.review')}
          </Button>
        )}
      </div>
    </section>
  );
}
