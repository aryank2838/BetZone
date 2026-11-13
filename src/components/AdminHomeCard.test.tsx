import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AdminHomeCard from '@/components/AdminHomeCard';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const stats = (addfunds: number, withdrawals: number) => ({
  data: {
    pending_addfunds_count: addfunds,
    pending_addfunds_amount: addfunds * 500,
    pending_withdrawals_count: withdrawals,
    pending_withdrawals_amount: withdrawals * 1000,
  },
  error: null,
});

describe('AdminHomeCard', () => {
  it('shows waiting requests and opens the requests tab', async () => {
    rpcMock.mockResolvedValue(stats(2, 1));
    const onOpen = vi.fn();
    render(<AdminHomeCard onOpen={onOpen} />);

    expect(await screen.findByText('3 waiting')).toBeInTheDocument();
    expect(screen.getByText('2 · ₹1,000')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('admin_get_stats', { p_round_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    fireEvent.click(screen.getByRole('button', { name: 'Review requests' }));
    expect(onOpen).toHaveBeenCalledWith('requests');
    fireEvent.click(screen.getByRole('button', { name: /Open admin panel/ }));
    expect(onOpen).toHaveBeenCalledWith('stats');
  });

  it('says nothing is waiting and hides the review button', async () => {
    rpcMock.mockResolvedValue(stats(0, 0));
    render(<AdminHomeCard onOpen={vi.fn()} />);
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review requests' })).not.toBeInTheDocument();
  });

  it('still lets the admin open the panel if counts fail to load', async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error('boom') });
    render(<AdminHomeCard onOpen={vi.fn()} />);
    expect(await screen.findByText(/Couldn't load waiting requests/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open admin panel/ })).toBeEnabled();
  });
});
