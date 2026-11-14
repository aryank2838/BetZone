import { describe, expect, it } from 'vitest';
import { gamePhase, homeOrder, istClock } from '@/lib/gameState';
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

  it('is later before betting opens today, and closed after betting ends', () => {
    // NOW is 11:30 IST.
    const shut = { open_bets_open: false, close_bets_open: false };
    expect(gamePhase(status({ ...shut, bets_open_at: '12:00' }), NOW)).toBe('later');
    expect(gamePhase(status({ ...shut, bets_open_at: '08:00' }), NOW)).toBe('closed');
  });

  it('is dayOff on a weekly day off, and holiday wins over it', () => {
    const sunday = { day_off: true, day_off_reopens_on: '2026-11-16', open_bets_open: false, close_bets_open: false };
    expect(gamePhase(status(sunday), NOW)).toBe('dayOff');
    expect(gamePhase(status({ ...sunday, on_holiday: true, holiday_reopens_on: '2026-11-20' }), NOW)).toBe('holiday');
  });
});

describe('istClock', () => {
  it('gives IST wall-clock time', () => {
    expect(istClock(NOW)).toBe('11:30');
    expect(istClock(Date.parse('2026-11-13T18:40:00Z'))).toBe('00:10');
  });
});

describe('homeOrder', () => {
  it('puts closing games first, then open by soonest cutoff, then later, then closed and days off', () => {
    const shut = { open_bets_open: false, close_bets_open: false };
    const order = homeOrder([
      status({ game: 'test', ...shut, bets_open_at: '08:00' }),                          // closed for today
      status({ game: 'test2', open_bets_close_ts: inMinutes(300) }),                    // open, far cutoff
      status({ game: 'test3', ...shut, bets_open_at: '21:00' }),                         // opens later
      status({ game: 'test4', open_bets_close_ts: inMinutes(60) }),                     // open, nearer cutoff
      status({ game: 'test5' as never, open_bets_open: false, close_bets_close_ts: inMinutes(5) }), // closing
      status({ game: 'test6' as never, ...shut, day_off: true, day_off_reopens_on: '2026-11-16' }),
    ], NOW);
    expect(order.map((item) => item.status.game)).toEqual(['test5', 'test4', 'test2', 'test3', 'test', 'test6']);
    expect(order.map((item) => item.group)).toEqual(['open', 'open', 'open', 'later', 'closed', 'closed']);
  });
});
