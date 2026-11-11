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
