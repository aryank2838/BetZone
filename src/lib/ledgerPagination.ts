export interface LedgerCursor {
  created_at: string;
  id: string;
}

export function ledgerCursorFilter(cursor: LedgerCursor) {
  return `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`;
}

export async function collectCursorPages<T extends LedgerCursor>(
  fetchPage: (cursor: LedgerCursor | null, pageSize: number) => Promise<T[]>,
  pageSize: number,
): Promise<T[]> {
  const entries: T[] = [];
  let cursor: LedgerCursor | null = null;
  while (true) {
    const page = await fetchPage(cursor, pageSize);
    entries.push(...page);
    if (page.length < pageSize) return entries;
    const lastEntry = page[page.length - 1];
    cursor = { created_at: lastEntry.created_at, id: lastEntry.id };
  }
}
