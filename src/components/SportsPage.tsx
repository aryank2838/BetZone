import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Search, SearchX, Trophy, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import { competitionsOf, matchesSearch, popularIds, sortMatches, type MySportBet, type Sport, type SportEventsResponse } from '@/lib/sportsPool';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { Card, SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';
import SportEventCard from '@/components/sports/SportEventCard';
import { SportBetRow } from '@/components/sports/MySportBets';
import { interpolate, useT } from '@/i18n/useT';

const REFRESH_MS = 60_000;

export default function SportsPage({ onAddFunds, onMyBets }: { onAddFunds: () => void; onMyBets: () => void }) {
  const { t } = useT();
  const { refreshProfile } = useAuth();
  const [data, setData] = useState<SportEventsResponse | null>(null);
  const [myBets, setMyBets] = useState<MySportBet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const [sport, setSport] = useState<Sport>('football');
  const [showRules, setShowRules] = useState(false);
  const [query, setQuery] = useState('');
  const [league, setLeague] = useState<string | null>(null);
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
  // Sorted against the last load's time, so cards don't jump around every second.
  const { events, popular, leagues } = useMemo(() => {
    const forSport = (data?.events ?? []).filter((event) => event.sport === sport);
    const now = Date.now();
    return { events: sortMatches(forSport, now), popular: popularIds(forSport, now), leagues: competitionsOf(forSport) };
  }, [data, sport]);
  const feePercent = events[0]?.fee_percent ?? 10;
  // A league picked for one sport does not exist in the other.
  const activeLeague = league && leagues.some((item) => item.name === league) ? league : null;
  const filtering = query.trim() !== '' || activeLeague !== null;
  const shown = filtering
    ? events.filter((event) => (!activeLeague || event.competition_name === activeLeague) && matchesSearch(event, query))
    : events;
  const otherSport = sports.find((s) => s !== sport);
  const otherSportHits = otherSport && query.trim()
    ? (data?.events ?? []).filter((event) => event.sport === otherSport && matchesSearch(event, query)).length
    : 0;
  const clearFilters = () => {
    setQuery('');
    setLeague(null);
  };

  const afterBet = async () => {
    await Promise.all([load(), refreshProfile()]);
  };

  return (
    <div>
      <PageHeader title={t('sports.title')} subtitle={t('sports.subtitle')} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-5 sm:px-5">
        {error && <Alert tone="error" details={error.raw} onRetry={() => { void load(); }}>{error.text}</Alert>}

        <YourBets bets={myBets} nowMs={nowMs} onMyBets={onMyBets} />

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

            {events.length > 0 && (
              <MatchFilters
                query={query}
                onQuery={setQuery}
                leagues={leagues}
                league={activeLeague}
                onLeague={setLeague}
                total={events.length}
                shown={shown.length}
              />
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
            ) : shown.length === 0 ? (
              <section className="rounded-card border border-surface-border bg-surface/80 px-5 py-10 text-center">
                <SearchX className="mx-auto h-8 w-8 text-ink-muted" aria-hidden="true" />
                <p className="mt-3 font-semibold text-ink-strong">
                  {query.trim() ? interpolate(t('sports.search.noneFor'), { query: query.trim() }) : t('sports.search.none')}
                </p>
                <p className="mt-1 text-sm text-ink-muted">{t('sports.search.noneHint')}</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {otherSport && otherSportHits > 0 && (
                    <Button onClick={() => { setLeague(null); setSport(otherSport); }}>
                      {interpolate(t('sports.search.inOther'), {
                        count: otherSportHits,
                        sport: t(otherSport === 'football' ? 'sports.football' : 'sports.cricket'),
                      })}
                    </Button>
                  )}
                  <Button variant="secondary" onClick={clearFilters}>{t('sports.search.clear')}</Button>
                </div>
              </section>
            ) : (
              <ul className="space-y-3">
                {shown.map((event) => (
                  <li key={event.id}>
                    <SportEventCard
                      event={event}
                      nowMs={nowMs}
                      popular={popular.has(event.id)}
                      minBet={data.min_bet}
                      maxBet={data.max_bet}
                      houseSeed={data.house_seed ?? 0}
                      onPlaced={afterBet}
                      onAddFunds={onAddFunds}
                    />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

      </main>
    </div>
  );
}

/** Search by team or league, plus one-tap league chips (shown when there is more than one league). */
function MatchFilters({ query, onQuery, leagues, league, onLeague, total, shown }: {
  query: string;
  onQuery: (value: string) => void;
  leagues: Array<{ name: string; count: number }>;
  league: string | null;
  onLeague: (value: string | null) => void;
  total: number;
  shown: number;
}) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const filtering = query.trim() !== '' || league !== null;
  const chip = (active: boolean) => `inline-flex min-h-[36px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition-colors ${
    active ? 'border-brand-400 bg-brand-950 text-brand-200' : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
  }`;

  return (
    <div className="space-y-3">
      <div role="search" className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onQuery('');
            // Close the phone keyboard so the results are visible.
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          placeholder={t('sports.search.placeholder')}
          aria-label={t('sports.search.label')}
          className="min-h-[48px] w-full rounded-control border border-surface-strong bg-surface-raised py-3 pl-10 pr-11 text-base text-ink-strong placeholder:text-ink-muted focus:border-brand-400 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => { onQuery(''); inputRef.current?.focus(); }}
            aria-label={t('sports.search.clear')}
            className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full text-ink-muted hover:bg-surface hover:text-ink-strong"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {leagues.length > 1 && (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex gap-2 pb-0.5" aria-label={t('sports.search.leagues')} role="group">
            <button type="button" aria-pressed={league === null} onClick={() => onLeague(null)} className={chip(league === null)}>
              {t('sports.search.allLeagues')}
            </button>
            {leagues.map((item) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={league === item.name}
                onClick={() => onLeague(league === item.name ? null : item.name)}
                className={chip(league === item.name)}
              >
                {item.name}
                <span className="text-xs text-ink-muted">{item.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {filtering && shown > 0 && (
        <p className="text-sm text-ink-muted" role="status">
          {interpolate(t('sports.search.count'), { shown, total })}
        </p>
      )}
    </div>
  );
}

/** Top of Sports: the player's bets still waiting for a result, and a link to all of them. */
function YourBets({ bets, nowMs, onMyBets }: { bets: MySportBet[]; nowMs: number; onMyBets: () => void }) {
  const { t } = useT();
  if (bets.length === 0) return null;
  const open = bets.filter((bet) => bet.status === 'open')
    .sort((a, b) => Date.parse(a.event.starts_at) - Date.parse(b.event.starts_at));

  if (open.length === 0) {
    return (
      <button
        type="button"
        onClick={onMyBets}
        className="flex min-h-[48px] w-full items-center justify-between gap-3 rounded-card border border-surface-border bg-surface/80 px-4 py-3 text-left text-sm font-semibold text-ink-soft hover:bg-surface-raised"
      >
        <span className="flex items-center gap-2"><Trophy className="h-4 w-4 text-brand-300" aria-hidden="true" />{t('sportBets.pastLink')}</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  const seeAll = (
    <button type="button" onClick={onMyBets} className="inline-flex min-h-[32px] items-center gap-1 text-sm font-semibold text-brand-300 hover:text-brand-200">
      {t('sportBets.seeAll')} <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  return (
    <section aria-labelledby="your-sport-bets">
      <SectionTitle id="your-sport-bets" icon={<Trophy className="h-4 w-4" />} action={seeAll}>
        {interpolate(t('sportBets.openTitle'), { count: open.length })}
      </SectionTitle>
      <ul className="space-y-2">
        {open.slice(0, 3).map((bet) => <li key={bet.id}><SportBetRow bet={bet} nowMs={nowMs} compact /></li>)}
      </ul>
      {open.length > 3 && (
        <button type="button" onClick={onMyBets} className="mt-2 min-h-[44px] w-full rounded-control border border-surface-border text-sm font-semibold text-ink-soft hover:bg-surface-raised">
          {interpolate(t('sportBets.more'), { count: open.length - 3 })}
        </button>
      )}
    </section>
  );
}
