import { describe, expect, it } from 'vitest';
import { gamePhase } from '@/lib/gameState';
import type { GameStatus } from '@/types';

const NOW = Date.parse('2026-11-13T06:00:00Z');
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function status(overrides: Partial<GameStatus> = {}): GameStatus {
  return {
    game: 'test', label: 'Kalyan', round_date: '2026-11-13',
    open_bets_open: true, close_bets_open: true,
    bets_open_at: '08:00', open_bets_close_at: '15:00', close_bets_close_at: '17:00',
    server_now: new Date(NOW).toISOString(),
    open_bets_close_ts: inMinutes(60), close_bets_close_ts: inMinutes(120),
    open_result_at: '15:30', close_result_at: '17:30',
    server_ist_date: '2026-11-13', server_ist_time: '11:30:00', close_result_next_day: false,
    ...overrides,
  };
}

describe('gamePhase', () => {
  it('is open when a window has more than 10 minutes left', () => {
    expect(gamePhase(status(), NOW)).toBe('open');
  });

  it('stays open when one window is closing but the other has time', () => {
    expect(gamePhase(status({ open_bets_close_ts: inMinutes(5) }), NOW)).toBe('open');
  });

  it('is closing when the only open window ends within 10 minutes', () => {
    expect(gamePhase(status({ open_bets_open: false, close_bets_close_ts: inMinutes(5) }), NOW)).toBe('closing');
  });

  it('is closed when no window is open or cutoffs have passed', () => {
    expect(gamePhase(status({ open_bets_open: false, close_bets_open: false }), NOW)).toBe('closed');
    expect(gamePhase(status({ open_bets_close_ts: inMinutes(-1), close_bets_close_ts: inMinutes(-1) }), NOW)).toBe('closed');
  });

  it('is holiday when the game is on holiday', () => {
    expect(gamePhase(status({ on_holiday: true, holiday_reopens_on: '2026-11-20' }), NOW)).toBe('holiday');
  });

  it('is dayOff on a weekly day off, and holiday wins over it', () => {
    const sunday = { day_off: true, day_off_reopens_on: '2026-11-16', open_bets_open: false, close_bets_open: false };
    expect(gamePhase(status(sunday), NOW)).toBe('dayOff');
    expect(gamePhase(status({ ...sunday, on_holiday: true, holiday_reopens_on: '2026-11-20' }), NOW)).toBe('holiday');
  });
});
