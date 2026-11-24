import { describe, expect, it } from 'vitest';
import { digitCounts, digitGaps, hotJodis, isDoubleJodi, weekStart, weeklyChart, type ResultRow } from './resultStats';

const row = (round_date: string, open: string | null, close: string | null): ResultRow => ({
  round_date,
  open_patti: null,
  open_digit: open,
  close_patti: null,
  close_digit: close,
  jodi: open && close ? open + close : null,
});

// Newest first, as get_result_history returns them.
const rows = [
  row('2026-11-24', '4', null), // Tuesday, close pending
  row('2026-11-23', '1', '2'), // Monday
  row('2026-11-21', '1', '2'), // Saturday
  row('2026-11-20', '9', '9'),
];

describe('resultStats', () => {
  it('counts open and close digits', () => {
    expect(digitCounts(rows, 'open')).toEqual([0, 2, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(digitCounts(rows, 'close')).toEqual([0, 0, 2, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('lists jodis seen more than once', () => {
    expect(hotJodis(rows)).toEqual([{ jodi: '12', count: 2 }]);
  });

  it('measures how many results ago each digit appeared', () => {
    const gaps = digitGaps(rows);
    expect(gaps[4]).toBe(0);
    expect(gaps[1]).toBe(1);
    expect(gaps[9]).toBe(3);
    expect(gaps[5]).toBeNull();
  });

  it('finds the Monday of a week', () => {
    expect(weekStart('2026-11-24')).toBe('2026-11-23');
    expect(weekStart('2026-11-23')).toBe('2026-11-23');
    expect(weekStart('2026-11-22')).toBe('2026-11-16'); // Sunday
  });

  it('lays results out by week, newest first', () => {
    const weeks = weeklyChart(rows);
    expect(weeks.map((week) => week.start)).toEqual(['2026-11-23', '2026-11-16']);
    expect(weeks[0].days[0]?.jodi).toBe('12');
    expect(weeks[0].days[1]?.open_digit).toBe('4');
    expect(weeks[0].days[2]).toBeNull();
    expect(weeks[1].days[5]?.jodi).toBe('12');
    expect(weeks[1].days[4]?.jodi).toBe('99');
  });

  it('spots double jodis', () => {
    expect(isDoubleJodi('99')).toBe(true);
    expect(isDoubleJodi('12')).toBe(false);
    expect(isDoubleJodi(null)).toBe(false);
  });
});
