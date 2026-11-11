import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SelectionScreen from '@/components/SelectionScreen';

const { rpcMock, supabaseFromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  supabaseFromMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: rpcMock, from: supabaseFromMock },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ profile: { id: 'user-1', points: 60, wallet: 100 } }),
}));
vi.mock('@/lib/useMyLimits', () => ({
  useMyLimits: () => ({ limits: null }),
  activePlayRestriction: () => null,
  formatLimitEnd: (value: string) => value,
}));
vi.mock('@/lib/useGameStatus', () => ({
  useGameStatus: () => ({
    statuses: [{
      game: 'test',
      label: 'Test Game',
      round_date: '2026-11-10',
      open_bets_open: true,
      close_bets_open: true,
      bets_open_at: '00:00',
      open_bets_close_at: '23:59',
      close_bets_close_at: '23:59',
      server_now: new Date().toISOString(),
      open_bets_close_ts: new Date(Date.now() + 60 * 60_000).toISOString(),
      close_bets_close_ts: new Date(Date.now() + 60 * 60_000).toISOString(),
      open_result_at: '23:59',
      close_result_at: '23:59',
      server_ist_date: '2026-11-10',
      server_ist_time: '12:00:00',
      close_result_next_day: false,
    }],
    loading: false,
    error: null,
    errorDetails: '',
    nowMs: Date.now(),
    refresh: vi.fn(),
  }),
}));

function makeSelectionQuery() {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    then: (resolve: (value: { data: never[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return chain;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('selection bet slip', () => {
  it('shows totals and after-bet balances, then keeps server errors in the modal', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_latest_results') return Promise.resolve({ data: null, error: null });
      if (name === 'submit_selection') {
        return Promise.resolve({ data: null, error: new Error('Betting is closed for this bet type right now.') });
      }
      return Promise.resolve({ data: null, error: null });
    });
    supabaseFromMock.mockReturnValue(makeSelectionQuery());

    render(
      <SelectionScreen
        game="test"
        onBack={vi.fn()}
        onPointsChanged={vi.fn()}
        onAddFunds={vi.fn()}
      />,
    );

    await screen.findByRole('button', { name: '00' });
    fireEvent.change(screen.getByLabelText('Stake per pick:'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: '00' }));
    fireEvent.click(screen.getByRole('button', { name: '01' }));
    fireEvent.click(screen.getByRole('button', { name: /Review|Submit/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Check your bets' });
    expect(within(dialog).getByText('Number of bets').nextSibling).toHaveTextContent('2');
    expect(within(dialog).getByText('Total to pay').nextSibling).toHaveTextContent('100');
    expect(within(dialog).getByText('Betting balance').nextSibling).toHaveTextContent('0');
    expect(within(dialog).getByText('Withdrawable').nextSibling).toHaveTextContent('60');
    expect(within(dialog).getAllByText('Win ₹4,500')).toHaveLength(2);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Place bets' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Betting for this is closed right now.');
    });
  });
});
