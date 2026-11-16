import { describe, expect, it } from 'vitest';
import { estimatePayout, isBettable, subjectTeam, yesShare } from './sportsPool';

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
  it('yesShare is 50 for an empty pool and rounds otherwise', () => {
    expect(yesShare(0, 0)).toBe(50);
    expect(yesShare(700, 300)).toBe(70);
    expect(yesShare(1, 2)).toBe(33);
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
