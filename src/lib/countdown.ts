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

export function formatBetWindow(isOpen: boolean, cutoff: string, opensAt: string, nowMs: number): string {
  if (!isOpen) return `Closed · opens at ${opensAt.slice(0, 5)} IST`;
  return `Open · closes in ${formatCountdown(cutoff, nowMs)}`;
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
