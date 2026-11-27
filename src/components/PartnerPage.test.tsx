import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PartnerPage from '@/components/PartnerPage';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));

const dashboard = {
  code: 'RAHUL2',
  share_percent: 50,
  active: true,
  payout_upi: null,
  player_count: 2,
  week: {
    week_start: '2026-11-23', week_end: '2026-11-28',
    bets: 12000, wins: 7000, bonuses: 500, net: 4500, carry_in: -1500,
    share_percent: 50, projected_share: 1500,
  },
  players: [
    { name: 'Amit', joined_at: '2026-11-20T10:00:00Z', bets: 10000, wins: 4000, net: 6000, last_active: '2026-11-26T10:00:00Z' },
    { name: 'Sunil', joined_at: '2026-11-21T10:00:00Z', bets: 2000, wins: 3000, net: -1500, last_active: null },
  ],
  weeks: [
    {
      week_start: '2026-11-16', week_end: '2026-11-21', bets: 3000, wins: 4500, bonuses: 0, net: -1500,
      carry_in: 0, carry_out: -1500, share_percent: 50, share: 0, status: 'nothing_due', paid_at: null, paid_utr: null,
    },
    {
      week_start: '2026-11-09', week_end: '2026-11-14', bets: 9000, wins: 1000, bonuses: 0, net: 8000,
      carry_in: 0, carry_out: 0, share_percent: 50, share: 4000, status: 'paid', paid_at: '2026-11-15T08:00:00Z', paid_utr: '412345678901',
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('partner dashboard', () => {
  it('shows this week, the carried loss, players and past weeks', async () => {
    rpcMock.mockResolvedValue({ data: dashboard, error: null });
    render(<PartnerPage onBack={vi.fn()} />);

    expect(await screen.findByText('Your earnings so far')).toBeInTheDocument();
    expect(screen.getByText('₹1,500', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Net profit').nextSibling).toHaveTextContent('₹4,500');
    expect(screen.getByText('Loss carried from last week').nextSibling).toHaveTextContent('−₹1,500');
    expect(screen.getByText('Your players (2)')).toBeInTheDocument();
    expect(screen.getByText('Amit')).toBeInTheDocument();
    expect(screen.getByText('Net −₹1,500')).toBeInTheDocument();
    expect(screen.getByText('Nothing due · −₹1,500 carried')).toBeInTheDocument();
    expect(screen.getByText(/UTR 412345678901/)).toBeInTheDocument();
    expect(screen.getByText('RAHUL2')).toBeInTheDocument();
  });

  it('checks and saves the payout UPI ID', async () => {
    rpcMock.mockImplementation((name: string) => Promise.resolve(
      name === 'partner_set_payout_upi' ? { data: { payout_upi: 'rahul@okaxis' }, error: null } : { data: dashboard, error: null },
    ));
    render(<PartnerPage onBack={vi.fn()} />);

    const input = await screen.findByLabelText('Your UPI ID for payouts');
    fireEvent.change(input, { target: { value: 'not-a-upi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save UPI ID' }));
    expect(screen.getByText('UPI ID must look like name@bank.')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'rahul@okaxis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save UPI ID' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('partner_set_payout_upi', { p_upi: 'rahul@okaxis' }));
  });

  it('shows the levels and how much more profit reaches the next one', async () => {
    rpcMock.mockResolvedValue({
      data: {
        ...dashboard,
        share_percent: 40,
        uses_levels: true,
        levels: [{ min_profit: 0, percent: 30 }, { min_profit: 1001, percent: 40 }, { min_profit: 2001, percent: 50 }],
        week: { ...dashboard.week, net: 1700, carry_in: -200, share_percent: 40, projected_share: 600, uses_levels: true, next_level_min: 2001, next_level_percent: 50 },
      },
      error: null,
    });
    render(<PartnerPage onBack={vi.fn()} />);

    expect(await screen.findByText('This week: 40% of net profit')).toBeInTheDocument();
    expect(screen.getByText('₹501 more profit this week takes you to 50%.')).toBeInTheDocument();
    expect(screen.getByText('₹0 – ₹1,000 profit')).toBeInTheDocument();
    expect(screen.getByText('₹1,001 – ₹2,000 profit').parentElement).toHaveClass('font-semibold');
    expect(screen.getByText('₹2,001+ profit')).toBeInTheDocument();
  });

  it('says so when the account is not a partner', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    render(<PartnerPage onBack={vi.fn()} />);
    expect(await screen.findByText('This account is not a partner.')).toBeInTheDocument();
  });
});
