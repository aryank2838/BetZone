export interface RoundTotals {
  staked: number;
  won: number;
  pending_stake: number;
}

/** Stake that has been settled (won or lost) for a round. */
export function settledStake(round: RoundTotals): number {
  return round.staked - round.pending_stake;
}

/** Net for a round counts only settled stakes; pending stakes are not losses yet. */
export function roundNet(round: RoundTotals): number {
  return round.won - settledStake(round);
}
