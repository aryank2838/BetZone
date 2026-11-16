import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, ListChecks, Radio, RefreshCw, Search, XCircle } from 'lucide-react';
import type { AdminGameOption } from './gameOptions';
import {
  BET_TYPE_ORDER, boardSummary, groupStatus, slipFilter, slipPayout, slipStatus,
  type BetsBoard, type BoardFilter, type BoardResult, type BoardSlip, type GroupStatus,
} from './betsBoard';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { formatClockTime } from '@/lib/countdown';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';
import { BET_TYPES, isCloseBet, type BetType, type Game, type GameStatus } from '@/types';

interface SelectionsTabProps {
  games: AdminGameOption[];
  game: Game;
  roundDate: string;
  /** Today's status of the selected game (betting windows). */
  status: GameStatus | undefined;
  onGameChange: (game: Game) => void;
  onRoundDateChange: (date: string) => void;
}

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-3 py-2.5 text-sm text-ink-strong focus:border-emerald-400 focus:outline-none';

const GROUP_LOOK: Record<GroupStatus, { label: string; pill: string; icon: typeof Radio }> = {
  live: { label: 'Live', pill: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200', icon: Radio },
  waiting: { label: 'Waiting for result', pill: 'border-amber-500/50 bg-amber-500/10 text-amber-200', icon: Clock },
  settled: { label: 'Settled', pill: 'border-sky-500/50 bg-sky-500/10 text-sky-200', icon: CheckCircle2 },
};

const STATUS_ORDER: Record<GroupStatus, number> = { live: 0, waiting: 1, settled: 2 };

const FILTERS: Array<{ id: BoardFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
];

function addDays(isoDate: string, days: number) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function Tiles({ value, tone }: { value: string | null; tone?: 'open' | 'close' }) {
  const digits = (value ?? '').split('');
  const count = Math.max(digits.length, 1);
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: value ? digits.length : count }, (_, i) => (
        <span
          key={i}
          className={`grid h-7 w-6 place-items-center rounded-md text-sm font-bold tabular-nums ${
            !value ? 'border border-dashed border-surface-strong text-ink-muted/60'
              : tone === 'open' ? 'bg-emerald-500/20 text-emerald-200'
                : tone === 'close' ? 'bg-sky-500/20 text-sky-200'
                  : 'bg-surface-raised text-ink-strong'
          }`}
        >
          {value ? digits[i] : '?'}
        </span>
      ))}
    </span>
  );
}

function ResultBanner({ result }: { result: BoardResult | null }) {
  const openText = result?.open_paid ? 'Open result paid' : 'Waiting for open result';
  const closeText = result?.close_paid ? 'Close result paid' : 'Waiting for close result';
  return (
    <div className="rounded-control border border-surface-border bg-surface/80 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Round result</p>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Tiles value={result?.open_patti ?? null} />
        <span className="text-ink-muted">-</span>
        <span className="flex gap-0.5 rounded-lg p-0.5 ring-1 ring-surface-strong">
          <Tiles value={result?.open_digit ?? null} tone="open" />
          <Tiles value={result?.close_digit ?? null} tone="close" />
        </span>
        <span className="text-ink-muted">-</span>
        <Tiles value={result?.close_patti ?? null} />
      </div>
      <p className="mt-2 text-center text-xs text-ink-muted">
        <span className={result?.open_paid ? 'text-emerald-300' : 'text-amber-300'}>{openText}</span>
        {' · '}
        <span className={result?.close_paid ? 'text-emerald-300' : 'text-amber-300'}>{closeText}</span>
      </p>
    </div>
  );
}

