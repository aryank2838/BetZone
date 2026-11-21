import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import Alert from '@/components/ui/Alert';

export interface AdminSportBet {
  id: string;
  user_id: string;
  user_name: string;
  side: 'yes' | 'no';
  amount: number;
  from_points: number;
  from_wallet: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout: number;
  created_at: string;
}

const rupees = (value: number) => `₹${value.toLocaleString('en-IN')}`;
const time = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const STATUS: Record<AdminSportBet['status'], { label: (bet: AdminSportBet) => string; className: string }> = {
  open: { label: () => 'Waiting', className: 'text-amber-300' },
  won: { label: (bet) => `Won ${rupees(bet.payout)}`, className: 'text-emerald-300' },
  lost: { label: () => 'Lost', className: 'text-rose-300' },
  refunded: { label: (bet) => `Refunded ${rupees(bet.payout)}`, className: 'text-ink-muted' },
};

/** Every player's bet on one match, shown when the admin opens "See bets". */
export default function SportEventBets({ eventId, subject }: { eventId: string; subject: string }) {
  const [bets, setBets] = useState<AdminSportBet[] | null>(null);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const [side, setSide] = useState<'all' | 'yes' | 'no'>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error: rpcError } = await supabase.rpc('admin_sport_event_bets', { p_event_id: eventId });
      if (!active) return;
      if (rpcError) {
        const friendly = friendlyError(rpcError);
        setError({ text: friendly.message, raw: rawErrorMessage(rpcError) });
        return;
      }
      setBets((data as AdminSportBet[] | null) ?? []);
    })();
    return () => { active = false; };
  }, [eventId]);

  const totals = useMemo(() => {
    const sum = (which: 'yes' | 'no') => {
      const rows = (bets ?? []).filter((bet) => bet.side === which);
      return { players: new Set(rows.map((bet) => bet.user_id)).size, amount: rows.reduce((total, bet) => total + bet.amount, 0) };
    };
    return { yes: sum('yes'), no: sum('no') };
  }, [bets]);

  if (error) return <Alert tone="error" details={error.raw}>{error.text}</Alert>;
  if (!bets) {
    return <div className="flex items-center gap-2 py-3 text-sm text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading bets…</div>;
  }
  if (bets.length === 0) return <p className="py-2 text-sm text-ink-muted">No player bets on this match.</p>;

  const needle = query.trim().toLowerCase();
  const shown = bets.filter((bet) => (side === 'all' || bet.side === side) && (!needle || bet.user_name.toLowerCase().includes(needle)));
  const chip = (active: boolean) => `min-h-[36px] rounded-full border px-3 text-xs font-semibold ${
    active ? 'border-brand-400 bg-brand-950 text-brand-200' : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
  }`;

  return (
    <div className="space-y-3 border-t border-surface-border pt-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-2">
          <p className="text-xs text-emerald-300">Yes · {subject} wins</p>
          <p className="font-semibold text-ink-strong">{rupees(totals.yes.amount)} · {totals.yes.players} {totals.yes.players === 1 ? 'player' : 'players'}</p>
        </div>
        <div className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-3 py-2">
          <p className="text-xs text-rose-300">No</p>
          <p className="font-semibold text-ink-strong">{rupees(totals.no.amount)} · {totals.no.players} {totals.no.players === 1 ? 'player' : 'players'}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'yes', 'no'] as const).map((value) => (
          <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)} className={chip(side === value)}>
            {value === 'all' ? `All ${bets.length}` : value === 'yes' ? 'Yes' : 'No'}
          </button>
        ))}
        {bets.length > 8 && (
          <label className="relative min-w-[140px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a player"
              aria-label="Find a player"
              className="min-h-[36px] w-full rounded-full border border-surface-strong bg-surface-raised pl-8 pr-3 text-xs text-ink-strong focus:border-brand-400 focus:outline-none"
            />
          </label>
        )}
      </div>

      {shown.length === 0 ? <p className="text-sm text-ink-muted">No bets match.</p> : (
        <ul className="divide-y divide-surface-border rounded-lg border border-surface-border">
          {shown.map((bet) => {
            const look = STATUS[bet.status];
            return (
              <li key={bet.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-strong">{bet.user_name}</p>
                  <p className="text-xs text-ink-muted">
                    {time(bet.created_at)}
                    {bet.from_points > 0 && bet.from_wallet > 0
                      ? ` · play ${rupees(bet.from_points)} + wallet ${rupees(bet.from_wallet)}`
                      : bet.from_points > 0 ? ' · play balance' : ' · wallet'}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums">
                    <span className={bet.side === 'yes' ? 'text-emerald-300' : 'text-rose-300'}>{bet.side === 'yes' ? 'Yes' : 'No'}</span>
                    <span className="text-ink-strong"> {rupees(bet.amount)}</span>
                  </p>
                  <p className={`text-xs ${look.className}`}>{look.label(bet)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
