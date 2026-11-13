import type { GameStatus } from '@/types';
import { countdownTone } from '@/lib/countdown';
import { isOnHoliday } from '@/lib/holiday';

export type GamePhase = 'holiday' | 'open' | 'closing' | 'closed';

/**
 * One overall status for a game card, from its two betting windows.
 * "closing" means the soonest open window ends in under 10 minutes.
 */
export function gamePhase(status: GameStatus, nowMs: number): GamePhase {
  if (isOnHoliday(status)) return 'holiday';
  const tones = [
    status.open_bets_open ? countdownTone(status.open_bets_close_ts, nowMs) : 'closed',
    status.close_bets_open ? countdownTone(status.close_bets_close_ts, nowMs) : 'closed',
  ].filter((tone) => tone !== 'closed');
  if (tones.length === 0) return 'closed';
  // Another window still has plenty of time: the game is simply open.
  if (tones.includes('normal')) return 'open';
  return 'closing';
}
