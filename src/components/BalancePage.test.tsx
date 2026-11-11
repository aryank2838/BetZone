import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BalancePage from '@/components/BalancePage';

const { supabaseMock, refreshProfileMock } = vi.hoisted(() => ({
  supabaseMock: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
  refreshProfileMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ profile: null, refreshProfile: refreshProfileMock }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockBackend(merchantUpiId: string | null) {
    supabaseMock.rpc.mockImplementation((name: string, args: { p_key?: string }) => {
      if (name === 'get_app_setting' && args?.p_key === 'merchant_upi_id') {
        return Promise.resolve({ data: merchantUpiId, error: null });
      }
      if (name === 'get_app_setting' && args?.p_key === 'merchant_name') {
        return Promise.resolve({ data: 'BetZone', error: null });
      }
      if (name === 'get_balance_breakdown') {
        return Promise.resolve({
          data: {
            signup_earned: 10,
            selections_spent: 0,
            winnings_total: 0,
            deposits_total: 0,
            withdrawn_total: 0,
            play_balance: 10,
            wallet: 0,
            pending_withdrawals: 0,
            pending_add_funds: 0,
            max_add_funds_amount: 100000,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    supabaseMock.from.mockImplementation(() => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }));
}

describe('BalancePage modal messages', () => {
  it('explains why Add funds is unavailable when no merchant UPI ID is configured', async () => {
    mockBackend(null);
    render(<BalancePage onBack={vi.fn()} onBalanceChanged={vi.fn()} />);
    expect(await screen.findByText(/Adding funds is not available yet/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add funds/i })[0]).toBeDisabled();
  });

  it('renders add-funds validation errors inside the open modal', async () => {
    mockBackend('payments@bank');
    render(<BalancePage onBack={vi.fn()} onBalanceChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /add funds/i }));

    const dialog = screen.getByRole('dialog', { name: 'Add funds' });
    fireEvent.change(within(dialog).getByPlaceholderText('e.g. 500'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit for approval' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter an 8–30 character payment reference using letters or numbers.');
    });
  });
});
