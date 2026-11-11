import { describe, expect, it } from 'vitest';
import { calculateBetSlip } from '@/lib/betSlip';

describe('bet slip totals', () => {
  it('sums picks, computes each potential win, and spends points before wallet', () => {
    expect(calculateBetSlip([
      { number: '00', points: 50 },
      { number: '01', points: 40 },
    ], 60, 100, 90)).toEqual({
      pickCount: 2,
      totalCost: 90,
      potentialWins: [4500, 3600],
      playAfterBet: 0,
      walletAfterBet: 70,
    });
  });

  it('uses points first when the points balance covers all picks', () => {
    expect(calculateBetSlip([{ number: '6', points: 10 }], 30, 80, 9)).toMatchObject({
      totalCost: 10,
      playAfterBet: 20,
      walletAfterBet: 80,
    });
  });
});
