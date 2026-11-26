import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SelectionScreen from '@/components/SelectionScreen';
import { resetPublicRulesCache } from '@/lib/betLimits';

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
  resetPublicRulesCache();
  vi.clearAllMocks();
});

describe('selection bet slip', () => {
  it('keeps picks when the player looks at another bet type', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    supabaseFromMock.mockReturnValue(makeSelectionQuery());
    render(<SelectionScreen game="test" onBack={vi.fn()} onPointsChanged={vi.fn()} onAddFunds={vi.fn()} />);

    await screen.findByRole('button', { name: '00' });
    fireEvent.click(screen.getByRole('button', { name: '00' }));
    fireEvent.click(screen.getByRole('button', { name: '01' }));
    expect(screen.getByText(/2 numbers/)).toBeInTheDocument();

    // Switch to Single Open, add a pick there, and see the Jodi picks still waiting.
    fireEvent.click(screen.getByRole('tab', { name: /^Open/ }));
    expect(screen.getByRole('tab', { name: /Jodi/ })).toHaveTextContent('2');
    fireEvent.click(await screen.findByRole('button', { name: '7' }));
    expect(screen.getByText('Also waiting: Jodi (2)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Jodi/ }));
    expect(screen.getByText(/2 numbers/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '00' })).toHaveAttribute('aria-pressed', 'true');
  });

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
    fireEvent.change(screen.getByLabelText(/type your own amount/i), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: '00' }));
    fireEvent.click(screen.getByRole('button', { name: '01' }));
    // The sticky slip bar shows the running count and total.
    expect(screen.getByText(/2 numbers · ₹100/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Review bets/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Check your bets' });
    expect(within(dialog).getByText('Number of bets').nextSibling).toHaveTextContent('2');
    expect(within(dialog).getByText('Total to pay').nextSibling).toHaveTextContent('100');
    expect(within(dialog).getByText('Betting balance').nextSibling).toHaveTextContent('0');
    expect(within(dialog).getByText('Withdrawable').nextSibling).toHaveTextContent('60');
    expect(within(dialog).getAllByText('Win ₹4,500')).toHaveLength(2);

    // Amounts can still be changed on the review sheet itself.
    fireEvent.change(within(dialog).getByLabelText('Bet on 00'), { target: { value: '20' } });
    expect(within(dialog).getByText('Total to pay').nextSibling).toHaveTextContent('70');
    expect(within(dialog).getByText('Win ₹1,800')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Place bets' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Betting for this is closed right now.');
    });
  });
  it('gives ₹5 free per full ₹100 on the slip and sends the chosen commission number', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_public_rules') {
        return Promise.resolve({ data: { maximum_bet: 5000, maximum_submit: 20000, commission_per_100: 5 }, error: null });
      }
      if (name === 'submit_selection') {
        return Promise.resolve({ data: { new_count: 3, new_points: 150, commission: 5, commission_number: '42' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    supabaseFromMock.mockReturnValue(makeSelectionQuery());
    render(<SelectionScreen game="test" onBack={vi.fn()} onPointsChanged={vi.fn()} onAddFunds={vi.fn()} />);

    await screen.findByRole('button', { name: '00' });
    fireEvent.change(screen.getByLabelText(/type your own amount/i), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: '00' }));
    expect(await screen.findByText('Bet ₹50 more on this slip to get ₹5 free.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '01' }));
    fireEvent.click(screen.getByRole('button', { name: '02' }));
    // ₹150 still earns only ₹5.
    expect(screen.getByText('+₹5 free commission on this slip')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Review bets/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Check your bets' });
    expect(within(dialog).getByText('Total to pay').nextSibling).toHaveTextContent('150');
    expect(within(dialog).getByText('Commission (free)').nextSibling).toHaveTextContent('5');
    expect(within(dialog).getByText('Total played').nextSibling).toHaveTextContent('155');
    // Defaults to the first slip number.
    expect(within(dialog).getByRole('radio', { name: '00' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Other number' }));
    expect(within(dialog).getByRole('button', { name: 'Place bets' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type the number for your commission'), { target: { value: '42' } });
    expect(within(dialog).getByText('₹5 on 42 · Win ₹450')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Place bets' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('submit_selection', expect.objectContaining({
        p_bet_type: 'jodi',
        p_commission_number: '42',
        p_selections: [{ number: '00', points: 50 }, { number: '01', points: 50 }, { number: '02', points: 50 }],
      }));
    });
  });
});
