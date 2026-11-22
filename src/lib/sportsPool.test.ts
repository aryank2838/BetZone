import { describe, expect, it } from 'vitest';
import { competitionsOf, estimatePayout, matchesSearch, questionText, resultText, sideName, sidesOf, sportBetOutcome, isBettable, playerMoney, poolForEstimate, popularIds, sortMatches, poolShares, subjectTeam, thinSide, type SportEvent } from './sportsPool';

describe('house money', () => {
  it('counts the coming house money on a match that has not had it yet', () => {
    expect(poolForEstimate({ yes_total: 0, no_total: 0, house_seeded: false }, 50))
      .toEqual({ yesTotal: 50, noTotal: 50, drawTotal: 0 });
    // Already in the totals: not added twice.
    expect(poolForEstimate({ yes_total: 550, no_total: 50, house_seeded: true }, 50))
      .toEqual({ yesTotal: 550, noTotal: 50, drawTotal: 0 });
    // Budget used up today.
    expect(poolForEstimate({ yes_total: 200, no_total: 0, house_seeded: false }, 0))
      .toEqual({ yesTotal: 200, noTotal: 0, drawTotal: 0 });
  });

  it('a first bet with house money pays instead of refunding', () => {
    // Pool after the seed: Yes 50, No 50. 100 on Yes: 100 + floor(45 * 100 / 150) = 130.
    const pool = poolForEstimate({ yes_total: 0, no_total: 0, house_seeded: false }, 50);
    expect(estimatePayout({ stake: 100, side: 'yes', ...pool, feePercent: 10 }))
      .toEqual({ payout: 130, refund: false });
  });

  it('thinSide finds a side with under a quarter of the pool', () => {
    expect(thinSide(0, 0)).toBeNull();
    expect(thinSide(500, 500)).toBeNull();
    expect(thinSide(550, 50)).toBe('no');
    expect(thinSide(20, 1000)).toBe('yes');
    expect(thinSide(75, 225)).toBeNull(); // exactly a quarter is not thin
  });

  it('thinSide on a three-way pool looks for under a sixth', () => {
    expect(thinSide(400, 400, 100)).toBe('draw');
    expect(thinSide(300, 300, 300)).toBeNull();
    expect(thinSide(500, 50, 50)).toBe('no'); // both thin: the first of the emptiest
    expect(thinSide(100, 500, 0)).toBe('draw');
  });

  it('seeds the Draw pool only on a Draw match', () => {
    expect(poolForEstimate({ yes_total: 0, no_total: 0, draw_total: 0, has_draw: true, house_seeded: false }, 50))
      .toEqual({ yesTotal: 50, noTotal: 50, drawTotal: 50 });
    expect(poolForEstimate({ yes_total: 0, no_total: 0, has_draw: false, house_seeded: false }, 50).drawTotal).toBe(0);
  });
});

describe('team names on a Draw match', () => {
  const t = (key: string) => ({
    'sports.yes': 'Yes', 'sports.no': 'No', 'sports.draw': 'Draw',
    'sports.question': 'Will {team} win?', 'sports.questionWho': 'Who will win?',
    'sports.resultTeam': 'Result: {team} won', 'sports.resultDraw': 'Result: Draw',
    'sports.resultYes': 'Result: Yes, {team} won', 'sports.resultNo': 'Result: No, {team} did not win',
  } as Record<string, string>)[key] ?? key;
  const teams = { home_team: 'Leeds', away_team: 'Burnley' };

  it('orders home, Draw, away and names the sides after the teams', () => {
    const home = { ...teams, subject_side: 'home' as const, has_draw: true };
    const away = { ...teams, subject_side: 'away' as const, has_draw: true };
    expect(sidesOf(home).map((s) => sideName(home, s, t))).toEqual(['Leeds', 'Draw', 'Burnley']);
    expect(sidesOf(away).map((s) => sideName(away, s, t))).toEqual(['Leeds', 'Draw', 'Burnley']);
    expect(questionText(home, t)).toBe('Who will win?');
    expect(resultText({ ...away, outcome: 'yes' }, t)).toBe('Result: Burnley won');
    expect(resultText({ ...away, outcome: 'draw' }, t)).toBe('Result: Draw');
  });

  it('keeps Yes / No on a match without a Draw pool', () => {
    const plain = { ...teams, subject_side: 'home' as const, has_draw: false };
    expect(sidesOf(plain).map((s) => sideName(plain, s, t))).toEqual(['Yes', 'No']);
    expect(questionText(plain, t)).toBe('Will Leeds win?');
    expect(resultText({ ...plain, outcome: 'no' }, t)).toBe('Result: No, Leeds did not win');
  });
});

