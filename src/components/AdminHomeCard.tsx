import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlarmClock, Bell, BellOff, ChevronRight, Shield, TrendingUp, Volume2, VolumeX } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import { BET_TYPES, type Game, type GameStatus } from '@/types';
import { formatClockTime } from '@/lib/countdown';
import { istToday, useAdminAlerts } from '@/lib/adminAlertsContext';
import {
  biggestRisk, currentResultRound, overdueResults, unsettledExposure,
  type ExposureItem, type ResultHistoryRow, type RiskItem,
} from '@/lib/adminOverview';

export type AdminOpenTarget = 'stats' | 'requests' | 'results';

interface DailyTotals {
  total_staked: number;
  total_paid_out: number;
  gaming_revenue: number;
}

/** Loads result history, today's totals and exposure for the admin card. */
function useAdminOverview(statuses: GameStatus[]) {
  const [history, setHistory] = useState<Partial<Record<Game, ResultHistoryRow[]>>>({});
  const [today, setToday] = useState<DailyTotals | null>(null);
  const [risk, setRisk] = useState<RiskItem | null>(null);
  const [failed, setFailed] = useState(false);
  // Reload when the set of games, the day or a holiday changes, not on every status poll.
  const scheduleKey = statuses.map((status) => `${status.game}:${status.server_ist_date}:${status.on_holiday ? 1 : 0}`).join('|');

  const load = useCallback(async (current: GameStatus[]) => {
    if (current.length === 0) return;
    let anyFailed = false;
    const [report, ...histories] = await Promise.all([
      supabase.rpc('admin_daily_report', { p_date: istToday() }),
      ...current.map((status) => supabase.rpc('get_result_history', { p_game: status.game, p_limit: 3, p_offset: 0 })),
    ]);
    if (report.error) anyFailed = true;
    else {
      const rows = (report.data ?? []) as Array<DailyTotals & { game: string }>;
      setToday(rows.find((row) => row.game === 'ALL') ?? { total_staked: 0, total_paid_out: 0, gaming_revenue: 0 });
    }
    const nextHistory: Partial<Record<Game, ResultHistoryRow[]>> = {};
    current.forEach((status, index) => {
      const result = histories[index];
      if (result.error) anyFailed = true;
      else nextHistory[status.game] = (result.data ?? []) as ResultHistoryRow[];
    });
    setHistory(nextHistory);

    const open = current.filter((status) => !status.on_holiday);
    const exposures = await Promise.all(open.map((status) =>
      supabase.rpc('admin_get_exposure', { p_game: status.game, p_round_date: currentResultRound(status) })));
    const perGame = open.flatMap((status, index) => {
      const result = exposures[index];
      if (result.error || !result.data) {
        anyFailed = true;
        return [];
      }
      const roundDate = currentResultRound(status);
      const items = (result.data as { exposure?: ExposureItem[] }).exposure ?? [];
      const posted = nextHistory[status.game]?.find((row) => row.round_date === roundDate);
      return [{ game: status.game, label: status.label || status.game, roundDate, items: unsettledExposure(items, posted) }];
    });
    setRisk(biggestRisk(perGame));
    setFailed(anyFailed);
  }, []);

  const statusesRef = useMemo(() => statuses, [scheduleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load(statusesRef);
    const timer = window.setInterval(() => { void load(statusesRef); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load, statusesRef]);

  return { history, today, risk, failed };
}

/**
 * Admin-only summary at the top of Home: waiting requests (live), results that
 * are overdue, today's profit and loss, and the biggest payout risk.
 */
export default function AdminHomeCard({ statuses, onOpen }: {
  statuses: GameStatus[];
  onOpen: (target: AdminOpenTarget, game?: Game) => void;
}) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const alerts = useAdminAlerts();
  const { history, today, risk, failed: overviewFailed } = useAdminOverview(statuses);
  const overdue = overdueResults(statuses, history);
  const stats = alerts?.stats ?? null;
  const waiting = alerts?.waiting ?? 0;
  const money = (value: number) => `₹${formatNumber(value)}`;
  const late = (minutes: number) => (minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`);

  return (
    <section aria-labelledby="admin-card-title" className="space-y-4 rounded-card border border-amber-700/60 bg-gradient-to-br from-amber-950/50 to-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-control bg-amber-500/15" aria-hidden="true">
            <Shield className="h-5 w-5 text-amber-400" />
          </span>
          <div>
            <h2 id="admin-card-title" className="font-bold text-ink-strong">{t('dashboard.adminPanel')}</h2>
            <p className="flex items-center gap-1.5 text-sm text-ink-muted">
              <span className={`inline-block h-2 w-2 rounded-full ${alerts?.live ? 'bg-brand-400' : 'bg-slate-500'}`} aria-hidden="true" />
              {alerts?.live ? t('admin.live') : t('admin.polling')}
            </p>
          </div>
        </div>
        {stats && (
          <Badge tone={waiting > 0 ? 'warning' : 'success'}>
            {waiting > 0 ? interpolate(t('admin.waiting'), { count: waiting }) : t('admin.allClear')}
          </Badge>
        )}
      </div>

      {stats && waiting > 0 && (
        <button type="button" onClick={() => onOpen('requests')} className="grid w-full grid-cols-2 gap-3 text-left">
          <span className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
            <span className="block text-xs text-ink-muted">{t('admin.addMoney')}</span>
            <span className="block text-base font-semibold text-ink-strong">
              {stats.pending_addfunds_count} · {money(stats.pending_addfunds_amount)}
            </span>
          </span>
          <span className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
            <span className="block text-xs text-ink-muted">{t('admin.withdrawals')}</span>
            <span className="block text-base font-semibold text-ink-strong">
              {stats.pending_withdrawals_count} · {money(stats.pending_withdrawals_amount)}
            </span>
          </span>
        </button>
      )}
      {alerts?.failed && <p className="text-sm text-amber-200/80">{t('admin.countsFailed')}</p>}

      {overdue.length > 0 && (
        <div className="space-y-2" role="status">
          {overdue.map((item) => (
            <div key={`${item.game}-${item.phase}-${item.roundDate}`} className="flex flex-col gap-2 rounded-control border border-rose-800 bg-rose-950/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2 text-sm text-rose-100">
                <AlarmClock className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
                {interpolate(t('admin.overdue'), {
                  game: item.label,
                  phase: t(item.phase === 'open' ? 'admin.phaseOpen' : 'admin.phaseClose'),
                  time: formatClockTime(item.dueAt),
                  late: late(item.minutesLate),
                })}
              </p>
              <Button variant="danger" className="shrink-0" onClick={() => onOpen('results', item.game)}>
                {t('admin.postResult')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {today && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('admin.todayTitle')}</p>
          <dl className="grid grid-cols-3 gap-2">
            <div className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
              <dt className="text-xs text-ink-muted">{t('admin.staked')}</dt>
              <dd className="text-sm font-semibold text-ink-strong">{money(today.total_staked)}</dd>
            </div>
            <div className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
              <dt className="text-xs text-ink-muted">{t('admin.paidOut')}</dt>
              <dd className="text-sm font-semibold text-ink-strong">{money(today.total_paid_out)}</dd>
            </div>
            <div className="rounded-control border border-surface-border bg-surface-page/50 px-3 py-2">
              <dt className="text-xs text-ink-muted">{t('admin.net')}</dt>
              <dd className={`text-sm font-semibold ${today.gaming_revenue >= 0 ? 'text-brand-400' : 'text-rose-400'}`}>
                {today.gaming_revenue < 0 ? '−' : ''}{money(Math.abs(today.gaming_revenue))}
              </dd>
            </div>
          </dl>
        </div>
      )}

      <div className="flex items-start gap-2.5 rounded-control border border-surface-border bg-surface-page/50 px-3 py-2.5">
        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
        <div className="min-w-0 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('admin.riskTitle')}</p>
          {risk ? (
            <button type="button" onClick={() => onOpen('results', risk.game)} className="text-left">
              <span className="block font-semibold text-ink-strong">
                {interpolate(t('admin.risk'), { bet: BET_TYPES[risk.bet_type]?.label ?? risk.bet_type, number: risk.number, amount: money(risk.potential_payout) })}
              </span>
              <span className="block text-xs text-ink-muted">
                {interpolate(t('admin.riskDetail'), { game: risk.label, stake: money(risk.total_stake) })}
              </span>
            </button>
          ) : (
            <p className="text-ink-soft">{t('admin.riskNone')}</p>
          )}
        </div>
      </div>
      {overviewFailed && <p className="text-sm text-amber-200/80">{t('admin.overviewFailed')}</p>}

      {alerts && <AlertControls />}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button size="lg" variant={waiting > 0 ? 'admin' : 'secondary'} onClick={() => onOpen('requests')}>
          {t('admin.review')}{waiting > 0 ? ` (${waiting})` : ''}
        </Button>
        <Button size="lg" variant={waiting > 0 ? 'secondary' : 'admin'} onClick={() => onOpen('stats')}>
          {t('admin.open')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

function AlertControls() {
  const { t } = useT();
  const alerts = useAdminAlerts();
  if (!alerts) return null;
  const { notifications, enableNotifications, soundEnabled, setSoundEnabled } = alerts;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {notifications === 'default' && (
        <Button variant="secondary" icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => { void enableNotifications(); }}>
          {t('admin.notificationsOn')}
        </Button>
      )}
      {notifications === 'granted' && (
        <Badge tone="success" icon={<Bell className="h-3.5 w-3.5" aria-hidden="true" />}>{t('admin.notificationsActive')}</Badge>
      )}
      {notifications === 'denied' && (
        <p className="flex items-center gap-1.5 text-xs text-ink-muted">
          <BellOff className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin.notificationsBlocked')}
        </p>
      )}
      <Button
        variant="ghost"
        aria-pressed={soundEnabled}
        icon={soundEnabled ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <VolumeX className="h-4 w-4" aria-hidden="true" />}
        onClick={() => setSoundEnabled(!soundEnabled)}
      >
        {soundEnabled ? t('admin.soundOn') : t('admin.soundOff')}
      </Button>
    </div>
  );
}
