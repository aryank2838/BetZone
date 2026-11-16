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
  yes_total: number;
  no_total: number;
  my_yes: number;
  my_no: number;
}

export interface SportEventsResponse {
  football_enabled: boolean;
  cricket_enabled: boolean;
  min_bet: number;
  max_bet: number;
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

/** Kick-off is in the future and the match is still open. */
export function isBettable(event: Pick<SportEvent, 'state' | 'starts_at' | 'provider_status'>, nowMs: number) {
  return event.state === 'open' && event.provider_status === 'scheduled' && Date.parse(event.starts_at) > nowMs;
}
