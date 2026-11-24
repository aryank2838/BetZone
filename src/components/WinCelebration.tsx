import { useEffect, useState } from 'react';
import { PartyPopper, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { GAME_LABELS, type Game } from '@/types';
import { REVEAL_WINDOW_MS, readCelebratedWins, saveCelebratedWins } from '@/lib/resultReveal';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

interface Win {
  ids: string[];
  amount: number;
  games: string[];
}

const CONFETTI_COLORS = ['#fbbf24', '#34d399', '#22d3ee', '#f472b6', '#a78bfa', '#fb923c'];
const AUTO_CLOSE_MS = 10_000;

const gameName = (game: string) => GAME_LABELS[game as Game] ?? (game ? game[0].toUpperCase() + game.slice(1) : '');

/**
 * "You won ₹X!" with confetti, once per payout on this device. `checkKey`
 * changes whenever Home reloads results, so a payout made by a new result is
 * picked up within the same refresh.
 */
export default function WinCelebration({ checkKey, onViewBets }: { checkKey: number; onViewBets: () => void }) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const [win, setWin] = useState<Win | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const since = new Date(Date.now() - REVEAL_WINDOW_MS).toISOString();
        // RLS limits the ledger to the player's own rows.
        const { data, error } = await supabase
          .from('point_ledger')
          .select('id, delta, metadata')
          .eq('reason', 'winning_payout')
          .gt('delta', 0)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(50);
        if (!active || error || !data) return;
        const celebrated = new Set(readCelebratedWins());
        const fresh = (data as { id: string; delta: number; metadata: { game?: string } | null }[])
          .filter((row) => !celebrated.has(row.id));
        if (fresh.length === 0) return;
        setWin({
          ids: fresh.map((row) => row.id),
          amount: fresh.reduce((sum, row) => sum + row.delta, 0),
          games: [...new Set(fresh.map((row) => row.metadata?.game ?? '').filter(Boolean))],
        });
      } catch { /* a celebration is never worth an error message */ }
    })();
    return () => { active = false; };
  }, [checkKey]);

  const close = () => {
    if (win) saveCelebratedWins([...readCelebratedWins(), ...win.ids]);
    setWin(null);
  };

  useEffect(() => {
    if (!win) return;
    // Seen once is enough: mark it now, so a reload does not show it again.
    saveCelebratedWins([...readCelebratedWins(), ...win.ids]);
    const timer = window.setTimeout(() => setWin(null), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [win]);

  if (!win) return null;

  const games = win.games.map(gameName).join(', ');
  return (
    <section
      role="status"
      aria-live="polite"
      className="relative overflow-hidden rounded-card border border-amber-600/60 bg-gradient-to-br from-amber-900/60 via-surface to-brand-900/40 p-5 animate-scale-in"
    >
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {Array.from({ length: 24 }, (_, index) => (
          <span
            key={index}
            className="confetti-piece"
            style={{
              left: `${(index * 37) % 100}%`,
              backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
              animationDelay: `${(index % 8) * 0.12}s`,
            }}
          />
        ))}
      </div>
      <button type="button" onClick={close} aria-label={t('win.close')} className="tap-target absolute right-1 top-1 rounded-lg text-ink-muted hover:text-ink-strong">
        <X className="h-4 w-4" />
      </button>
      <div className="relative flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-amber-400/20 text-amber-300 animate-pulse-glow">
          <PartyPopper className="h-7 w-7" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-lg font-extrabold text-ink-strong">{t('win.title')}</p>
          <p className="text-3xl font-black tabular-nums tracking-tight text-amber-300">₹{formatNumber(win.amount)}</p>
          <p className="mt-0.5 text-sm text-ink-soft">
            {games ? interpolate(t('win.bodyGame'), { game: games }) : t('win.body')}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => { close(); onViewBets(); }}
        className="relative mt-4 min-h-tap w-full rounded-control border border-amber-600/60 bg-amber-500/15 text-sm font-semibold text-amber-200 hover:bg-amber-500/25"
      >
        {t('win.viewBets')}
      </button>
    </section>
  );
}
