import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, Radio, RotateCcw, Trophy, XCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { formatCountdown } from '@/lib/countdown';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import {
  questionText, refundReasonKey, resultText, sideName, sportBetOutcome,
  type MySportBet, type MySportBetTotals, type SportBetPhase,
} from '@/lib/sportsPool';
import Alert from '@/components/ui/Alert';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

const PAGE_SIZE = 30;
const DAY = 24 * 60 * 60 * 1000;

const PHASE_LOOK: Record<SportBetPhase, { tone: 'success' | 'danger' | 'neutral' | 'warning' | 'info'; icon: typeof Clock }> = {
  upcoming: { tone: 'info', icon: Clock },
  started: { tone: 'warning', icon: Radio },
  won: { tone: 'success', icon: CheckCircle2 },
  lost: { tone: 'danger', icon: XCircle },
  refunded: { tone: 'neutral', icon: RotateCcw },
};

/** One sports bet: the match, the player's pick and stake, and how it ended. */
export function SportBetRow({ bet, nowMs, compact = false }: { bet: MySportBet; nowMs: number; compact?: boolean }) {
  const { t } = useT();
  const { formatNumber, formatDate } = useFormat();
  const rupees = (value: number) => `₹${formatNumber(value)}`;
  const { phase, profit } = sportBetOutcome(bet, nowMs);
  const look = PHASE_LOOK[phase];
  const Icon = look.icon;
  const { event } = bet;
  const startsMs = Date.parse(event.starts_at);
  const hasScore = event.home_score !== null && event.away_score !== null && phase !== 'upcoming';

  const badge = (() => {
    switch (phase) {
      case 'won': return interpolate(t('sports.betStatus.won'), { amount: formatNumber(bet.payout) });
      case 'lost': return t('sports.betStatus.lost');
      case 'refunded': return interpolate(t('sports.betStatus.refunded'), { amount: formatNumber(bet.payout) });
      case 'started': return t('sportBets.started');
      default:
        return startsMs - nowMs > DAY
          ? formatDate(event.starts_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
          : interpolate(t('sportBets.startsIn'), { time: formatCountdown(event.starts_at, nowMs) });
    }
  })();

  // Same colours as the match card: teams are sky (home) and violet (away) on a Draw match.
  const pickedHome = (bet.side === 'yes') === (event.subject_side !== 'away');
  const sideClass = bet.side === 'draw'
    ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
    : event.has_draw
      ? pickedHome ? 'border-sky-500/60 bg-sky-500/10 text-sky-100' : 'border-violet-500/60 bg-violet-500/10 text-violet-100'
      : bet.side === 'yes'
        ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
        : 'border-rose-500/60 bg-rose-500/10 text-rose-200';

  return (
    <article className={`rounded-card border border-surface-border bg-surface/80 ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-ink-muted">
            {event.competition_name} · {formatDate(event.starts_at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
          </p>
          <p className="mt-0.5 font-semibold text-ink-strong">{questionText(event, t)}</p>
          <p className="truncate text-sm text-ink-soft">
            {event.home_team} <span className="text-ink-muted">vs</span> {event.away_team}
            {hasScore && <span className="ml-1.5 font-semibold tabular-nums text-ink-strong">· {event.home_score}–{event.away_score}</span>}
          </p>
        </div>
        <Badge tone={look.tone} icon={<Icon className="h-3.5 w-3.5" aria-hidden="true" />}>{badge}</Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className={`max-w-[60%] truncate rounded-full border px-2.5 py-0.5 text-xs font-bold ${event.has_draw ? '' : 'uppercase tracking-wide'} ${sideClass}`}>
          {sideName(event, bet.side, t)}
        </span>
        <span className="text-ink-soft">{interpolate(t('sportBets.stake'), { amount: rupees(bet.amount) })}</span>
        {phase === 'won' && (
          <span className="ml-auto font-semibold text-emerald-300">{interpolate(t('sportBets.profit'), { amount: rupees(profit) })}</span>
        )}
        {phase === 'lost' && (
          <span className="ml-auto font-semibold text-rose-300">−{rupees(bet.amount)}</span>
        )}
      </div>

      {!compact && (phase === 'won' || phase === 'lost') && event.outcome && (
        <p className="mt-2 text-xs text-ink-muted">
          {resultText(event, t)}
        </p>
      )}
      {!compact && phase === 'refunded' && (
        <p className="mt-2 text-xs text-ink-muted">
          {interpolate(t('sports.refunded'), { reason: t(refundReasonKey(event.void_reason)) })}
        </p>
      )}
    </article>
  );
}

function isSportBet(value: unknown): value is MySportBet {
  if (!value || typeof value !== 'object') return false;
  const bet = value as Partial<MySportBet>;
  return typeof bet.id === 'string' && typeof bet.amount === 'number' && !!bet.event && typeof bet.event.starts_at === 'string';
}

/** My Bets → Sports: totals, then waiting and settled bets, 30 at a time. */
export default function MySportBets({ onSports }: { onSports: () => void }) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const rupees = (value: number) => `₹${formatNumber(value)}`;
  const [bets, setBets] = useState<MySportBet[]>([]);
  const [totals, setTotals] = useState<MySportBetTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestId = useRef(0);

  const load = useCallback(async (offset: number) => {
    const current = ++requestId.current;
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      const [page, sums] = await Promise.all([
        supabase.rpc('get_my_sport_bets', { p_limit: PAGE_SIZE, p_offset: offset }),
        offset === 0 ? supabase.rpc('get_my_sport_bet_totals') : Promise.resolve(null),
      ]);
      if (current !== requestId.current) return;
      if (page.error) throw page.error;
      const rows = ((page.data as unknown[] | null) ?? []).filter(isSportBet);
      setBets((existing) => (offset === 0 ? rows : [...existing, ...rows]));
      setHasMore(rows.length === PAGE_SIZE);
      // Totals are a bonus: the list still shows if they fail.
      if (sums && !sums.error && sums.data) setTotals(sums.data as MySportBetTotals);
      setError(null);
    } catch (err) {
      if (current !== requestId.current) return;
      setError({ text: friendlyError(err).message, raw: rawErrorMessage(err) });
    } finally {
      if (current === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => { void load(0); }, [load]);
  useVisibleInterval(() => setNowMs(Date.now()), 1000);

  if (loading && bets.length === 0) return <ListSkeleton rows={3} />;
  if (error && bets.length === 0) {
    return <Alert tone="error" details={error.raw} onRetry={() => { void load(0); }}>{error.text}</Alert>;
  }
  if (bets.length === 0) {
    return (
      <section className="rounded-card border border-surface-border bg-surface/80 px-5 py-12 text-center">
        <Trophy className="mx-auto h-8 w-8 text-ink-muted" aria-hidden="true" />
        <p className="mt-3 font-semibold text-ink-strong">{t('sportBets.emptyTitle')}</p>
        <p className="mt-1 text-sm text-ink-muted">{t('sportBets.emptyBody')}</p>
        <Button className="mt-5" onClick={onSports}>{t('sportBets.browse')}</Button>
      </section>
    );
  }

  const open = bets.filter((bet) => bet.status === 'open')
    // Soonest match first, so what matters next is on top.
    .sort((a, b) => Date.parse(a.event.starts_at) - Date.parse(b.event.starts_at));
  const settled = bets.filter((bet) => bet.status !== 'open');
  const net = totals ? totals.returned - totals.settled_stake : null;

  return (
    <div className="space-y-5">
      {totals && (
        <dl className="grid grid-cols-3 gap-2">
          <div className="rounded-control border border-surface-border bg-surface/80 px-3 py-2.5">
            <dt className="text-xs text-ink-muted">{t('sportBets.tileOpen')}</dt>
            <dd className="text-base font-semibold text-ink-strong">{formatNumber(totals.open_count)}</dd>
            <dd className="text-xs text-ink-muted">{rupees(totals.open_stake)}</dd>
          </div>
          <div className="rounded-control border border-surface-border bg-surface/80 px-3 py-2.5">
            <dt className="text-xs text-ink-muted">{t('sportBets.tileWon')}</dt>
            <dd className="text-base font-semibold text-ink-strong">{formatNumber(totals.won_count)}</dd>
            <dd className="text-xs text-ink-muted">{interpolate(t('sportBets.ofBets'), { count: formatNumber(totals.bet_count) })}</dd>
          </div>
          <div className="rounded-control border border-surface-border bg-surface/80 px-3 py-2.5">
            <dt className="text-xs text-ink-muted">{t('sportBets.tileNet')}</dt>
            <dd className={`text-base font-semibold ${net !== null && net > 0 ? 'text-emerald-300' : net !== null && net < 0 ? 'text-rose-300' : 'text-ink-strong'}`}>
              {net !== null && net > 0 ? '+' : net !== null && net < 0 ? '−' : ''}{rupees(Math.abs(net ?? 0))}
            </dd>
            <dd className="text-xs text-ink-muted">{t('sportBets.netHint')}</dd>
          </div>
        </dl>
      )}

      {error && <Alert tone="error" details={error.raw} onRetry={() => { void load(0); }}>{error.text}</Alert>}

      {open.length > 0 && (
        <section aria-labelledby="sport-bets-open">
          <SectionTitle id="sport-bets-open" icon={<Clock className="h-4 w-4" />}>
            {interpolate(t('sportBets.openTitle'), { count: open.length })}
          </SectionTitle>
          <ul className="space-y-3">
            {open.map((bet) => <li key={bet.id}><SportBetRow bet={bet} nowMs={nowMs} /></li>)}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section aria-labelledby="sport-bets-settled">
          <SectionTitle id="sport-bets-settled" icon={<Trophy className="h-4 w-4" />}>{t('sportBets.settledTitle')}</SectionTitle>
          <ul className="space-y-3">
            {settled.map((bet) => <li key={bet.id}><SportBetRow bet={bet} nowMs={nowMs} /></li>)}
          </ul>
        </section>
      )}

      {hasMore && (
        <Button variant="secondary" fullWidth loading={loadingMore} onClick={() => { void load(bets.length); }}>
          {t('common.loadMore')}
        </Button>
      )}
    </div>
  );
}
