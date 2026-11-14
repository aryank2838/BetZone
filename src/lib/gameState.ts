import type { GameStatus } from '@/types';
import { countdownTone } from '@/lib/countdown';
import { isDayOff, isOnHoliday } from '@/lib/holiday';

/**
 * "later": betting has not opened yet today.
 * "closed": betting is over for today.
 */
export type GamePhase = 'holiday' | 'dayOff' | 'open' | 'closing' | 'later' | 'closed';

/** IST wall-clock time "HH:MM" for a moment. IST has no daylight saving, so +5:30 is exact. */
export function istClock(nowMs: number): string {
  return new Date(nowMs + 330 * 60_000).toISOString().slice(11, 16);
}

/**
 * One overall status for a game card, from its two betting windows.
 * "closing" means the soonest open window ends in under 10 minutes.
 */
export function gamePhase(status: GameStatus, nowMs: number): GamePhase {
  if (isOnHoliday(status)) return 'holiday';
  if (isDayOff(status)) return 'dayOff';
  const tones = [
    status.open_bets_open ? countdownTone(status.open_bets_close_ts, nowMs) : 'closed',
    status.close_bets_open ? countdownTone(status.close_bets_close_ts, nowMs) : 'closed',
  ].filter((tone) => tone !== 'closed');
  if (tones.length === 0) {
    return istClock(nowMs) < status.bets_open_at.slice(0, 5) ? 'later' : 'closed';
  }
  // Another window still has plenty of time: the game is simply open.
  if (tones.includes('normal')) return 'open';
  return 'closing';
}

export type HomeGroup = 'open' | 'later' | 'closed';

export interface HomeGame {
  status: GameStatus;
  phase: GamePhase;
  group: HomeGroup;
}

const RANK: Record<GamePhase, number> = { closing: 0, open: 1, later: 2, closed: 3, dayOff: 4, holiday: 4 };

/** The next cutoff of a game that is taking bets, in ms. */
function nextCutoff(status: GameStatus): number {
  const cutoff = status.open_bets_open ? status.open_bets_close_ts : status.close_bets_close_ts;
  const ms = Date.parse(cutoff);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Home screen order: games closing soon, then open games (soonest cutoff first),
 * then games opening later today (earliest first), then closed games and days off.
 */
export function homeOrder(statuses: GameStatus[], nowMs: number): HomeGame[] {
  return statuses
    .map((status, index) => ({ status, index, phase: gamePhase(status, nowMs) }))
    .sort((a, b) => {
      const byRank = RANK[a.phase] - RANK[b.phase];
      if (byRank) return byRank;
      if (a.phase === 'open' || a.phase === 'closing') return nextCutoff(a.status) - nextCutoff(b.status);
      if (a.phase === 'later') return a.status.bets_open_at.localeCompare(b.status.bets_open_at);
      return a.index - b.index;
    })
    .map(({ status, phase }) => ({
      status,
      phase,
      group: phase === 'open' || phase === 'closing' ? 'open' : phase === 'later' ? 'later' : 'closed',
    }));
}
