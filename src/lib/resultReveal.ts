import type { GameResult } from '@/types';

/**
 * Remembers which result each game last showed on this device, so a newly
 * declared result can flip in once instead of just appearing.
 */
const SEEN_KEY = 'betzone_seen_results';
const CELEBRATED_KEY = 'betzone_celebrated_wins';
/** A result posted longer ago than this is old news: shown without the animation. */
export const REVEAL_WINDOW_MS = 12 * 60 * 60 * 1000;

type ResultLike = Pick<GameResult, 'game' | 'round_date' | 'open_digit' | 'close_digit' | 'open_posted_at' | 'close_posted_at'>;

export const resultSignature = (result: ResultLike) =>
  `${result.round_date}|${result.open_digit ?? ''}|${result.close_digit ?? ''}`;

/**
 * Games whose result changed since this device last saw it, and the updated
 * "seen" map to store. A game seen for the first time is only remembered, so
 * a new device does not animate every card at once.
 */
export function findNewResults(results: ResultLike[], seen: Record<string, string>, nowMs: number) {
  const next = { ...seen };
  const fresh: string[] = [];
  for (const result of results) {
    const signature = resultSignature(result);
    const before = seen[result.game];
    next[result.game] = signature;
    if (before === undefined || before === signature) continue;
    if (!result.open_digit && !result.close_digit) continue;
    const posted = Math.max(
      result.open_posted_at ? Date.parse(result.open_posted_at) : 0,
      result.close_posted_at ? Date.parse(result.close_posted_at) : 0,
    );
    if (nowMs - posted <= REVEAL_WINDOW_MS) fresh.push(result.game);
  }
  return { fresh, next };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: animate again next time */ }
}

export function readSeenResults(): Record<string, string> {
  const value = readJson<unknown>(SEEN_KEY, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
}

export const saveSeenResults = (seen: Record<string, string>) => writeJson(SEEN_KEY, seen);

/** Winning payouts already celebrated on this device (ledger ids, newest kept). */
export function readCelebratedWins(): string[] {
  const value = readJson<unknown>(CELEBRATED_KEY, []);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

export function saveCelebratedWins(ids: string[]) {
  writeJson(CELEBRATED_KEY, ids.slice(-100));
}
