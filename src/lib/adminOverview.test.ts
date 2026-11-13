import { describe, expect, it } from 'vitest';
import type { GameStatus } from '@/types';
import {
  addDays, biggestRisk, currentResultRound, formatWaiting, overdueResults, sortForReview,
  titleWithCount, unsettledExposure, waitingTone, type ExposureItem,
} from './adminOverview';

const base: GameStatus = {
  game: 'test', label: 'Kalyan', round_date: '2026-11-13',
  open_bets_open: false, close_bets_open: false,
  bets_open_at: '08:00:00', open_bets_close_at: '15:15:00', close_bets_close_at: '17:15:00',
  server_now: '', open_bets_close_ts: '', close_bets_close_ts: '',
  open_result_at: '15:30:00', close_result_at: '17:30:00',
  server_ist_date: '2026-11-13', server_ist_time: '12:00:00', close_result_next_day: false,
};
const status = (overrides: Partial<GameStatus>): GameStatus => ({ ...base, ...overrides });

describe('overdueResults', () => {
  it('reports nothing before the result times', () => {
    expect(overdueResults([base], { test: [] })).toEqual([]);
  });

  it('reports the open result once its time has passed', () => {
    const [item] = overdueResults([status({ server_ist_time: '15:45:00' })], { test: [] });
    expect(item).toMatchObject({ phase: 'open', roundDate: '2026-11-13', dueAt: '15:30:00', minutesLate: 15 });
  });

  it('stops warning once the result is posted', () => {
    const rows = [{ round_date: '2026-11-13', open_digit: '4', close_digit: null }];
    expect(overdueResults([status({ server_ist_time: '16:00:00' })], { test: rows })).toEqual([]);
  });

  it('checks yesterday\'s round for a close result that comes after midnight', () => {
    const night = status({ open_result_at: '21:30:00', close_result_at: '00:30:00', close_result_next_day: true, server_ist_time: '01:00:00' });
    const missing = overdueResults([night], { test: [{ round_date: '2026-11-13', open_digit: null, close_digit: null }] });
    expect(missing).toEqual([expect.objectContaining({ phase: 'close', roundDate: '2026-11-12', minutesLate: 30 })]);
    const posted = overdueResults([night], { test: [{ round_date: '2026-11-12', open_digit: '1', close_digit: '2' }] });
    expect(posted).toEqual([]);
  });

  it('skips games on holiday and games whose history failed to load', () => {
    const late = { server_ist_time: '18:00:00' };
    expect(overdueResults([status({ ...late, on_holiday: true })], { test: [] })).toEqual([]);
    expect(overdueResults([status(late)], {})).toEqual([]);
  });

  it('lists the most overdue first', () => {
    const items = overdueResults([status({ server_ist_time: '18:00:00' })], { test: [] });
    expect(items.map((item) => item.phase)).toEqual(['open', 'close']);
  });
});

describe('currentResultRound', () => {
  it('uses yesterday until a next-day close result time passes', () => {
    const night = status({ close_result_at: '00:30:00', close_result_next_day: true });
    expect(currentResultRound({ ...night, server_ist_time: '00:10:00' })).toBe('2026-11-12');
    expect(currentResultRound({ ...night, server_ist_time: '09:00:00' })).toBe('2026-11-13');
    expect(currentResultRound(base)).toBe('2026-11-13');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('risk', () => {
  const items: ExposureItem[] = [
    { bet_type: 'single_open', number: '4', total_stake: 100, potential_payout: 9000 },
    { bet_type: 'jodi', number: '27', total_stake: 50, potential_payout: 4500 },
  ];

  it('drops open-phase bets after the open result and everything after the close', () => {
    expect(unsettledExposure(items, undefined)).toHaveLength(2);
    expect(unsettledExposure(items, { round_date: 'x', open_digit: '1', close_digit: null }).map((item) => item.bet_type)).toEqual(['jodi']);
    expect(unsettledExposure(items, { round_date: 'x', open_digit: '1', close_digit: '2' })).toEqual([]);
  });

  it('finds the largest payout across games', () => {
    const best = biggestRisk([
      { game: 'test', label: 'Kalyan', roundDate: 'd', items: [items[1]] },
      { game: 'test2', label: 'Main Bazaar', roundDate: 'd', items: [items[0]] },
    ]);
    expect(best).toMatchObject({ game: 'test2', number: '4', potential_payout: 9000 });
    expect(biggestRisk([{ game: 'test', label: 'Kalyan', roundDate: 'd', items: [] }])).toBeNull();
  });
});

describe('request helpers', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');

  it('formats and grades waiting time', () => {
    expect(formatWaiting('2026-11-13T11:15:00Z', now)).toBe('45m');
    expect(formatWaiting('2026-11-13T09:50:00Z', now)).toBe('2h 10m');
    expect(formatWaiting('2026-11-10T08:00:00Z', now)).toBe('3d 4h');
    expect(waitingTone('2026-11-13T11:50:00Z', now)).toBe('ok');
    expect(waitingTone('2026-11-13T11:00:00Z', now)).toBe('warning');
    expect(waitingTone('2026-11-13T09:00:00Z', now)).toBe('late');
  });

  it('puts pending requests first, oldest first', () => {
    const sorted = sortForReview([
      { id: 'new', status: 'pending', created_at: '2026-11-13T11:00:00Z' },
      { id: 'done-old', status: 'approved', created_at: '2026-11-12T11:00:00Z' },
      { id: 'old', status: 'pending', created_at: '2026-11-13T08:00:00Z' },
      { id: 'done-new', status: 'rejected', created_at: '2026-11-13T10:00:00Z' },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['old', 'new', 'done-new', 'done-old']);
  });

  it('puts the waiting count in the tab title', () => {
    expect(titleWithCount('BetZone', 3)).toBe('(3) BetZone');
    expect(titleWithCount('BetZone', 0)).toBe('BetZone');
  });
});
