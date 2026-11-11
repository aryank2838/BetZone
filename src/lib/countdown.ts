import { interpolate, translate, type Language } from '@/i18n/context';

/** "08:00" or "20:30:00" (IST wall-clock time from the schedule) -> "8:00 AM" / "8:30 PM". */
export function formatClockTime(time: string): string {
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return time;
  const hours = Number(match[1]);
  if (hours > 23) return time;
  const suffix = hours < 12 ? 'AM' : 'PM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

export function formatCountdown(cutoff: string, nowMs: number): string {
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(nowMs)) return '--:--';
  const remainingSeconds = Math.max(0, Math.ceil((cutoffMs - nowMs) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Language defaults to the stored choice, read at call (render) time. */
export function formatBetWindow(isOpen: boolean, cutoff: string, opensAt: string, nowMs: number, language?: Language): string {
  if (!isOpen) return interpolate(translate('countdown.closed', language), { time: formatClockTime(opensAt) });
  return interpolate(translate('countdown.open', language), { time: formatCountdown(cutoff, nowMs) });
}

export function countdownTone(cutoff: string, nowMs: number): 'normal' | 'amber' | 'red' | 'closed' {
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(nowMs)) return 'closed';
  const remainingMs = cutoffMs - nowMs;
  if (remainingMs <= 0) return 'closed';
  if (remainingMs < 2 * 60_000) return 'red';
  if (remainingMs < 10 * 60_000) return 'amber';
  return 'normal';
}

export function serverClockOffset(serverNow: string, clientNow: number): number {
  const serverMs = Date.parse(serverNow);
  return Number.isFinite(serverMs) && Number.isFinite(clientNow) ? serverMs - clientNow : 0;
}

export function correctedClockNow(clientNow: number, offsetMs: number): number {
  return clientNow + offsetMs;
}
