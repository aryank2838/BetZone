import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { PartyPopper, Trophy } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { gameLook } from '@/lib/gameLook';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import { localeFor } from '@/i18n/context';

/** One row of get_recent_winners(). */
export interface RecentWinner {
  player: string;
  game: string;
  game_label: string;
  amount: number;
  won_at: string;
}

const REFRESH_MS = 2 * 60 * 1000;
/** Seconds each winner stays on screen while scrolling, roughly. */
const SECONDS_PER_ITEM = 4;

function timeAgo(iso: string, nowMs: number, locale: string): string {
  const minutes = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60000));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (minutes < 60) return format.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, 'hour');
  return format.format(-Math.round(hours / 24), 'day');
}

/** Scrolling strip of real recent wins (names hidden). Hidden when there are none or the admin turned it off. */
export default function WinnersTicker() {
  const { t, language } = useT();
  const { formatNumber } = useFormat();
  const [winners, setWinners] = useState<RecentWinner[]>([]);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('get_recent_winners');
      // A failed refresh keeps the last list: the ticker is decoration, never an error.
      if (!error) setWinners((data as RecentWinner[] | null) ?? []);
    } catch { /* keep the last list */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(() => { void load(); }, REFRESH_MS);

  if (winners.length === 0) return null;

  const nowMs = Date.now();
  const locale = localeFor(language);
  const items = winners.map((winner, index) => (
    <li key={`${winner.won_at}-${index}`} className="flex shrink-0 items-center gap-2 whitespace-nowrap pr-6 text-sm">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: gameLook(winner.game).color }} aria-hidden="true" />
      <span className="font-semibold text-ink-strong">{winner.player}</span>
      <span className="text-ink-muted">{interpolate(t('winners.wonOn'), { game: winner.game_label })}</span>
      <span className="font-extrabold tabular-nums text-amber-300">₹{formatNumber(winner.amount)}</span>
      <span className="text-xs text-ink-muted">· {timeAgo(winner.won_at, nowMs, locale)}</span>
    </li>
  ));

  return (
    <section aria-label={t('winners.title')} className="overflow-hidden rounded-card border border-amber-800/50 bg-gradient-to-r from-amber-950/50 via-surface to-amber-950/30 animate-slide-up">
      <div className="flex items-center">
        <div className="flex shrink-0 items-center gap-1.5 border-r border-amber-800/50 bg-amber-950/60 px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-amber-300">
          <Trophy className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('winners.title')}</span>
          <PartyPopper className="h-4 w-4 sm:hidden" aria-hidden="true" />
        </div>
        <div className="winners-ticker min-w-0 flex-1 overflow-hidden py-2.5 pl-3" tabIndex={0}>
          <div
            className="winners-marquee flex w-max"
            style={{ '--marquee-duration': `${Math.max(20, winners.length * SECONDS_PER_ITEM)}s` } as CSSProperties}
          >
            <ul className="flex">{items}</ul>
            {/* A second copy makes the loop seamless; screen readers skip it. */}
            <ul className="flex" aria-hidden="true">{items}</ul>
          </div>
        </div>
      </div>
    </section>
  );
}
