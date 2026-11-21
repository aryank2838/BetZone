import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SportEventBets, { type AdminSportBet } from '@/components/admin/SportEventBets';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const bet = (overrides: Partial<AdminSportBet>): AdminSportBet => ({
  id: Math.random().toString(36).slice(2), user_id: 'u1', user_name: 'Ravi', side: 'yes', amount: 100,
  from_points: 0, from_wallet: 100, status: 'open', payout: 0, created_at: '2026-11-21T10:00:00Z', ...overrides,
});

describe('SportEventBets', () => {
  it('lists each player bet with totals per side and filters by side', async () => {
    rpcMock.mockResolvedValue({
      data: [
        bet({ user_name: 'Ravi', amount: 200 }),
        bet({ user_id: 'u2', user_name: 'Asha', side: 'no', amount: 50, status: 'won', payout: 90 }),
        bet({ user_name: 'Ravi', amount: 100 }),
      ],
      error: null,
    });
    render(<SportEventBets eventId="e1" subject="India" />);

    expect(await screen.findByText('₹300 · 1 player')).toBeInTheDocument();
    expect(screen.getByText('₹50 · 1 player')).toBeInTheDocument();
    expect(screen.getByText('Won ₹90')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('admin_sport_event_bets', { p_event_id: 'e1' });

    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByText('Asha')).toBeInTheDocument();
    expect(screen.queryByText('Ravi')).not.toBeInTheDocument();
  });

  it('says so when nobody has bet', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    render(<SportEventBets eventId="e1" subject="India" />);
    expect(await screen.findByText('No player bets on this match.')).toBeInTheDocument();
  });
});
