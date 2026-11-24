/** One row of get_result_history(), newest first. */
export interface ResultRow {
  round_date: string;
  open_patti: string | null;
  open_digit: string | null;
  close_patti: string | null;
  close_digit: string | null;
  jodi: string | null;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** How many times each digit 0-9 came up as the open (or close) digit. */
export function digitCounts(rows: ResultRow[], side: 'open' | 'close'): number[] {
  const counts = DIGITS.map(() => 0);
  for (const row of rows) {
    const digit = side === 'open' ? row.open_digit : row.close_digit;
    if (digit && /^[0-9]$/.test(digit)) counts[Number(digit)] += 1;
  }
  return counts;
}

/** Jodis that came up most often, most frequent first (ties: most recent first). */
export function hotJodis(rows: ResultRow[], limit = 5): { jodi: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.jodi) counts.set(row.jodi, (counts.get(row.jodi) ?? 0) + 1);
  }
  // Map keeps first-insertion order, and rows are newest first, so sort is stable on recency.
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([jodi, count]) => ({ jodi, count }));
}

/**
 * For each digit 0-9: how many results ago it last came up as an open or close digit
 * (0 = in the latest result), or null if not seen in these rows.
 */
export function digitGaps(rows: ResultRow[]): (number | null)[] {
  const declared = rows.filter((row) => row.open_digit || row.close_digit);
  return DIGITS.map((digit) => {
    const index = declared.findIndex((row) => row.open_digit === digit || row.close_digit === digit);
    return index === -1 ? null : index;
  });
}

/** Monday of the ISO week holding a YYYY-MM-DD date, as YYYY-MM-DD. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - weekday);
  return day.toISOString().slice(0, 10);
}

export interface ChartWeek {
  /** Monday of the week, YYYY-MM-DD. */
  start: string;
  /** Monday to Sunday; null when there is no result that day. */
  days: (ResultRow | null)[];
}

/** Results laid out as a weekly jodi chart, newest week first. */
export function weeklyChart(rows: ResultRow[]): ChartWeek[] {
  const weeks = new Map<string, ChartWeek>();
  for (const row of rows) {
    const start = weekStart(row.round_date);
    let week = weeks.get(start);
    if (!week) {
      week = { start, days: [null, null, null, null, null, null, null] };
      weeks.set(start, week);
    }
    const weekday = (new Date(`${row.round_date}T00:00:00Z`).getUTCDay() + 6) % 7;
    week.days[weekday] = row;
  }
  return [...weeks.values()].sort((a, b) => b.start.localeCompare(a.start));
}

/** Doubles (00, 11 … 99) are marked in charts, as players look for them. */
export const isDoubleJodi = (jodi: string | null) => !!jodi && jodi.length === 2 && jodi[0] === jodi[1];
