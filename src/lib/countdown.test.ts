import { describe, expect, it } from 'vitest';
import { correctedClockNow, countdownTone, formatBetWindow, formatClockTime, formatCountdown, serverClockOffset } from '@/lib/countdown';

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
    expect(formatBetWindow(false, tomorrowCutoff, '08:00', now)).toBe('Opens at 8:00 AM IST');
    expect(formatBetWindow(false, tomorrowCutoff, '08:00:00', now)).toBe('Opens at 8:00 AM IST');
    expect(formatBetWindow(false, tomorrowCutoff, '20:30:00', now)).toBe('Opens at 8:30 PM IST');
  });

  it('shows the countdown only while the window is open', () => {
    const cutoff = new Date(now + 3_725_000).toISOString();
    expect(formatBetWindow(true, cutoff, '08:00', now)).toBe('Open now · closes in 1:02:05');
  });

  it('uses the translated labels for Hindi and Marathi', () => {
    const cutoff = new Date(now + 65_000).toISOString();
    expect(formatBetWindow(true, cutoff, '08:00', now, 'hi')).toBe('अभी खुला · 1:05 में बंद होगा');
    expect(formatBetWindow(false, cutoff, '08:00:00', now, 'hi')).toBe('8:00 AM IST पर खुलेगा');
    expect(formatBetWindow(true, cutoff, '08:00', now, 'mr')).toBe('आता सुरू · 1:05 मध्ये बंद होईल');
    expect(formatBetWindow(false, cutoff, '08:00', now, 'mr')).toBe('8:00 AM IST ला सुरू होईल');
    expect(formatBetWindow(true, cutoff, '08:00', now, 'en')).toBe('Open now · closes in 1:05');
  });

  it('follows the stored language when none is passed', () => {
    const cutoff = new Date(now + 65_000).toISOString();
    localStorage.setItem('betzone_language', 'hi');
    try {
      expect(formatBetWindow(true, cutoff, '08:00', now)).toBe('अभी खुला · 1:05 में बंद होगा');
    } finally {
      localStorage.removeItem('betzone_language');
    }
  });
});

describe('schedule clock times', () => {
  it('shows IST schedule times in 12-hour format with AM/PM', () => {
    expect(formatClockTime('08:00')).toBe('8:00 AM');
    expect(formatClockTime('00:15:00')).toBe('12:15 AM');
    expect(formatClockTime('12:00:00')).toBe('12:00 PM');
    expect(formatClockTime('23:59:59')).toBe('11:59 PM');
    expect(formatClockTime('not a time')).toBe('not a time');
  });
});
