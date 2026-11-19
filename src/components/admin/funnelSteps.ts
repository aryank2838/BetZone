// Admin sign-up funnel: steps and the small sums the card shows.

export interface FunnelData {
  days: number | null;
  signed_up: number;
  requested_deposit: number;
  deposit_approved: number;
  placed_bet: number;
  verified_email: number;
  requested_withdrawal: number;
}

type FunnelKey = Exclude<keyof FunnelData, 'days'>;

/** In the order players usually go through them. */
export const FUNNEL_STEPS: Array<{ key: FunnelKey; label: string }> = [
  { key: 'signed_up', label: 'Signed up' },
  { key: 'requested_deposit', label: 'Asked to add money' },
  { key: 'deposit_approved', label: 'Money approved' },
  { key: 'placed_bet', label: 'Placed a bet' },
  { key: 'verified_email', label: 'Verified email' },
  { key: 'requested_withdrawal', label: 'Asked to withdraw' },
];

/** Share of sign-ups, 0-100, rounded. */
export function shareOf(count: number, signedUp: number) {
  return signedUp > 0 ? Math.round((count / signedUp) * 100) : 0;
}

/** The step (after sign-up) that loses the most players compared with the one before. */
export function biggestDrop(data: FunnelData): FunnelKey | null {
  let worst: FunnelKey | null = null;
  let worstLoss = 0;
  for (let i = 1; i < FUNNEL_STEPS.length; i += 1) {
    const loss = data[FUNNEL_STEPS[i - 1].key] - data[FUNNEL_STEPS[i].key];
    if (loss > worstLoss) {
      worstLoss = loss;
      worst = FUNNEL_STEPS[i].key;
    }
  }
  return worst;
}