describe('estimatePayout with a Draw pool', () => {
  it('a Draw bet wins both other pools, minus the fee', () => {
    // Same numbers as the SQL test: Yes 100, No 100, Draw 0 + 100 -> 100 + 180.
    expect(estimatePayout({ stake: 100, side: 'draw', yesTotal: 100, noTotal: 100, drawTotal: 0, feePercent: 10 }))
      .toEqual({ payout: 280, refund: false });
  });

  it('a Yes bet also wins the Draw pool', () => {
    // Yes 100 + 100 = 200, losing 200 + 100 = 300, fee 30: 100 + floor(270 * 100 / 200) = 235.
    expect(estimatePayout({ stake: 100, side: 'yes', yesTotal: 100, noTotal: 200, drawTotal: 100, feePercent: 10 }).payout)
      .toBe(235);
  });
});

describe('estimatePayout', () => {
  it('matches the 70/30 example with a 10% fee', () => {
    // Pools before this bet: Yes 600, No 300. A new 100 on Yes makes Yes 700.
    expect(estimatePayout({ stake: 100, side: 'yes', yesTotal: 600, noTotal: 300, feePercent: 10 }))
      .toEqual({ payout: 138, refund: false });
    // Yes 700, No 200 + 100 = 300: No pays 100 + floor(630 * 100 / 300) = 310.
    expect(estimatePayout({ stake: 100, side: 'no', yesTotal: 700, noTotal: 200, feePercent: 10 }))
      .toEqual({ payout: 310, refund: false });
  });

  it('matches the database rounding (fee rounded down, share rounded down)', () => {
    // Same numbers as supabase/tests/sports_pools.sql: u1 300 of Yes 700 vs No 300 -> 415.
    expect(estimatePayout({ stake: 300, side: 'yes', yesTotal: 400, noTotal: 300, feePercent: 10 }).payout).toBe(415);
  });

  it('returns the stake as a refund when nobody is on the other side', () => {
    expect(estimatePayout({ stake: 50, side: 'yes', yesTotal: 500, noTotal: 0, feePercent: 10 }))
      .toEqual({ payout: 50, refund: true });
  });

  it('ignores empty or invalid stakes', () => {
    expect(estimatePayout({ stake: 0, side: 'yes', yesTotal: 1, noTotal: 1, feePercent: 10 }).payout).toBe(0);
    expect(estimatePayout({ stake: Number.NaN, side: 'no', yesTotal: 1, noTotal: 1, feePercent: 10 }).payout).toBe(0);
  });
});

describe('helpers', () => {
  it('poolShares splits evenly when empty and always adds up to 100', () => {
    const two = ['yes', 'no'] as const;
    const three = ['yes', 'draw', 'no'] as const;
    expect(poolShares({ yesTotal: 0, noTotal: 0, drawTotal: 0 }, [...two])).toMatchObject({ yes: 50, no: 50 });
    expect(poolShares({ yesTotal: 700, noTotal: 300, drawTotal: 0 }, [...two])).toMatchObject({ yes: 70, no: 30 });
    expect(poolShares({ yesTotal: 1, noTotal: 2, drawTotal: 0 }, [...two])).toMatchObject({ yes: 33, no: 67 });
    const empty3 = poolShares({ yesTotal: 0, noTotal: 0, drawTotal: 0 }, [...three]);
    expect(empty3.yes + empty3.draw + empty3.no).toBe(100);
    expect(poolShares({ yesTotal: 100, noTotal: 100, drawTotal: 100 }, [...three]))
      .toEqual({ yes: 34, draw: 33, no: 33 });
    expect(poolShares({ yesTotal: 500, noTotal: 300, drawTotal: 200 }, [...three]))
      .toEqual({ yes: 50, draw: 20, no: 30 });
  });

  it('subjectTeam follows subject_side', () => {
    expect(subjectTeam({ home_team: 'A', away_team: 'B', subject_side: 'home' })).toBe('A');
    expect(subjectTeam({ home_team: 'A', away_team: 'B', subject_side: 'away' })).toBe('B');
  });

  it('isBettable needs an open, scheduled match before kick-off', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    const event = { state: 'open' as const, provider_status: 'scheduled' as const, starts_at: '2026-11-20T12:00:00Z' };
    expect(isBettable(event, now)).toBe(true);
    expect(isBettable({ ...event, starts_at: '2026-11-20T09:00:00Z' }, now)).toBe(false);
    expect(isBettable({ ...event, state: 'closed' }, now)).toBe(false);
    expect(isBettable({ ...event, provider_status: 'live' }, now)).toBe(false);
  });
});

