import { describe, expect, it } from 'vitest';
import { buildLedgerCsv } from '@/lib/ledgerCsv';
import { collectCursorPages, ledgerCursorFilter, type LedgerCursor } from '@/lib/ledgerPagination';

interface TestLedgerEntry extends LedgerCursor {
  delta: number;
  reason: string;
  metadata: { game: string };
}

describe('ledger keyset pagination', () => {
  it('returns all tied-timestamp entries exactly once across pages and in the CSV', async () => {
    const timestamp = '2026-11-10T12:00:00.000Z';
    const rows: TestLedgerEntry[] = Array.from({ length: 120 }, (_, index) => ({
      id: `row-${String(index + 1).padStart(3, '0')}`,
      created_at: timestamp,
      delta: index + 1,
      reason: 'selection_submit',
      metadata: { game: `entry-${index + 1}` },
    })).sort((left, right) => right.id.localeCompare(left.id));
    const pageSizes: number[] = [];

    const result = await collectCursorPages(async (cursor, pageSize) => {
      pageSizes.push(pageSize);
      const afterCursor = cursor
        ? rows.filter((entry) => entry.created_at < cursor.created_at
          || (entry.created_at === cursor.created_at && entry.id < cursor.id))
        : rows;
      return afterCursor.slice(0, pageSize);
    }, 50);

    expect(pageSizes).toEqual([50, 50, 50]);
    expect(result).toHaveLength(120);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(120);

    const csv = buildLedgerCsv(result.map(({ delta, reason, metadata, created_at }) => ({
      delta,
      reason,
      metadata,
      created_at,
    })));
    expect(csv.split('\r\n')).toHaveLength(121);
    for (const entry of result) expect(csv).toContain(`"${entry.metadata.game}"`);
  });

  it('builds a composite cursor filter for equal timestamps', () => {
    expect(ledgerCursorFilter({ created_at: '2026-11-10T12:00:00.000Z', id: 'row-050' }))
      .toBe('created_at.lt.2026-11-10T12:00:00.000Z,and(created_at.eq.2026-11-10T12:00:00.000Z,id.lt.row-050)');
  });
});
