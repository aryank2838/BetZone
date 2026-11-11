import { describe, expect, it } from 'vitest';
import { correctedClockNow, countdownTone, formatBetWindow, formatCountdown, serverClockOffset } from '@/lib/countdown';

const now = Date.parse('2026-11-09T12:00:00.000Z');

describe('game cutoff countdown', () => {
  it('formats the remaining time', () => {
    expect(formatCountdown(new Date(now + 65_000).toISOString(), now)).toBe('1:05');
    expect(formatCountdown(new Date(now + 3_661_000).toISOString(), now)).toBe('1:01:01');
    expect(formatCountdown(new Date(now - 1).toISOString(), now)).toBe('0:00');
  });

  it('uses the requested cutoff color thresholds', () => {
    expect(countdownTone(new Date(now + 10 * 60_000).toISOString(), now)).toBe('normal');
    expect(countdownTone(new Date(now + 9 * 60_000).toISOString(), now)).toBe('amber');
    expect(countdownTone(new Date(now + 119_000).toISOString(), now)).toBe('red');
    expect(countdownTone(new Date(now).toISOString(), now)).toBe('closed');
    expect(countdownTone('invalid', now)).toBe('closed');
    expect(formatCountdown('invalid', now)).toBe('--:--');
  });

  it('uses the server clock offset despite a wrong device clock', () => {
    const clientFetchTime = Date.parse('2026-11-09T11:00:00.000Z');
    const serverNow = '2026-11-09T12:00:00.000Z';
    const offset = serverClockOffset(serverNow, clientFetchTime);
    const actualDeviceTimeLater = clientFetchTime + 30_000;
    const correctedNow = correctedClockNow(actualDeviceTimeLater, offset);
    expect(correctedNow).toBe(Date.parse(serverNow) + 30_000);
    expect(countdownTone(new Date(Date.parse(serverNow) + 9 * 60_000).toISOString(), correctedNow)).toBe('amber');
  });
});

describe('bet window label', () => {
  it('shows Closed with the next opening time even though the server already returns tomorrow\'s cutoff', () => {
    const tomorrowCutoff = new Date(now + 20 * 3_600_000).toISOString();
    expect(formatBetWindow(false, tomorrowCutoff, '08:00', now)).toBe('Closed · opens at 08:00 IST');
    expect(formatBetWindow(false, tomorrowCutoff, '08:00:00', now)).toBe('Closed · opens at 08:00 IST');
  });

  it('shows the countdown only while the window is open', () => {
    const cutoff = new Date(now + 3_725_000).toISOString();
    expect(formatBetWindow(true, cutoff, '08:00', now)).toBe('Open · closes in 1:02:05');
  });
});
