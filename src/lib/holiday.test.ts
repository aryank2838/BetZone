import { describe, expect, it } from 'vitest';
import { isClosedOn, isoWeekday, weekdayNames } from '@/lib/holiday';

describe('weekly days off', () => {
  it('numbers weekdays Monday = 1 to Sunday = 7', () => {
    expect(isoWeekday('2026-11-16')).toBe(1); // Monday
    expect(isoWeekday('2026-11-14')).toBe(6); // Saturday
    expect(isoWeekday('2026-11-15')).toBe(7); // Sunday
  });

  it('checks a date against the days off', () => {
    expect(isClosedOn('2026-11-15', [7])).toBe(true);
    expect(isClosedOn('2026-11-14', [7])).toBe(false);
    expect(isClosedOn('2026-11-14', [6, 7])).toBe(true);
    expect(isClosedOn('2026-11-14', undefined)).toBe(false);
  });

  it('names the days in order', () => {
    expect(weekdayNames([7, 6], 'en-IN')).toBe('Saturday, Sunday');
  });
});
