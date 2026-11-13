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

describe('Money page', () => {
  it('explains why adding money is unavailable when no merchant UPI ID is configured', async () => {
    mockBackend(null);
    render(<BalancePage onBalanceChanged={vi.fn()} />);
    expect(await screen.findByText(/Adding money isn't available right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send for checking' })).not.toBeInTheDocument();
  });

  it('shows Add, Withdraw and History as tabs', async () => {
    mockBackend('payments@bank');
    render(<BalancePage onBalanceChanged={vi.fn()} />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Add', 'Withdraw', 'History']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(tabs[1]);
    expect(await screen.findByRole('button', { name: /Request withdrawal/ })).toBeInTheDocument();
  });

  it('opens on the tab it is given', async () => {
    mockBackend('payments@bank');
    render(<BalancePage initialTab="history" onBalanceChanged={vi.fn()} />);
    expect(await screen.findByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('requires both a payment screenshot and a UTR number before sending', async () => {
    mockBackend('payments@bank');
    render(<BalancePage onBalanceChanged={vi.fn()} />);

    const panel = await screen.findByRole('tabpanel');
    const send = await within(panel).findByRole('button', { name: 'Send for checking' });
    fireEvent.change(within(panel).getByPlaceholderText('e.g. 500'), { target: { value: '10' } });
    expect(within(panel).getByText(/Payment screenshot/, { selector: 'span' })).toHaveTextContent('(required)');
    expect(within(panel).getByText(/UTR number/, { selector: 'span' })).toHaveTextContent('(required)');
    expect(send).toBeDisabled();

    // UTR alone is not enough.
    fireEvent.change(within(panel).getByPlaceholderText('e.g. 412345678901'), { target: { value: '412345678901' } });
    expect(send).toBeDisabled();

    // Screenshot alone is not enough either.
    fireEvent.change(within(panel).getByPlaceholderText('e.g. 412345678901'), { target: { value: '' } });
    const fileInput = panel.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'proof.png', { type: 'image/png' })] } });
    expect(await within(panel).findByText('Screenshot added')).toBeInTheDocument();
    expect(send).toBeDisabled();

    // Both present: the button is enabled.
    fireEvent.change(within(panel).getByPlaceholderText('e.g. 412345678901'), { target: { value: '412345678901' } });
    await waitFor(() => expect(send).toBeEnabled());
  });
});
