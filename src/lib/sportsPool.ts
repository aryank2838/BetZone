export type SportSide = 'yes' | 'no';
export type Sport = 'football' | 'cricket';

export interface SportEvent {
  id: string;
  sport: Sport;
  competition: string;
  competition_name: string;
  home_team: string;
  away_team: string;
  subject_side: 'home' | 'away';
  starts_at: string;
  state: 'open' | 'closed' | 'settled' | 'void';
  provider_status: 'scheduled' | 'live' | 'finished' | 'cancelled';
  home_score: string | null;
  away_score: string | null;
  outcome: SportSide | null;
  void_reason: string | null;
  fee_percent: number;
  /** Pool totals, house money included. */
  yes_total: number;
  no_total: number;
  /** House money on each side (part of the totals above). */
  house_yes: number;
  house_no: number;
  house_seeded: boolean;
  my_yes: number;
  my_no: number;
}

export interface SportEventsResponse {
  football_enabled: boolean;
  cricket_enabled: boolean;
  min_bet: number;
  max_bet: number;
  /** House money a match with no bets yet gets on each side with its first bet (0 = none today). */
  house_seed: number;
  events: SportEvent[];
}

export interface MySportBet {
  id: string;
  side: SportSide;
  amount: number;
  status: 'open' | 'won' | 'lost' | 'refunded';
  payout: number;
  created_at: string;
  event: Pick<SportEvent, 'id' | 'sport' | 'competition_name' | 'home_team' | 'away_team' | 'subject_side'
    | 'starts_at' | 'state' | 'outcome' | 'void_reason' | 'home_score' | 'away_score'>;
}

/** The team the question is about: "Will <team> win?". */
export function subjectTeam(event: Pick<SportEvent, 'home_team' | 'away_team' | 'subject_side'>) {
  return event.subject_side === 'away' ? event.away_team : event.home_team;
}

/** Yes share of the pool, 0-100. 50 when the pool is empty. */
export function yesShare(yesTotal: number, noTotal: number) {
  const total = yesTotal + noTotal;
  return total === 0 ? 50 : Math.round((yesTotal / total) * 100);
}

/**
 * Estimated total payout (stake included) if this bet wins and nobody else
 * bets. Mirrors sport_settle_internal(): fee = floor(losing pool * fee% / 100),
 * winner gets stake + floor(rest * stake / winning pool).
 * `refund` is true when the other side is empty, so the stake would come back.
 */
export function estimatePayout({ stake, side, yesTotal, noTotal, feePercent }: {
  stake: number;
  side: SportSide;
  yesTotal: number;
  noTotal: number;
  feePercent: number;
}): { payout: number; refund: boolean } {
  if (!Number.isFinite(stake) || stake <= 0) return { payout: 0, refund: false };
  const winPool = (side === 'yes' ? yesTotal : noTotal) + stake;
  const losePool = side === 'yes' ? noTotal : yesTotal;
  if (losePool <= 0) return { payout: stake, refund: true };
  const distributable = losePool - Math.floor((losePool * feePercent) / 100);
  return { payout: stake + Math.floor((distributable * stake) / winPool), refund: false };
}

/**
 * Pool totals to estimate with. A match that has not had house money yet gets
 * `nextSeed` on each side with its first bet, so count it in advance.
 */
export function poolForEstimate(
  event: Pick<SportEvent, 'yes_total' | 'no_total' | 'house_seeded'>,
  nextSeed: number,
): { yesTotal: number; noTotal: number } {
  const seed = !event.house_seeded && nextSeed > 0 ? nextSeed : 0;
  return { yesTotal: event.yes_total + seed, noTotal: event.no_total + seed };
}

/**
 * The side with much less money (under a quarter of the pool), to nudge
 * players towards it. Null when the pool is empty or roughly balanced.
 */
export function thinSide(yesTotal: number, noTotal: number): SportSide | null {
  const total = yesTotal + noTotal;
  if (total <= 0) return null;
  if (yesTotal * 4 < total) return 'yes';
  if (noTotal * 4 < total) return 'no';
  return null;
}

/** Money players have put on a match, house money left out. */
export function playerMoney(event: Pick<SportEvent, 'yes_total' | 'no_total' | 'house_yes' | 'house_no'>) {
  return Math.max(0, event.yes_total + event.no_total - event.house_yes - event.house_no);
}

/** How many matches per sport get the Popular badge. */
export const POPULAR_LIMIT = 3;
/** Player money (₹, house money left out) a match needs for the Popular badge. */
export const POPULAR_MIN_POOL = 500;

/**
 * Upcoming matches go in this order:
 * 1. ones the viewer has bet on, soonest kick-off first;
 * 2. ones other players have bet on, the most money first;
 * 3. the rest, soonest kick-off first.
 * Live and finished matches stay last, in the order the server sent.
 */
export function sortMatches<T extends SportEvent>(events: T[], nowMs: number): T[] {
  const rank = (event: T) => {
    if (!isBettable(event, nowMs)) return 3;
    if (event.my_yes + event.my_no > 0) return 0;
    return playerMoney(event) > 0 ? 1 : 2;
  };
  return events
    .map((event, index) => ({ event, index, rank: rank(event), starts: Date.parse(event.starts_at) }))
    .sort((a, b) => (
      a.rank - b.rank
      || (a.rank === 1 ? playerMoney(b.event) - playerMoney(a.event) : 0)
      || (a.rank < 3 ? a.starts - b.starts : 0)
      || a.index - b.index
    ))
    .map(({ event }) => event);
}

/**
 * Ids of the upcoming matches with the most player money (up to POPULAR_LIMIT),
 * counting only matches with at least POPULAR_MIN_POOL from players.
 */
export function popularIds(events: SportEvent[], nowMs: number): Set<string> {
  return new Set(
    events
      .filter((event) => isBettable(event, nowMs) && playerMoney(event) >= POPULAR_MIN_POOL)
      .sort((a, b) => playerMoney(b) - playerMoney(a))
      .slice(0, POPULAR_LIMIT)
      .map((event) => event.id),
  );
}

/** Kick-off is in the future and the match is still open. */
export function isBettable(event: Pick<SportEvent, 'state' | 'starts_at' | 'provider_status'>, nowMs: number) {
  return event.state === 'open' && event.provider_status === 'scheduled' && Date.parse(event.starts_at) > nowMs;
}
