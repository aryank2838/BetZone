import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SignupFunnel from './SignupFunnel';
import { biggestDrop, shareOf, type FunnelData } from './funnelSteps';

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: { rpc: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sample: FunnelData = {
  days: 30,
  signed_up: 200,
  requested_deposit: 60,
  deposit_approved: 50,
  placed_bet: 45,
  verified_email: 12,
  requested_withdrawal: 10,
};

describe('funnel helpers', () => {
  it('works out shares of sign-ups', () => {
    expect(shareOf(60, 200)).toBe(30);
    expect(shareOf(1, 3)).toBe(33);
    expect(shareOf(5, 0)).toBe(0);
  });

  it('finds the step that loses the most players', () => {
    expect(biggestDrop(sample)).toBe('requested_deposit');
    expect(biggestDrop({ ...sample, requested_deposit: 190, deposit_approved: 180, placed_bet: 170 }))
      .toBe('verified_email');
    expect(biggestDrop({ ...sample, signed_up: 0, requested_deposit: 0, deposit_approved: 0,
      placed_bet: 0, verified_email: 0, requested_withdrawal: 0 })).toBeNull();
  });
});

describe('SignupFunnel', () => {
  it('shows each step and highlights the biggest drop', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: sample, error: null });
    render(<SignupFunnel />);
    await screen.findByText('Asked to add money');
    expect(supabaseMock.rpc).toHaveBeenCalledWith('admin_signup_funnel', { p_days: 30 });
    expect(screen.getByText(/biggest drop: 140 players stop here/i)).toBeTruthy();
    expect(screen.getByText('(30%)')).toBeTruthy();
  });

  it('reloads for another period', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: sample, error: null });
    render(<SignupFunnel />);
    await screen.findByText('Asked to add money');
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(supabaseMock.rpc).toHaveBeenLastCalledWith('admin_signup_funnel', { p_days: null }));
  });
});
