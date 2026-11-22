import type { TranslationKey } from '@/i18n/context';

export type SportSide = 'yes' | 'no' | 'draw';
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
  /** Football matches have a third pool for a draw; otherwise a draw counts as No. */
  has_draw?: boolean;
  /** Pool totals, house money included. */
  yes_total: number;
  no_total: number;
  draw_total?: number;
  /** House money on each side (part of the totals above). */
  house_yes: number;
  house_no: number;
  house_draw?: number;
  house_seeded: boolean;
  my_yes: number;
  my_no: number;
  my_draw?: number;
}

/** Pool totals by side. drawTotal is 0 on a match without a Draw pool. */
export interface Pools {
  yesTotal: number;
  noTotal: number;
  drawTotal: number;
}

/**
 * The sides a match can be bet on, in the order they are shown. A Draw match
 * shows home team, Draw, away team, so the buttons line up with the badges.
 */
export function sidesOf(event: Pick<SportEvent, 'has_draw' | 'subject_side'>): SportSide[] {
  if (!event.has_draw) return ['yes', 'no'];
  return event.subject_side === 'away' ? ['no', 'draw', 'yes'] : ['yes', 'draw', 'no'];
}

/** The team the question is not about. */
export function otherTeam(event: Pick<SportEvent, 'home_team' | 'away_team' | 'subject_side'>) {
  return event.subject_side === 'away' ? event.home_team : event.away_team;
}

type Translate = (key: TranslationKey) => string;
type LabelEvent = Pick<SportEvent, 'has_draw' | 'home_team' | 'away_team' | 'subject_side'>;

/**
 * What a side is called on screen. On a Draw match the sides are the teams
 * ("Arsenal", "Draw", "Chelsea"); otherwise Yes / No for "Will <team> win?".
 */
export function sideName(event: LabelEvent, side: SportSide, t: Translate): string {
  if (event.has_draw && side === 'yes') return subjectTeam(event);
  if (event.has_draw && side === 'no') return otherTeam(event);
  return t(sideKey(side));
}

const ADMIN_SIDE: Record<SportSide, string> = { yes: 'Yes', no: 'No', draw: 'Draw' };

/** sideName() in English, for the admin screens (which are not translated). */
export function adminSideName(event: LabelEvent, side: SportSide): string {
  if (event.has_draw && side !== 'draw') return side === 'yes' ? subjectTeam(event) : otherTeam(event);
  return ADMIN_SIDE[side];
}

/** "Who will win?" on a Draw match, "Will <team> win?" otherwise. */
export function questionText(event: LabelEvent, t: Translate): string {
  return event.has_draw
    ? t('sports.questionWho')
    : t('sports.question').replace('{team}', subjectTeam(event));
}

/** The result line of a finished match. */
export function resultText(event: LabelEvent & Pick<SportEvent, 'outcome'>, t: Translate): string {
  if (event.outcome === 'draw') return t('sports.resultDraw');
  if (event.has_draw && event.outcome) {
    return t('sports.resultTeam').replace('{team}', event.outcome === 'yes' ? subjectTeam(event) : otherTeam(event));
  }
  return t(event.outcome === 'yes' ? 'sports.resultYes' : 'sports.resultNo').replace('{team}', subjectTeam(event));
}

export function poolsOf(event: Pick<SportEvent, 'yes_total' | 'no_total' | 'draw_total'>): Pools {
  return { yesTotal: event.yes_total, noTotal: event.no_total, drawTotal: event.draw_total ?? 0 };
}

export function poolFor(pools: Pools, side: SportSide) {
  return side === 'yes' ? pools.yesTotal : side === 'no' ? pools.noTotal : pools.drawTotal;
}

/** The viewer's own stake on one side of a match. */
export function myStake(event: Pick<SportEvent, 'my_yes' | 'my_no' | 'my_draw'>, side: SportSide) {
  return side === 'yes' ? event.my_yes : side === 'no' ? event.my_no : event.my_draw ?? 0;
}

/** Translation key for a side's label. */
export function sideKey(side: SportSide): TranslationKey {
  return side === 'yes' ? 'sports.yes' : side === 'no' ? 'sports.no' : 'sports.draw';
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
  event: Pick<SportEvent, 'id' | 'sport' | 'competition_name' | 'home_team' | 'away_team' | 'subject_side' | 'has_draw'
    | 'starts_at' | 'state' | 'outcome' | 'void_reason' | 'home_score' | 'away_score'>;
}

/** The team the question is about: "Will <team> win?". */
export function subjectTeam(event: Pick<SportEvent, 'home_team' | 'away_team' | 'subject_side'>) {
  return event.subject_side === 'away' ? event.away_team : event.home_team;
}

/**
 * Each side's share of the pool, 0-100, adding up to exactly 100 (largest
 * remainder). An even split when the pool is empty.
 */
export function poolShares(pools: Pools, sides: SportSide[]): Record<SportSide, number> {
  const out: Record<SportSide, number> = { yes: 0, no: 0, draw: 0 };
  const total = sides.reduce((sum, side) => sum + poolFor(pools, side), 0);
  const exact = sides.map((side) => ({
    side, value: total === 0 ? 100 / sides.length : (poolFor(pools, side) * 100) / total,
  }));
  let left = 100;
  for (const { side, value } of exact) { out[side] = Math.floor(value); left -= out[side]; }
  [...exact].sort((a, b) => (b.value % 1) - (a.value % 1)).slice(0, left)
    .forEach(({ side }) => { out[side] += 1; });
  return out;
}

