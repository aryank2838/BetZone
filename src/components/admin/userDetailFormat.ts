/** Ledger metadata keys shown to admins; anything else (UPI IDs, internal ids) is omitted. */
const LEDGER_METADATA_LABELS: Array<[key: string, label: string]> = [
  ['game', 'Game'],
  ['bet_type', 'Bet type'],
  ['round_date', 'Round'],
  ['number', 'Number'],
  ['target', 'Balance'],
];

export const LEDGER_REASON_LABELS: Record<string, string> = {
  signup_bonus: 'Signup bonus',
  selection_submit: 'Bet placed',
  winning_payout: 'Winnings',
  payout: 'Winnings',
  withdrawal_request: 'Withdrawal requested',
  withdrawal_refund: 'Withdrawal refunded',
  add_funds: 'Deposit credited',
  admin_adjust_points: 'Admin adjustment (play)',
  admin_adjust_wallet: 'Admin adjustment (wallet)',
};

/** Human-readable, allowlisted summary of a ledger row's metadata. */
export function ledgerMetadataSummary(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const record = metadata as Record<string, unknown>;
  return LEDGER_METADATA_LABELS
    .filter(([key]) => typeof record[key] === 'string' || typeof record[key] === 'number')
    .map(([key, label]) => `${label}: ${String(record[key])}`)
    .join(' · ');
}

/** "7×10, 12×50" from a selections array. */
export function picksSummary(selections: unknown): string {
  if (!Array.isArray(selections)) return '';
  return selections
    .filter((item): item is { number: unknown; points: unknown } => !!item && typeof item === 'object')
    .map((item) => `${String(item.number)}×${String(item.points)}`)
    .join(', ');
}
