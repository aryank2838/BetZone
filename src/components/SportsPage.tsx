import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Trophy } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import { subjectTeam, type MySportBet, type Sport, type SportEventsResponse } from '@/lib/sportsPool';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import Badge from '@/components/ui/Badge';
import { Card, SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';
import SportEventCard from '@/components/sports/SportEventCard';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

const REFRESH_MS = 60_000;

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
                    <SportEventCard
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
