export interface BetSlipPick {
  number: string;
  points: number;
}

export interface BetSlipTotals {
  pickCount: number;
  totalCost: number;
  potentialWins: number[];
  playAfterBet: number;
  walletAfterBet: number;
}

export function calculateBetSlip(
  picks: BetSlipPick[],
  pointsBalance: number,
  walletBalance: number,
  multiplier: number,
): BetSlipTotals {
  const totalCost = picks.reduce((sum, pick) => sum + (Number(pick.points) || 0), 0);
  return {
    pickCount: picks.length,
    totalCost,
    potentialWins: picks.map((pick) => pick.points * multiplier),
    playAfterBet: Math.max(0, pointsBalance - totalCost),
    walletAfterBet: Math.max(0, walletBalance - Math.max(0, totalCost - pointsBalance)),
  };
}

/**
 * Free stake a slip earns: `per100` for every full ₹100 paid on it
 * (₹99 → 0, ₹100 → 5, ₹150 → 5, ₹200 → 10). The server does the same sum
 * in submit_selection; this copy is only for showing it on the slip.
 */
export function slipCommission(paidTotal: number, per100: number): number {
  if (!Number.isFinite(paidTotal) || paidTotal <= 0 || per100 <= 0) return 0;
  return Math.floor(paidTotal / 100) * per100;
}
