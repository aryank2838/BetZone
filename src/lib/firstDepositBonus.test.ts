import { describe, expect, it } from 'vitest';
import { firstDepositBonus } from './firstDepositBonus';

describe('firstDepositBonus', () => {
  it('gives nothing for deposits under 50', () => {
    expect(firstDepositBonus(1)).toBe(0);
    expect(firstDepositBonus(49)).toBe(0);
  });

  it('gives at least 10 points from 50', () => {
    expect(firstDepositBonus(50)).toBe(10);
    expect(firstDepositBonus(219)).toBe(10);
  });

  it('gives 5% rounded down above the minimum, with no cap', () => {
    expect(firstDepositBonus(220)).toBe(11);
    expect(firstDepositBonus(1000)).toBe(50);
    expect(firstDepositBonus(100000)).toBe(5000);
  });
});
