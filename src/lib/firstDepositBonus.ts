/** Smallest first deposit that earns the bonus. */
export const FIRST_DEPOSIT_BONUS_MIN_DEPOSIT = 50;

/**
 * Mirrors public.first_deposit_bonus_amount: 5% of the deposit, at least
 * 10 points, no cap. Deposits under 50 get nothing.
 */
export function firstDepositBonus(amount: number) {
  if (amount < FIRST_DEPOSIT_BONUS_MIN_DEPOSIT) return 0;
  return Math.max(10, Math.floor((amount * 5) / 100));
}
