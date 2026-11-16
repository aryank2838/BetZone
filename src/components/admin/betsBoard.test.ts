import { describe, expect, it } from 'vitest';
import type { GameStatus } from '@/types';
import { boardSummary, groupStatus, slipFilter, slipStatus, type BoardResult, type BoardSlip } from './betsBoard';

const slip = (id: string, user: string, picks: BoardSlip['picks'], betType: BoardSlip['bet_type'] = 'single_open'): BoardSlip => ({
  id, user_id: user, user_name: user, bet_type: betType, total_points: picks.reduce((s, p) => s + p.stake, 0),
  updated_at: '2026-11-17T08:00:00Z', picks,
});

const status = (over: Partial<GameStatus>): GameStatus => ({
  game: 'test', label: 'Kalyan', round_date: '2026-11-17',
  open_bets_open: false, close_bets_open: false,
  bets_open_at: '09:00:00', open_bets_close_at: '15:00:00', close_bets_close_at: '17:00:00',
  server_now: '', open_bets_close_ts: '', close_bets_close_ts: '',
  open_result_at: '15:15:00', close_result_at: '17:15:00',
  server_ist_date: '2026-11-17', server_ist_time: '14:00:00', close_result_next_day: false,
  ...over,
});

const result = (over: Partial<BoardResult>): BoardResult => ({
  open_patti: null, open_digit: null, close_patti: null, close_digit: null, open_paid: false, close_paid: false, ...over,
});

describe('groupStatus', () => {
  it('is live while that window is open today', () => {
    expect(groupStatus('single_open', null, status({ open_bets_open: true }), '2026-11-17')).toBe('live');
    expect(groupStatus('jodi', null, status({ open_bets_open: true }), '2026-11-17')).toBe('live');
    expect(groupStatus('single_close', null, status({ open_bets_open: true }), '2026-11-17')).toBe('waiting');
  });
  it('is waiting on other days and after the window closes', () => {
    expect(groupStatus('single_open', null, status({ open_bets_open: true }), '2026-11-16')).toBe('waiting');
    expect(groupStatus('single_open', null, status({}), '2026-11-17')).toBe('waiting');
  });
  it('is settled once that half is paid; jodi waits for the close result', () => {
    const openOnly = result({ open_digit: '1', open_paid: true });
    expect(groupStatus('single_open', openOnly, status({}), '2026-11-17')).toBe('settled');
    expect(groupStatus('patti_open', openOnly, status({}), '2026-11-17')).toBe('settled');
    expect(groupStatus('jodi', openOnly, status({}), '2026-11-17')).toBe('waiting');
    expect(groupStatus('jodi', result({ close_paid: true }), status({}), '2026-11-17')).toBe('settled');
  });
});

describe('slipStatus and slipFilter', () => {
  const won = slip('a', 'u1', [{ number: '1', stake: 10, status: 'won', payout: 90 }, { number: '2', stake: 10, status: 'lost', payout: 0 }]);
  const lost = slip('b', 'u2', [{ number: '3', stake: 20, status: 'lost', payout: 0 }]);
  const pending = slip('c', 'u1', [{ number: '4', stake: 50, status: 'pending', payout: 0 }]);
  it('marks a slip won if any number won', () => {
    expect(slipStatus(won)).toBe('won');
    expect(slipStatus(lost)).toBe('lost');
    expect(slipStatus(pending)).toBe('pending');
  });
  it('files slips under live, waiting, won or lost', () => {
    expect(slipFilter(pending, 'live')).toBe('live');
    expect(slipFilter(pending, 'waiting')).toBe('waiting');
    expect(slipFilter(won, 'settled')).toBe('won');
    expect(slipFilter(lost, 'settled')).toBe('lost');
  });
  it('sums the round', () => {
    expect(boardSummary([won, lost, pending])).toEqual({
      staked: 90, players: 2, slips: 3, pendingStake: 50, settledStake: 40, paidOut: 90, profit: -50,
    });
  });
});
