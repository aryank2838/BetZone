import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Trophy } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { formatCountdown } from '@/lib/countdown';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import {
  estimatePayout, isBettable, subjectTeam, yesShare,
  type MySportBet, type Sport, type SportEvent, type SportEventsResponse, type SportSide,
} from '@/lib/sportsPool';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { Card, SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/ui/toastContext';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-4 py-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';
const REFRESH_MS = 60_000;
const SIX_HOURS = 6 * 60 * 60 * 1000;

const REFUND_REASONS: Record<string, TranslationKey> = {
  one_sided: 'sports.reason.oneSided',
  cancelled_or_postponed: 'sports.reason.cancelled',
  start_moved_earlier: 'sports.reason.startMoved',
  no_result: 'sports.reason.noResult',
};

function refundReasonKey(reason: string | null): TranslationKey {
  if (reason && REFUND_REASONS[reason]) return REFUND_REASONS[reason];
  return 'sports.reason.support';
}

export default function SportsPage({ onAddFunds }: { onAddFunds: () => void }) {
  const { t } = useT();
  const { refreshProfile } = useAuth();
  const [data, setData] = useState<SportEventsResponse | null>(null);
  const [myBets, setMyBets] = useState<MySportBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const [sport, setSport] = useState<Sport>('football');
  const [showRules, setShowRules] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [events, bets] = await Promise.all([
        supabase.rpc('get_sport_events', { p_sport: null }),
        supabase.rpc('get_my_sport_bets', { p_limit: 30, p_offset: 0 }),
      ]);
      if (events.error) throw events.error;
      const next = events.data as SportEventsResponse;
      setData(next);
      if (!bets.error) setMyBets((bets.data as MySportBet[] | null) ?? []);
      setError(null);
      setSport((current) => (
        current === 'football' && !next.football_enabled && next.cricket_enabled ? 'cricket' : current
      ));
    } catch (err) {
      const friendly = friendlyError(err);
      setError({ text: friendly.message, raw: rawErrorMessage(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(() => { void load(); }, REFRESH_MS);
  useVisibleInterval(() => setNowMs(Date.now()), 1000);

  const sports: Sport[] = data
    ? (['football', 'cricket'] as Sport[]).filter((s) => (s === 'football' ? data.football_enabled : data.cricket_enabled))
    : [];
  const events = (data?.events ?? []).filter((event) => event.sport === sport);
  const feePercent = events[0]?.fee_percent ?? 10;

  const afterBet = async () => {
    await Promise.all([load(), refreshProfile()]);
  };

  return (
    <div>
      <PageHeader title={t('sports.title')} subtitle={t('sports.subtitle')} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-5 sm:px-5">
        {error && <Alert tone="error" details={error.raw} onRetry={() => { void load(); }}>{error.text}</Alert>}

        {loading && !data ? <ListSkeleton rows={3} /> : data && sports.length === 0 ? (
          <Alert tone="info">{t('sports.off')}</Alert>
        ) : data && (
          <>
            {sports.length > 1 && (
              <div className="grid grid-cols-2 gap-2" role="tablist" aria-label={t('sports.title')}>
                {sports.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={sport === s}
                    onClick={() => setSport(s)}
                    className={`min-h-[44px] rounded-control border text-sm font-semibold ${
                      sport === s ? 'border-brand-400 bg-brand-950 text-brand-200' : 'border-surface-strong text-ink-muted'
                    }`}
                  >
                    {t(s === 'football' ? 'sports.football' : 'sports.cricket')}
                  </button>
                ))}
              </div>
            )}

            <Card className="p-4">
              <button
                type="button"
                onClick={() => setShowRules((v) => !v)}
                aria-expanded={showRules}
                className="flex w-full items-center justify-between text-sm font-semibold text-ink-soft"
              >
                {t('sports.howItWorks')}
                {showRules ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showRules && (
                <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                  {interpolate(t('sports.rules'), { fee: feePercent })}
                </p>
              )}
            </Card>

            {events.length === 0 ? (
              <Alert tone="info">{t('sports.empty')}</Alert>
            ) : (
              <ul className="space-y-3">
                {events.map((event) => (
                  <li key={event.id}>
                    <EventCard
                      event={event}
                      nowMs={nowMs}
                      minBet={data.min_bet}
                      maxBet={data.max_bet}
                      onPlaced={afterBet}
                      onAddFunds={onAddFunds}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <MyBetsList bets={myBets} />
      </main>
    </div>
  );
}

function EventCard({ event, nowMs, minBet, maxBet, onPlaced, onAddFunds }: {
  event: SportEvent;
  nowMs: number;
  minBet: number;
  maxBet: number;
  onPlaced: () => Promise<void>;
  onAddFunds: () => void;
}) {
  const { t } = useT();
  const { formatNumber, formatDate } = useFormat();
  const [side, setSide] = useState<SportSide | null>(null);
  const team = subjectTeam(event);
  const question = interpolate(t('sports.question'), { team });
  const share = yesShare(event.yes_total, event.no_total);
  const open = isBettable(event, nowMs);
  const startsMs = Date.parse(event.starts_at);
  const perHundred = (s: SportSide) => estimatePayout({
    stake: 100, side: s, yesTotal: event.yes_total, noTotal: event.no_total, feePercent: event.fee_percent,
  });

  let status: string;
  if (event.state === 'void') {
    status = interpolate(t('sports.refunded'), { reason: t(refundReasonKey(event.void_reason)) });
  } else if (event.state === 'settled') {
    status = interpolate(t(event.outcome === 'yes' ? 'sports.resultYes' : 'sports.resultNo'), { team });
  } else if (open) {
    status = startsMs - nowMs < SIX_HOURS
      ? interpolate(t('sports.closesIn'), { time: formatCountdown(event.starts_at, nowMs) })
      : interpolate(t('sports.startsAt'), { time: formatDate(startsMs, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) });
  } else {
    status = t('sports.closed');
  }
  const score = event.home_score != null && event.away_score != null ? `${event.home_score} – ${event.away_score}` : null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{event.competition_name}</p>
          <p className="mt-1 font-semibold text-ink-strong">
            {event.home_team} <span className="text-ink-muted">vs</span> {event.away_team}
          </p>
        </div>
        {score && <Badge tone="neutral">{score}</Badge>}
      </div>

      <p className="text-base font-bold text-ink-strong">{question}</p>
      <p className={`text-xs ${open ? 'text-amber-300' : 'text-ink-muted'}`}>{status}</p>

      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-surface-raised">
        <div className="bg-emerald-500" style={{ width: `${share}%` }} />
        <div className="bg-rose-500" style={{ width: `${100 - share}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {(['yes', 'no'] as SportSide[]).map((s) => {
          const est = perHundred(s);
          const pool = s === 'yes' ? event.yes_total : event.no_total;
          return (
            <div key={s} className={s === 'yes' ? 'text-emerald-300' : 'text-right text-rose-300'}>
              <p className="font-semibold">
                {t(s === 'yes' ? 'sports.yes' : 'sports.no')} {s === 'yes' ? share : 100 - share}%
              </p>
              <p className="text-ink-muted">{interpolate(t('sports.pool'), { amount: formatNumber(pool) })}</p>
              {open && (
                <p className="text-ink-muted">
                  {est.refund ? t('sports.paysRefund') : interpolate(t('sports.pays'), { amount: formatNumber(est.payout) })}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {(event.my_yes > 0 || event.my_no > 0) && (
        <p className="text-xs text-ink-soft">
          {interpolate(t('sports.myBet'), { yes: formatNumber(event.my_yes), no: formatNumber(event.my_no) })}
        </p>
      )}

      {open && !side && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" className="border-emerald-500/60 text-emerald-200" onClick={() => setSide('yes')}>{t('sports.yes')}</Button>
          <Button variant="secondary" className="border-rose-500/60 text-rose-200" onClick={() => setSide('no')}>{t('sports.no')}</Button>
        </div>
      )}
      {open && side && (
        <BetForm
          event={event}
          side={side}
          question={question}
          minBet={minBet}
          maxBet={maxBet}
          onCancel={() => setSide(null)}
          onPlaced={async () => { setSide(null); await onPlaced(); }}
          onAddFunds={onAddFunds}
        />
      )}
    </Card>
  );
}

function BetForm({ event, side, question, minBet, maxBet, onCancel, onPlaced, onAddFunds }: {
  event: SportEvent;
  side: SportSide;
  question: string;
  minBet: number;
  maxBet: number;
  onCancel: () => void;
  onPlaced: () => Promise<void>;
  onAddFunds: () => void;
}) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ text: string; raw?: string; addFunds?: boolean } | null>(null);
  const value = /^[0-9]+$/.test(amount) ? Number(amount) : 0;
  const valid = value >= minBet && value <= maxBet;
  const sideLabel = t(side === 'yes' ? 'sports.yes' : 'sports.no');
  const est = estimatePayout({ stake: value, side, yesTotal: event.yes_total, noTotal: event.no_total, feePercent: event.fee_percent });

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('place_sport_bet', { p_event_id: event.id, p_side: side, p_amount: value });
      if (rpcError) throw rpcError;
      toast.show(interpolate(t('sports.placed'), { amount: formatNumber(value), side: sideLabel }), 'success');
      await onPlaced();
    } catch (err) {
      const friendly = friendlyError(err);
      setError({
        text: friendly.message,
        raw: friendly.key === 'errors.generic' ? rawErrorMessage(err) : undefined,
        addFunds: friendly.action === 'add_funds',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-control border border-surface-strong bg-surface-raised/40 p-3">
      <p className="text-sm font-semibold text-ink-strong">
        {interpolate(t('sports.betTitle'), { side: sideLabel, question })}
      </p>
      <div>
        <label htmlFor={`sport-amount-${event.id}`} className="mb-1.5 block text-xs font-medium text-ink-soft">{t('sports.amount')}</label>
        <input
          id={`sport-amount-${event.id}`}
          type="text" inputMode="numeric" pattern="[0-9]*" autoFocus
          value={amount}
          onChange={(e) => { setAmount(e.target.value); setError(null); }}
          placeholder={String(minBet * 10)}
          className={INPUT}
        />
        <p className="mt-1.5 text-xs text-ink-muted">
          {interpolate(t('sports.amountHint'), { min: formatNumber(minBet), max: formatNumber(maxBet) })}
        </p>
      </div>
      {valid && (
        <div className="text-xs text-ink-soft">
          <p className="font-medium">
            {est.refund
              ? t('sports.estimateRefund')
              : interpolate(t('sports.estimate'), { amount: formatNumber(est.payout), stake: formatNumber(value) })}
          </p>
          <p className="mt-1 text-ink-muted">{t('sports.estimateNote')}</p>
        </div>
      )}
      {error && (
        <Alert tone="error" details={error.raw} action={error.addFunds ? (
          <Button variant="secondary" onClick={onAddFunds}>{t('dashboard.addFunds')}</Button>
        ) : undefined}>{error.text}</Alert>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>{t('sports.cancel')}</Button>
        <Button onClick={() => { void submit(); }} disabled={!valid} loading={submitting}>
          {interpolate(t('sports.place'), { amount: formatNumber(value) })}
        </Button>
      </div>
    </div>
  );
}

function MyBetsList({ bets }: { bets: MySportBet[] }) {
  const { t } = useT();
  const { formatNumber, formatDate } = useFormat();
  if (bets.length === 0) return null;
  const statusText = (bet: MySportBet) => {
    if (bet.status === 'won') return interpolate(t('sports.betStatus.won'), { amount: formatNumber(bet.payout) });
    if (bet.status === 'refunded') return interpolate(t('sports.betStatus.refunded'), { amount: formatNumber(bet.payout) });
    if (bet.status === 'lost') return t('sports.betStatus.lost');
    return t('sports.betStatus.open');
  };
  const tone = (bet: MySportBet) => (bet.status === 'won' ? 'success' : bet.status === 'lost' ? 'danger' : 'neutral');

  return (
    <section aria-labelledby="my-sport-bets">
      <SectionTitle id="my-sport-bets" icon={<Trophy className="h-4 w-4" />}>{t('sports.myBets')}</SectionTitle>
      <ul className="divide-y divide-surface-border rounded-card border border-surface-border bg-surface/80">
        {bets.map((bet) => (
          <li key={bet.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink-strong">
                {interpolate(t('sports.question'), { team: subjectTeam(bet.event) })}
              </p>
              <p className="truncate text-xs text-ink-muted">
                {bet.event.home_team} vs {bet.event.away_team} · {formatDate(bet.event.starts_at, { day: 'numeric', month: 'short' })}
              </p>
              <p className="text-xs text-ink-soft">
                {t(bet.side === 'yes' ? 'sports.yes' : 'sports.no')} · ₹{formatNumber(bet.amount)}
              </p>
            </div>
            <Badge tone={tone(bet)}>{statusText(bet)}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
