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

export function holidayMessage(status: GameStatus): string {
  const reopens = status.holiday_reopens_on ? formatHolidayDate(status.holiday_reopens_on) : '';
  return `Holiday — no betting or results. Games restart on ${reopens}.`;
}
