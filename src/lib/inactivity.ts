export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const INACTIVITY_WARNING_MS = 60 * 1000;
export const ACTIVITY_STORAGE_KEY = 'betzone_last_activity';
export const ACTIVITY_THROTTLE_MS = 1000;

export function parseActivityTimestamp(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function inactivityRemaining(lastActivityAt: number, now: number): number {
  return Math.max(0, INACTIVITY_TIMEOUT_MS - Math.max(0, now - lastActivityAt));
}