/**
 * Estimated total payout (stake included) if this bet wins and nobody else
 * bets. Mirrors sport_settle_internal(): fee = floor(losing pool * fee% / 100),
 * winner gets stake + floor(rest * stake / winning pool).
 * `refund` is true when the other side is empty, so the stake would come back.
 */
export function estimatePayout({ stake, side, yesTotal, noTotal, drawTotal = 0, feePercent }: {
  stake: number;
  side: SportSide;
  yesTotal: number;
  noTotal: number;
  drawTotal?: number;
  feePercent: number;
}): { payout: number; refund: boolean } {
  if (!Number.isFinite(stake) || stake <= 0) return { payout: 0, refund: false };
  const mine = poolFor({ yesTotal, noTotal, drawTotal }, side);
  const winPool = mine + stake;
  const losePool = yesTotal + noTotal + drawTotal - mine;
  if (losePool <= 0) return { payout: stake, refund: true };
  const distributable = losePool - Math.floor((losePool * feePercent) / 100);
  return { payout: stake + Math.floor((distributable * stake) / winPool), refund: false };
}

/**
 * Pool totals to estimate with. A match that has not had house money yet gets
 * `nextSeed` on each side with its first bet, so count it in advance.
 */
export function poolForEstimate(
  event: Pick<SportEvent, 'yes_total' | 'no_total' | 'draw_total' | 'has_draw' | 'house_seeded'>,
  nextSeed: number,
): Pools {
  const seed = !event.house_seeded && nextSeed > 0 ? nextSeed : 0;
  return {
    yesTotal: event.yes_total + seed,
    noTotal: event.no_total + seed,
    drawTotal: (event.draw_total ?? 0) + (event.has_draw ? seed : 0),
  };
}

/**
 * The side with much less money (under half an even share: a quarter of a
 * Yes/No pool, a sixth of a three-way pool), to nudge players towards it.
 * Null when the pool is empty or roughly balanced. The emptiest side comes first.
 */
export function thinSide(yesTotal: number, noTotal: number, drawTotal?: number): SportSide | null {
  const sides: Array<[SportSide, number]> = [['yes', yesTotal], ['no', noTotal]];
  if (drawTotal !== undefined) sides.push(['draw', drawTotal]);
  const total = sides.reduce((sum, [, amount]) => sum + amount, 0);
  if (total <= 0) return null;
  const thin = sides
    .filter(([, amount]) => amount * 2 * sides.length < total)
    .sort((a, b) => a[1] - b[1]);
  return thin.length > 0 ? thin[0][0] : null;
}

/** Money players have put on a match, house money left out. */
export function playerMoney(event: Pick<SportEvent, 'yes_total' | 'no_total' | 'draw_total'
  | 'house_yes' | 'house_no' | 'house_draw'>) {
  return Math.max(0, event.yes_total + event.no_total + (event.draw_total ?? 0)
    - event.house_yes - event.house_no - (event.house_draw ?? 0));
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
    if (event.my_yes + event.my_no + (event.my_draw ?? 0) > 0) return 0;
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

/** Translation key for why a match was refunded (sport_events.void_reason). */
const REFUND_REASONS: Record<string, TranslationKey> = {
  one_sided: 'sports.reason.oneSided',
  no_winners: 'sports.reason.noWinners',
  cancelled_or_postponed: 'sports.reason.cancelled',
  start_moved_earlier: 'sports.reason.startMoved',
  no_result: 'sports.reason.noResult',
};

export function refundReasonKey(reason: string | null): TranslationKey {
  if (reason && REFUND_REASONS[reason]) return REFUND_REASONS[reason];
  return 'sports.reason.support';
}

export interface MySportBetTotals {
  bet_count: number;
  open_count: number;
  open_stake: number;
  won_count: number;
  /** Stakes of bets that won or lost (refunds left out). */
  settled_stake: number;
  /** Paid back on winning bets, stake included. */
  returned: number;
}

export type SportBetPhase = 'upcoming' | 'started' | 'won' | 'lost' | 'refunded';

/**
 * Where a player's bet stands, and what it made: profit is the payout minus
 * the stake for a win, minus the stake for a loss, and 0 otherwise.
 */
export function sportBetOutcome(bet: Pick<MySportBet, 'status' | 'amount' | 'payout' | 'event'>, nowMs: number): {
  phase: SportBetPhase;
  profit: number;
} {
  if (bet.status === 'won') return { phase: 'won', profit: bet.payout - bet.amount };
  if (bet.status === 'lost') return { phase: 'lost', profit: -bet.amount };
  if (bet.status === 'refunded') return { phase: 'refunded', profit: 0 };
  return { phase: Date.parse(bet.event.starts_at) > nowMs ? 'upcoming' : 'started', profit: 0 };
}

/** Lower-case, accents removed, so "atlético" matches "atletico". */
function searchable(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Does the match fit what the player typed? Every word must appear in a team
 * or league name, so "india aus" finds India vs Australia.
 */
export function matchesSearch(
  event: Pick<SportEvent, 'home_team' | 'away_team' | 'competition_name'>,
  query: string,
): boolean {
  const words = searchable(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = searchable(`${event.home_team} ${event.away_team} ${event.competition_name}`);
  return words.every((word) => haystack.includes(word));
}

/** Leagues in the list with how many matches each has, biggest first. */
export function competitionsOf(events: Pick<SportEvent, 'competition_name'>[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.competition_name, (counts.get(event.competition_name) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
