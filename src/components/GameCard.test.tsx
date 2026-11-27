import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import GameCard from '@/components/GameCard';
import type { GameStatus } from '@/types';
import type { GamePhase } from '@/lib/gameState';

afterEach(cleanup);

const status = {
  game: 'test',
  label: 'Test Game',
  round_date: '2026-11-10',
  open_bets_open: false,
  close_bets_open: false,
  bets_open_at: '10:00',
  open_bets_close_at: '12:00',
  close_bets_close_at: '18:00',
  server_now: '2026-11-10T15:30:00Z',
  open_bets_close_ts: '2026-11-10T06:30:00Z',
  close_bets_close_ts: '2026-11-10T12:30:00Z',
  open_result_at: '12:30',
  close_result_at: '18:30',
  server_ist_date: '2026-11-10',
  server_ist_time: '21:00:00',
  close_result_next_day: false,
  holiday_reopens_on: '2026-11-12',
  day_off_reopens_on: '2026-11-11',
} as unknown as GameStatus;

describe('GameCard chart button', () => {
  it.each<GamePhase>(['closed', 'dayOff', 'holiday'])('opens the chart when the game is %s', (phase) => {
    const onOpenChart = vi.fn();
    render(<GameCard status={status} phase={phase} result={null} nowMs={Date.parse(status.server_now)} onOpen={vi.fn()} onOpenChart={onOpenChart} />);
    fireEvent.click(screen.getByRole('button', { name: /chart · test game/i }));
    expect(onOpenChart).toHaveBeenCalledTimes(1);
  });

  it('keeps the chart open for a banned player on a closed game', () => {
    const onOpenChart = vi.fn();
    render(<GameCard status={status} phase="closed" result={null} nowMs={0} disabled onOpen={vi.fn()} onOpenChart={onOpenChart} />);
    fireEvent.click(screen.getByRole('button', { name: /chart · test game/i }));
    expect(onOpenChart).toHaveBeenCalledTimes(1);
  });
});