describe('match order', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const match = (id: string, over: Partial<SportEvent> = {}): SportEvent => ({
    id, sport: 'football', competition: 'PL', competition_name: 'Premier League',
    home_team: 'A', away_team: 'B', subject_side: 'home',
    starts_at: '2026-11-20T12:00:00Z', state: 'open', provider_status: 'scheduled',
    home_score: null, away_score: null, outcome: null, void_reason: null, fee_percent: 10,
    yes_total: 0, no_total: 0, house_yes: 0, house_no: 0, house_seeded: false, my_yes: 0, my_no: 0,
    ...over,
  });

  it('leaves house money out of player money', () => {
    expect(playerMoney(match('x', { yes_total: 150, no_total: 50, house_yes: 50, house_no: 50 }))).toBe(100);
  });

  it('puts my matches first, then the ones with the most player money', () => {
    const events = [
      match('soon-empty'),
      match('house-only', { yes_total: 50, no_total: 50, house_yes: 50, house_no: 50, house_seeded: true }),
      match('small', { yes_total: 100 }),
      match('mine-later', { starts_at: '2026-11-21T12:00:00Z', yes_total: 20, my_yes: 20 }),
      match('big', { yes_total: 300, no_total: 200 }),
      match('mine-soon', { starts_at: '2026-11-19T18:00:00Z', no_total: 10, my_no: 10 }),
      match('finished', { state: 'settled', provider_status: 'finished', starts_at: '2026-11-18T12:00:00Z', yes_total: 900, my_yes: 900 }),
    ];
    expect(sortMatches(events, now).map((e) => e.id))
      .toEqual(['mine-soon', 'mine-later', 'big', 'small', 'soon-empty', 'house-only', 'finished']);
  });

  it('marks the top three upcoming matches with ₹500+ of player money as popular', () => {
    const events = [
      match('a', { yes_total: 600 }),
      match('b', { yes_total: 900 }),
      match('c', { yes_total: 800 }),
      match('d', { yes_total: 700 }),
      match('house-only', { yes_total: 2000, house_yes: 2000 }),
      match('finished', { state: 'settled', provider_status: 'finished', starts_at: '2026-11-18T12:00:00Z', yes_total: 900 }),
    ];
    expect([...popularIds(events, now)].sort()).toEqual(['b', 'c', 'd']);
  });

  it('needs at least ₹500 of player money for the badge', () => {
    const events = [
      match('exactly-500', { yes_total: 300, no_total: 200 }),
      match('499', { yes_total: 499 }),
      // 600 in the pool, but 200 of it is house money.
      match('400-from-players', { yes_total: 400, no_total: 200, house_no: 200, house_seeded: true }),
    ];
    expect([...popularIds(events, now)]).toEqual(['exactly-500']);
  });
});

describe('sportBetOutcome', () => {
  const event = { starts_at: '2026-11-21T18:00:00Z' } as Parameters<typeof sportBetOutcome>[0]['event'];
  const now = Date.parse('2026-11-21T12:00:00Z');

  it('works out profit for settled bets', () => {
    expect(sportBetOutcome({ status: 'won', amount: 100, payout: 180, event }, now)).toEqual({ phase: 'won', profit: 80 });
    expect(sportBetOutcome({ status: 'lost', amount: 100, payout: 0, event }, now)).toEqual({ phase: 'lost', profit: -100 });
    expect(sportBetOutcome({ status: 'refunded', amount: 100, payout: 100, event }, now)).toEqual({ phase: 'refunded', profit: 0 });
  });

  it('tells upcoming matches from ones already under way', () => {
    expect(sportBetOutcome({ status: 'open', amount: 100, payout: 0, event }, now).phase).toBe('upcoming');
    expect(sportBetOutcome({ status: 'open', amount: 100, payout: 0, event }, Date.parse('2026-11-21T19:00:00Z')).phase).toBe('started');
  });
});

describe('match search', () => {
  const match = { home_team: 'Atlético Madrid', away_team: 'Real Madrid', competition_name: 'La Liga' };

  it('matches team and league names, ignoring case and accents', () => {
    expect(matchesSearch(match, 'atletico')).toBe(true);
    expect(matchesSearch(match, 'REAL')).toBe(true);
    expect(matchesSearch(match, 'liga')).toBe(true);
    expect(matchesSearch(match, '   ')).toBe(true);
    expect(matchesSearch(match, 'barcelona')).toBe(false);
  });

  it('needs every word to match somewhere', () => {
    expect(matchesSearch({ home_team: 'India', away_team: 'Australia', competition_name: 'ODI' }, 'india aus')).toBe(true);
    expect(matchesSearch({ home_team: 'India', away_team: 'England', competition_name: 'ODI' }, 'india aus')).toBe(false);
  });

  it('lists leagues by how many matches they have', () => {
    expect(competitionsOf([
      { competition_name: 'La Liga' }, { competition_name: 'Premier League' }, { competition_name: 'Premier League' },
    ])).toEqual([{ name: 'Premier League', count: 2 }, { name: 'La Liga', count: 1 }]);
  });
});
