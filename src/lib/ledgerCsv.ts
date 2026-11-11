import { buildCsv } from '@/lib/csv';

export interface LedgerCsvEntry {
  delta: number;
  reason: string;
  metadata: unknown;
  created_at: string;
}

const REASON_LABELS: Record<string, string> = {
  signup_bonus: 'Signup bonus',
  selection_submit: 'Game entry',
  winning_payout: 'Winnings',
  payout: 'Winnings',
  withdrawal_request: 'Withdrawal',
  withdrawal_refund: 'Withdrawal refund',
  add_funds: 'Added funds',
  admin_adjust_points: 'Admin adjustment',
  admin_adjust_wallet: 'Admin adjustment',
};

function istIsoDate(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}+05:30`;
}

function metadataFields(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { game: '', betType: '', roundDate: '' };
  }
  const record = metadata as Record<string, unknown>;
  const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return {
    game: text(record.game),
    betType: text(record.bet_type),
    roundDate: text(record.round_date),
  };
}

export function buildLedgerCsv(entries: LedgerCsvEntry[]) {
  const rows = [
    ['date (IST, ISO)', 'type', 'delta', 'game', 'bet type', 'round date'],
    ...entries.map((entry) => {
      const metadata = metadataFields(entry.metadata);
      return [
        istIsoDate(entry.created_at),
        REASON_LABELS[entry.reason] ?? 'Other transaction',
        entry.delta,
        metadata.game,
        metadata.betType,
        metadata.roundDate,
      ];
    }),
  ];
  return buildCsv(rows);
}
