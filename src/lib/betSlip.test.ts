import { describe, expect, it } from 'vitest';
import { calculateBetSlip, slipCommission } from '@/lib/betSlip';

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

describe('slip commission', () => {
  it('gives 5 for every full 100 paid on the slip', () => {
    expect(slipCommission(99, 5)).toBe(0);
    expect(slipCommission(100, 5)).toBe(5);
    expect(slipCommission(150, 5)).toBe(5);
    expect(slipCommission(199, 5)).toBe(5);
    expect(slipCommission(200, 5)).toBe(10);
    expect(slipCommission(1050, 5)).toBe(50);
  });

  it('is zero when commission is switched off or the slip is empty', () => {
    expect(slipCommission(500, 0)).toBe(0);
    expect(slipCommission(0, 5)).toBe(0);
    expect(slipCommission(Number.NaN, 5)).toBe(0);
  });
});