function Stat({ label, value, tone, wide }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn'; wide?: boolean }) {
  const color = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-rose-300' : tone === 'warn' ? 'text-amber-200' : 'text-ink-strong';
  return (
    <div className={`rounded-control border border-surface-border bg-surface/80 px-3 py-2.5 ${wide ? 'col-span-2 sm:col-span-1' : ''}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function SlipRow({ slip, group }: { slip: BoardSlip; group: GroupStatus }) {
  const { formatNumber, formatDate } = useFormat();
  const status = slipStatus(slip);
  const payout = slipPayout(slip);
  const badge = group === 'live'
    ? { text: 'Live', cls: 'border-emerald-500/50 text-emerald-200' }
    : status === 'won'
      ? { text: `Won ₹${formatNumber(payout)}`, cls: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' }
      : status === 'lost'
        ? { text: 'Lost', cls: 'border-rose-500/50 bg-rose-500/10 text-rose-200' }
        : { text: 'Waiting', cls: 'border-amber-500/50 text-amber-200' };
  const accent = status === 'won' ? 'border-l-emerald-500' : status === 'lost' ? 'border-l-rose-500/70' : group === 'live' ? 'border-l-emerald-700' : 'border-l-amber-500/70';

  return (
    <li className={`rounded-control border border-l-4 border-surface-border bg-surface/80 px-3 py-2.5 ${accent}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink-strong">{slip.user_name || 'Unnamed'}</p>
          <p className="text-[11px] text-ink-muted">
            ₹{formatNumber(slip.total_points)} · {slip.picks.length} {slip.picks.length === 1 ? 'number' : 'numbers'} · {formatDate(slip.updated_at, { hour: 'numeric', minute: '2-digit' })}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {slip.picks.map((pick, index) => (
          <span
            key={`${pick.number}-${index}`}
            className={`rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums ${
              pick.status === 'won' ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-100'
                : pick.status === 'lost' ? 'border-surface-border text-ink-muted line-through decoration-rose-400/60'
                  : 'border-surface-strong bg-surface-raised text-ink-soft'
            }`}
          >
            {pick.number}
            <span className="ml-1 font-normal opacity-80">₹{formatNumber(pick.stake)}</span>
            {pick.status === 'won' && <span className="ml-1">→ ₹{formatNumber(pick.payout)}</span>}
          </span>
        ))}
      </div>
    </li>
  );
}

export default function SelectionsTab({ games, game, roundDate, status, onGameChange, onRoundDateChange }: SelectionsTabProps) {
  const { formatNumber } = useFormat();
  const [board, setBoard] = useState<BetsBoard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [search, setSearch] = useState('');
  const today = status?.server_ist_date ?? '';

  const load = useCallback(async (quiet = false) => {
    if (!roundDate) return;
    if (!quiet) setLoading(true);
    const { data, error: rpcError } = await supabase.rpc('admin_bets_board', { p_game: game, p_round_date: roundDate });
    if (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setError({ text: `Could not load bets: ${friendly.message}`, raw: friendly.raw });
    } else {
      setBoard(data as BetsBoard);
      setError(null);
    }
    setLoading(false);
  }, [game, roundDate]);

  useEffect(() => { setBoard(null); void load(); }, [load]);

  const groups = useMemo(() => {
    const slips = board?.slips ?? [];
    return BET_TYPE_ORDER
      .map((betType) => ({
        betType,
        status: groupStatus(betType, board?.result ?? null, status, roundDate),
        slips: slips.filter((slip) => slip.bet_type === betType),
      }))
      .filter((group) => group.slips.length > 0)
      // Live first, then waiting for a result, then settled.
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  }, [board, status, roundDate]);

  // Keep today's round fresh while bets can still come in or results are pending.
  const active = roundDate === today && groups.some((group) => group.status !== 'settled');
  useVisibleInterval(() => { void load(true); }, 30_000, active);

  const summary = boardSummary(board?.slips ?? []);
  const needle = search.trim().toLowerCase();
  const counts: Record<BoardFilter, number> = { all: 0, live: 0, waiting: 0, won: 0, lost: 0 };
  for (const group of groups) {
    for (const slip of group.slips) {
      counts.all += 1;
      counts[slipFilter(slip, group.status)] += 1;
    }
  }
  const visible = groups
    .map((group) => ({
      ...group,
      slips: group.slips.filter((slip) => (filter === 'all' || slipFilter(slip, group.status) === filter)
        && (!needle || (slip.user_name ?? '').toLowerCase().includes(needle))),
    }))
    .filter((group) => group.slips.length > 0);

  const windowText = (betType: BetType) => {
    if (!status) return '';
    return `betting open till ${formatClockTime(isCloseBet(betType) ? status.close_bets_close_at : status.open_bets_close_at)}`;
  };

  return (
    <section className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-ink-muted">Game
          <select value={game} onChange={(e) => onGameChange(e.target.value as Game)} className={`${INPUT} mt-1.5`}>
            {games.map((option) => <option key={option.game} value={option.game}>{option.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-ink-muted">Round date (IST)
          <input type="date" value={roundDate} onChange={(e) => onRoundDateChange(e.target.value)} className={`${INPUT} mt-1.5`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {today && [['Today', today], ['Yesterday', addDays(today, -1)]].map(([label, date]) => (
          <button
            key={label}
            type="button"
            aria-pressed={roundDate === date}
            onClick={() => onRoundDateChange(date)}
            className={`min-h-[36px] rounded-full border px-3.5 text-[13px] font-medium ${
              roundDate === date ? 'border-brand-500 bg-brand-700 text-ink-strong' : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
            }`}
          >
            {label}
          </button>
        ))}
        <Button variant="ghost" className="ml-auto" onClick={() => { void load(); }} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>
      </div>

      {error && <Alert details={error.raw} onRetry={() => { void load(); }}>{error.text}</Alert>}

      {loading && !board ? <ListSkeleton rows={4} /> : board && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Total staked" value={`₹${formatNumber(summary.staked)}`} />
            <Stat label="Players · slips" value={`${summary.players} · ${summary.slips}`} />
            <Stat label="Waiting for result" value={`₹${formatNumber(summary.pendingStake)}`} tone={summary.pendingStake ? 'warn' : undefined} />
            <Stat label="Paid out" value={`₹${formatNumber(summary.paidOut)}`} />
            <Stat
              label="Your profit (settled)"
              value={`${summary.profit < 0 ? '−' : ''}₹${formatNumber(Math.abs(summary.profit))}`}
              tone={summary.settledStake === 0 ? undefined : summary.profit >= 0 ? 'good' : 'bad'}
              wide
            />
          </div>

          <ResultBanner result={board.result} />

          {counts.all > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter bets">
                {FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={filter === item.id}
                    onClick={() => setFilter(item.id)}
                    className={`min-h-[36px] rounded-full border px-3 text-[13px] font-medium ${
                      filter === item.id ? 'border-brand-500 bg-brand-700 text-ink-strong' : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
                    }`}
                  >
                    {item.label} <span className="tabular-nums opacity-70">{counts[item.id]}</span>
                  </button>
                ))}
              </div>
              <label className="relative block">
                <span className="sr-only">Search player</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search player" className={`${INPUT} pl-9`} />
              </label>
            </div>
          )}

          {counts.all === 0 ? (
            <div className="rounded-control border border-dashed border-surface-border px-4 py-8 text-center">
              <ListChecks className="mx-auto mb-2 h-5 w-5 text-ink-muted" aria-hidden="true" />
              <p className="text-sm text-ink-muted">No bets for this round.</p>
            </div>
          ) : visible.length === 0 ? (
            <p className="rounded-control border border-dashed border-surface-border px-4 py-6 text-center text-sm text-ink-muted">
              No bets match this filter.
            </p>
          ) : (
            <div className="space-y-5">
              {visible.map((group) => {
                const look = GROUP_LOOK[group.status];
                const Icon = look.icon;
                const stake = group.slips.reduce((sum, slip) => sum + slip.total_points, 0);
                const paid = group.slips.reduce((sum, slip) => sum + slipPayout(slip), 0);
                return (
                  <section key={group.betType} aria-label={BET_TYPES[group.betType].label}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-bold text-ink-strong">
                        {BET_TYPES[group.betType].label}
                        <span className="ml-1.5 text-xs font-medium text-ink-muted">pays {BET_TYPES[group.betType].multiplier}×</span>
                      </h3>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${look.pill}`}>
                        <Icon className="h-3 w-3" aria-hidden="true" />
                        {look.label}
                      </span>
                      <span className="ml-auto text-xs tabular-nums text-ink-muted">
                        ₹{formatNumber(stake)} staked{group.status === 'settled' ? ` · ₹${formatNumber(paid)} paid` : ''}
                      </span>
                    </div>
                    {group.status === 'live' && <p className="-mt-1 mb-2 text-[11px] text-emerald-300/80">{windowText(group.betType)}</p>}
                    <ul className="space-y-2">
                      {group.slips.map((slip) => <SlipRow key={slip.id} slip={slip} group={group.status} />)}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      {board && counts.all > 0 && (
        <p className="flex items-center justify-center gap-3 text-[11px] text-ink-muted">
          <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden="true" /> won</span>
          <span className="inline-flex items-center gap-1"><XCircle className="h-3 w-3 text-rose-400" aria-hidden="true" /> lost (crossed out)</span>
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3 text-amber-400" aria-hidden="true" /> waiting</span>
        </p>
      )}
    </section>
  );
}
