import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { GAME_LABELS, BET_TYPES, type Game, type BetType } from '@/types';
import HelpButton from '@/components/HelpButton';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { ReceiptText } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { formatHolidayDate } from '@/lib/holiday';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';
import { useGameStatus } from '@/lib/useGameStatus';
import { roundNet, settledStake } from '@/lib/betRounds';

interface BetPick {
  number: string;
  stake: number;
  status: 'pending' | 'won' | 'lost';
  payout: number;
}

interface BetRoundRow {
  game: Game;
  round_date: string;
  bet_types: Array<{ bet_type: BetType; picks: BetPick[] }>;
  staked: number;
  won: number;
  pending_stake: number;
}

interface MyBetsPageProps {
  onGames: () => void;
}

const PAGE_SIZE = 30;

function isBetRoundRow(value: unknown): value is BetRoundRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<BetRoundRow>;
  return typeof row.game === 'string'
    && typeof row.round_date === 'string'
    && Array.isArray(row.bet_types)
    && typeof row.staked === 'number'
    && typeof row.won === 'number'
    && typeof row.pending_stake === 'number';
}

export default function MyBetsPage({ onGames }: MyBetsPageProps) {
  const { formatNumber } = useFormat();
  const { t } = useT();
  const rupees = (value: number) => `₹${formatNumber(value)}`;
  const { statuses: gameStatuses } = useGameStatus();
  const gameLabel = (value: string) => gameStatuses.find((status) => status.game === value)?.label
    || GAME_LABELS[value as Game] || value;
  const [game, setGame] = useState<Game | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<BetRoundRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const requestId = useRef(0);

  const load = useCallback(async (nextOffset: number, append: boolean) => {
    const currentRequest = ++requestId.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setErrorMessage('');
    setErrorDetails('');
    try {
      const { data, error } = await supabase.rpc('get_my_bets', {
        p_game: game || null,
        p_from: from || null,
        p_to: to || null,
        p_limit: PAGE_SIZE,
        p_offset: nextOffset,
      });
      if (currentRequest !== requestId.current) return;
      if (error) {
        const friendly = friendlyError(error);
        setErrorMessage(friendly.message);
        if (friendly.key === 'errors.generic') {
          setErrorDetails(rawErrorMessage(error));
        }
      } else {
        const nextRows = ((data as unknown[] | null) ?? []).filter(isBetRoundRow);
        setRows((current) => append ? [...current, ...nextRows] : nextRows);
        setOffset(nextOffset + nextRows.length);
        setHasMore(nextRows.length === PAGE_SIZE);
      }
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      const friendly = friendlyError(error);
      setErrorMessage(friendly.message);
      if (friendly.key === 'errors.generic') {
        setErrorDetails(rawErrorMessage(error));
      }
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [game, from, to]);

  useEffect(() => {
    setRows([]);
    setOffset(0);
    setHasMore(false);
    void load(0, false);
  }, [load]);

  const loadMore = () => {
    if (!loadingMore && hasMore) void load(offset, true);
  };

  const statusLabel = (value: BetPick['status']) => t(value === 'won' ? 'bets.won' : value === 'lost' ? 'bets.lost' : 'bets.pending');
  const FIELD = 'mt-1.5 w-full rounded-control border border-surface-strong bg-surface-raised px-3 py-2.5 text-sm text-ink-strong';

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={t('bets.title')} subtitle={t('bets.subtitle')} actions={<HelpButton />} />

      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-5">
        <section aria-label={t('bets.filters')} className="grid grid-cols-1 gap-3 rounded-card border border-surface-border bg-surface/80 p-4 sm:grid-cols-3">
          <label className="text-sm text-ink-muted">
            {t('bets.game')}
            <select value={game} onChange={(event) => setGame(event.target.value as Game | '')} className={FIELD}>
              <option value="">{t('bets.allGames')}</option>
              {gameStatuses.map((status) => (
                <option key={status.game} value={status.game}>{gameLabel(status.game)}</option>
              ))}
            </select>
          </label>
          <label className="text-sm text-ink-muted">
            {t('bets.from')}
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={FIELD} />
          </label>
          <label className="text-sm text-ink-muted">
            {t('bets.to')}
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className={FIELD} />
          </label>
        </section>

        {errorMessage && <Alert details={errorDetails} onRetry={() => void load(0, false)}>{errorMessage}</Alert>}

        {loading ? (
          <ListSkeleton rows={4} />
        ) : rows.length === 0 && !errorMessage ? (
          <section className="rounded-card border border-surface-border bg-surface/80 px-5 py-12 text-center">
            <ReceiptText className="mx-auto h-8 w-8 text-ink-muted" aria-hidden="true" />
            <p className="mt-3 font-semibold text-ink-strong">{t('bets.emptyTitle')}</p>
            <p className="mt-1 text-sm text-ink-muted">{t('bets.emptyBody')}</p>
            <Button className="mt-5" onClick={onGames}>{t('bets.browse')}</Button>
          </section>
        ) : (
          <div className="space-y-5">
            {rows.map((round) => {
              const pickCount = round.bet_types.reduce((sum, betType) => sum + betType.picks.length, 0);
              const net = roundNet(round);
              return (
                <section key={`${round.round_date}:${round.game}`} className="overflow-hidden rounded-card border border-surface-border bg-surface/80">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-surface-border px-4 py-3">
                    <div>
                      <p className="font-semibold text-ink-strong">{gameLabel(round.game)} · {formatHolidayDate(round.round_date)}</p>
                      <p className="mt-0.5 text-sm text-ink-muted">
                        {interpolate(t('bets.summary'), { staked: rupees(settledStake(round)), won: rupees(round.won) })}
                      </p>
                      {round.pending_stake > 0 && (
                        <p className="text-sm text-amber-300">{interpolate(t('bets.pendingStake'), { amount: rupees(round.pending_stake) })}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <Badge tone={net > 0 ? 'success' : net < 0 ? 'danger' : 'neutral'}>
                        {interpolate(t('bets.net'), { amount: `${net > 0 ? '+' : net < 0 ? '−' : ''}${rupees(Math.abs(net))}` })}
                      </Badge>
                      <p className="mt-1 text-xs text-ink-muted">{interpolate(t('bets.pickCount'), { count: pickCount })}</p>
                    </div>
                  </div>
                  <div className="divide-y divide-surface-border/80">
                    {round.bet_types.map((betType) => (
                      <div key={`${round.game}-${round.round_date}-${betType.bet_type}`} className="px-4 py-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                          {BET_TYPES[betType.bet_type] ? t(`bet.name.${betType.bet_type}` as TranslationKey) : betType.bet_type}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {betType.picks.map((pick, index) => (
                            <div key={`${pick.number}-${index}`} className="min-w-[120px] rounded-lg border border-surface-border bg-surface-page/60 px-3 py-2 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-bold tabular-nums text-ink-strong">{pick.number}</span>
                                <Badge tone={pick.status === 'won' ? 'success' : pick.status === 'lost' ? 'neutral' : 'warning'}>{statusLabel(pick.status)}</Badge>
                              </div>
                              <p className="mt-1 text-xs text-ink-muted">
                                {interpolate(t('betslip.stake'), { points: formatNumber(pick.stake) })}
                                {pick.status === 'won' && <> · <span className="text-brand-300">{interpolate(t('bets.paid'), { amount: rupees(pick.payout) })}</span></>}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
            {hasMore && (
              <Button variant="secondary" fullWidth loading={loadingMore} onClick={loadMore}>
                {t('common.loadMore')}
              </Button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
