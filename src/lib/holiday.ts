import type { GameStatus } from '@/types';

/** Formats a YYYY-MM-DD date as e.g. "20 Nov 2026" without timezone drift. */
export function formatHolidayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function isOnHoliday(status: GameStatus | null | undefined): boolean {
  return Boolean(status?.on_holiday && status.holiday_reopens_on);
}

/** Today is one of the game's weekly days off (e.g. Sunday). */
export function isDayOff(status: GameStatus | null | undefined): boolean {
  return Boolean(status?.day_off && status.day_off_reopens_on);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

/** True when the date falls on one of the given weekly days off. */
export function isClosedOn(isoDate: string, closedWeekdays: number[] | undefined): boolean {
  return !!closedWeekdays?.length && closedWeekdays.includes(isoWeekday(isoDate));
}

/** Weekday names for ISO weekdays, e.g. [6, 7] -> "Saturday, Sunday". */
export function weekdayNames(days: number[], locale: string): string {
  // 2026-11-16 is a Monday, so Monday + (day - 1) gives each weekday.
  return [...days].sort((a, b) => a - b)
    .map((day) => new Date(Date.UTC(2026, 10, 15 + day)).toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' }))
    .join(', ');
}

export function holidayMessage(status: GameStatus): string {
  const reopens = status.holiday_reopens_on ? formatHolidayDate(status.holiday_reopens_on) : '';
  return `Holiday — no betting or results. Games restart on ${reopens}.`;
}
