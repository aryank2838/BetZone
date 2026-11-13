import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AdminHomeCard from '@/components/AdminHomeCard';
import AdminAlertsProvider from '@/lib/AdminAlertsProvider';
import type { GameStatus } from '@/types';

const { rpcMock, channelMock } = vi.hoisted(() => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return { rpcMock: vi.fn(), channelMock: channel };
});
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: rpcMock, channel: () => channelMock, removeChannel: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  channelMock.on.mockReturnValue(channelMock);
  channelMock.subscribe.mockReturnValue(channelMock);
});

const status: GameStatus = {
  game: 'test', label: 'Kalyan', round_date: '2026-11-13',
  open_bets_open: false, close_bets_open: true,
  bets_open_at: '08:00:00', open_bets_close_at: '15:15:00', close_bets_close_at: '17:15:00',
  server_now: '2026-11-13T10:30:00Z', open_bets_close_ts: '', close_bets_close_ts: '',
  open_result_at: '15:30:00', close_result_at: '17:30:00',
  server_ist_date: '2026-11-13', server_ist_time: '16:00:00', close_result_next_day: false,
};

function mockRpc({ waiting = [2, 1] as [number, number], statsFail = false } = {}) {
  rpcMock.mockImplementation((name: string) => {
    switch (name) {
      case 'admin_get_stats':
        return Promise.resolve(statsFail ? { data: null, error: new Error('boom') } : {
          data: {
            pending_addfunds_count: waiting[0], pending_addfunds_amount: waiting[0] * 500,
            pending_withdrawals_count: waiting[1], pending_withdrawals_amount: waiting[1] * 1000,
          },
          error: null,
        });
      case 'admin_daily_report':
        return Promise.resolve({ data: [{ game: 'ALL', total_staked: 12000, total_paid_out: 9000, gaming_revenue: 3000 }], error: null });
      case 'get_result_history':
        return Promise.resolve({ data: [], error: null });
      case 'admin_get_exposure':
        return Promise.resolve({
          data: { exposure: [
            { bet_type: 'jodi', number: '27', total_stake: 500, potential_payout: 45000 },
            { bet_type: 'single_open', number: '4', total_stake: 100, potential_payout: 900 },
          ] },
          error: null,
        });
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
}

const renderCard = (onOpen = vi.fn()) => render(
  <AdminAlertsProvider onOpenRequests={vi.fn()}>
    <AdminHomeCard statuses={[status]} onOpen={onOpen} />
  </AdminAlertsProvider>,
);

describe('AdminHomeCard', () => {
  it('shows waiting requests and opens the requests tab', async () => {
    mockRpc();
    const onOpen = vi.fn();
    renderCard(onOpen);

    expect(await screen.findByText('3 waiting')).toBeInTheDocument();
    expect(screen.getByText('2 · ₹1,000')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('admin_get_stats', { p_round_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    fireEvent.click(screen.getByRole('button', { name: 'Review requests (3)' }));
    expect(onOpen).toHaveBeenCalledWith('requests');
    fireEvent.click(screen.getByRole('button', { name: /Open admin panel/ }));
    expect(onOpen).toHaveBeenCalledWith('stats');
  });

  it('warns about an overdue result and links to the Results tab for that game', async () => {
    mockRpc();
    const onOpen = vi.fn();
    renderCard(onOpen);
    expect(await screen.findByText(/Kalyan open result was due at 3:30 PM IST and isn't posted \(30m late\)/)).toBeInTheDocument();
    expect(screen.queryByText(/close result/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Post result' }));
    expect(onOpen).toHaveBeenCalledWith('results', 'test');
  });

  it("shows today's totals and the biggest payout risk", async () => {
    mockRpc();
    renderCard();
    expect(await screen.findByText('Jodi 27 would pay ₹45,000')).toBeInTheDocument();
    expect(screen.getByText('Kalyan · ₹500 staked')).toBeInTheDocument();
    expect(screen.getByText('₹12,000')).toBeInTheDocument();
    expect(screen.getByText('₹3,000')).toBeInTheDocument();
  });

  it('says nothing is waiting', async () => {
    mockRpc({ waiting: [0, 0] });
    renderCard();
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review requests' })).toBeInTheDocument();
  });

  it('still lets the admin open the panel if counts fail to load', async () => {
    mockRpc({ statsFail: true });
    renderCard();
    expect(await screen.findByText(/Couldn't load waiting requests/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open admin panel/ })).toBeEnabled();
  });

  it('subscribes to live changes on both request tables', () => {
    mockRpc();
    renderCard();
    const tables = channelMock.on.mock.calls.map((call) => (call[1] as { table: string }).table);
    expect(tables).toEqual(expect.arrayContaining(['add_funds_requests', 'withdrawals']));
  });
});
