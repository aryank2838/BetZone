import type { BetType, Game, GameStatus } from '@/types';
import { isClosedOn } from '@/lib/holiday';

/** One round's posted result, as get_result_history returns it. */
export interface ResultHistoryRow {
  round_date: string;
  open_digit: string | null;
  close_digit: string | null;
}

export interface ExposureItem {
  bet_type: BetType;
  number: string;
  total_stake: number;
  potential_payout: number;
}

type ScheduleFields = Pick<GameStatus, 'server_ist_date' | 'server_ist_time' | 'close_result_next_day' | 'close_result_at'>;

/** Shift a YYYY-MM-DD date by whole days. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The round whose results are being posted right now. For games whose close
 * result comes after midnight, that is still yesterday's round until the close
 * result time has passed.
 */
export function currentResultRound(status: ScheduleFields | undefined): string {
  if (!status) return '';
  if (!status.close_result_next_day || status.server_ist_time >= status.close_result_at) return status.server_ist_date;
  return addDays(status.server_ist_date, -1);
}

/** "15:30" / "15:30:00" -> minutes after midnight. */
function minutesOf(time: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

export interface OverdueResult {
  game: Game;
  label: string;
  phase: 'open' | 'close';
  roundDate: string;
  /** Schedule time the result was due (IST wall clock, "15:30:00"). */
  dueAt: string;
  minutesLate: number;
}

/**
 * Results whose scheduled time has passed but which are not posted yet.
 * Games on holiday are skipped.
 */
export function overdueResults(
  statuses: GameStatus[],
  history: Partial<Record<Game, ResultHistoryRow[]>>,
): OverdueResult[] {
  const overdue: OverdueResult[] = [];
  for (const status of statuses) {
    if (status.on_holiday) continue;
    const rows = history[status.game];
    if (!rows) continue; // history failed to load: don't guess
    const today = status.server_ist_date;
    const now = minutesOf(status.server_ist_time);
    const round = (date: string) => rows.find((row) => row.round_date === date);
    const label = status.label || status.game;

    // No round runs on a weekly day off, so no result is due for it.
    const runs = (date: string) => !isClosedOn(date, status.closed_weekdays);

    if (runs(today) && status.server_ist_time >= status.open_result_at && !round(today)?.open_digit) {
      overdue.push({
        game: status.game, label, phase: 'open', roundDate: today,
        dueAt: status.open_result_at, minutesLate: now - minutesOf(status.open_result_at),
      });
    }
    const closeRound = status.close_result_next_day ? addDays(today, -1) : today;
    if (runs(closeRound) && status.server_ist_time >= status.close_result_at && !round(closeRound)?.close_digit) {
      overdue.push({
        game: status.game, label, phase: 'close', roundDate: closeRound,
        dueAt: status.close_result_at, minutesLate: now - minutesOf(status.close_result_at),
      });
    }
  }
  return overdue.sort((a, b) => b.minutesLate - a.minutesLate);
}

const OPEN_PHASE_TYPES: BetType[] = ['single_open', 'patti_open'];

/**
 * Exposure items that can still be paid out: once the open result is posted,
 * open-phase bets are settled; once the close result is posted, everything is.
 */
export function unsettledExposure(items: ExposureItem[], result: ResultHistoryRow | undefined): ExposureItem[] {
  if (result?.close_digit) return [];
  if (result?.open_digit) return items.filter((item) => !OPEN_PHASE_TYPES.includes(item.bet_type));
  return items;
}

export interface RiskItem extends ExposureItem {
  game: Game;
  label: string;
  roundDate: string;
}

/** The single largest unsettled potential payout across games, or null if none. */
export function biggestRisk(perGame: Array<{ game: Game; label: string; roundDate: string; items: ExposureItem[] }>): RiskItem | null {
  let best: RiskItem | null = null;
  for (const entry of perGame) {
    for (const item of entry.items) {
      if (item.potential_payout <= 0) continue;
      if (!best || item.potential_payout > best.potential_payout) {
        best = { ...item, game: entry.game, label: entry.label, roundDate: entry.roundDate };
      }
    }
  }
  return best;
}

/** "45m", "2h 10m", "3d 4h" for how long a request has waited. */
export function formatWaiting(createdAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How urgent a wait is: under 30 minutes is fine, over 2 hours is late. */
export function waitingTone(createdAt: string, nowMs: number): 'ok' | 'warning' | 'late' {
  const minutes = (nowMs - Date.parse(createdAt)) / 60_000;
  if (minutes >= 120) return 'late';
  if (minutes >= 30) return 'warning';
  return 'ok';
}

/** Pending requests first, oldest first; then processed ones, newest first. */
export function sortForReview<T extends { status: string; created_at: string }>(requests: T[]): T[] {
  return [...requests].sort((a, b) => {
    const aPending = a.status === 'pending';
    const bPending = b.status === 'pending';
    if (aPending !== bPending) return aPending ? -1 : 1;
    const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
    return aPending ? diff : -diff;
  });
}

/** Browser tab title with the number of waiting requests, e.g. "(3) BetZone". */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}
