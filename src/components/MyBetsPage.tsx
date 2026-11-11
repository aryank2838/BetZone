import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { GAME_LABELS, BET_TYPES, type Game, type BetType } from '@/types';
import HelpButton from '@/components/HelpButton';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { ArrowLeft, Loader2, ReceiptText } from 'lucide-react';
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
  onBack: () => void;
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

export default function MyBetsPage({ onBack, onGames }: MyBetsPageProps) {
  const { formatNumber } = useFormat();
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-5 py-3.5">
          <button onClick={onBack} className="tap-target p-1 text-slate-400 hover:text-white" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-bold text-white">My bets</h1>
            <p className="text-[11px] text-slate-400">Your submitted picks and results</p>
          </div>
          <HelpButton />
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-5 px-5 py-6">
        <section className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:grid-cols-3">
          <label className="text-xs text-slate-400">
            Game
            <select
              value={game}
              onChange={(event) => setGame(event.target.value as Game | '')}
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
            >
              <option value="">All games</option>
              {gameStatuses.map((status) => (
                <option key={status.game} value={status.game}>{gameLabel(status.game)}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" />
          </label>
          <label className="text-xs text-slate-400">
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" />
          </label>
        </section>

        {errorMessage && (
          <div role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
            <p>{errorMessage}</p>
            {errorDetails && <p className="mt-1 text-xs text-rose-400/70">{errorDetails}</p>}
            <button type="button" onClick={() => void load(0, false)} className="mt-2 text-xs font-semibold text-rose-200">Retry</button>
          </div>
        )}

        {loading ? (
          <ListSkeleton rows={4} />
        ) : rows.length === 0 && !errorMessage ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/80 px-5 py-12 text-center">
            <ReceiptText className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 font-semibold text-white">No bets yet</p>
            <p className="mt-1 text-sm text-slate-400">Your submitted picks will appear here.</p>
            <button type="button" onClick={onGames} className="mt-5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-400">
              Browse games
            </button>
          </section>
        ) : (
          <div className="space-y-5">
            {rows.map((round) => {
              const pickCount = round.bet_types.reduce((sum, betType) => sum + betType.picks.length, 0);
              return (
                <section key={`${round.round_date}:${round.game}`} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
                    <div>
                      <p className="font-semibold text-white">{round.round_date} · {gameLabel(round.game)}</p>
                      <p className="text-xs text-slate-400">
                        Settled stake {formatNumber(settledStake(round))} · Won {formatNumber(round.won)} · Net {formatNumber(roundNet(round))}
                      </p>
                      {round.pending_stake > 0 && (
                        <p className="text-xs text-amber-400/90">Pending stake {formatNumber(round.pending_stake)} (not settled yet)</p>
                      )}
                    </div>
                    <span className="text-xs text-slate-400">{pickCount} picks</span>
                  </div>
                  <div className="divide-y divide-slate-800/80">
                    {round.bet_types.map((betType) => (
                      <div key={`${round.game}-${round.round_date}-${betType.bet_type}`} className="px-4 py-3">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{BET_TYPES[betType.bet_type]?.label ?? betType.bet_type}</p>
                          <p className="text-xs text-slate-400">{betType.picks.length} picks</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {betType.picks.map((pick, index) => (
                            <div key={`${pick.number}-${index}`} className="min-w-[112px] rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-xs">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-bold text-white">{pick.number}</span>
                                <span className={pick.status === 'won' ? 'text-emerald-400' : pick.status === 'lost' ? 'text-slate-400' : 'text-amber-400'}>
                                  {pick.status}
                                </span>
                              </div>
                              <p className="mt-1 text-slate-400">Stake {formatNumber(pick.stake)} · Payout {formatNumber(pick.payout)}</p>
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
              <button type="button" onClick={loadMore} disabled={loadingMore} className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-900 disabled:opacity-50">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load more
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
