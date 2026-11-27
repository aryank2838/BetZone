import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PartnersTab from '@/components/admin/PartnersTab';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));

const partner = {
  user_id: 'p-1',
  name: 'Rahul',
  email: 'rahul@example.com',
  code: 'RAHUL2',
  share_percent: 50,
  active: true,
  payout_upi: 'rahul@okaxis',
  created_at: '2026-11-01T00:00:00Z',
  player_count: 3,
  week: {
    week_start: '2026-11-23', week_end: '2026-11-28',
    bets: 5000, wins: 2000, bonuses: 0, net: 3000, carry_in: 0, share_percent: 50, projected_share: 1500,
  },
  due_total: 4000,
  weeks: [{
    id: 'w-1', week_start: '2026-11-16', week_end: '2026-11-21', bets: 9000, wins: 1000, bonuses: 0, net: 8000,
    carry_in: 0, carry_out: 0, share_percent: 50, share: 4000, status: 'due', paid_at: null, paid_utr: null,
  }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('admin partners tab', () => {
  it('shows what is owed and marks a week paid with its UTR', async () => {
    rpcMock.mockImplementation((name: string) => Promise.resolve(
      name === 'admin_list_partners' ? { data: [partner], error: null } : { data: { status: 'paid' }, error: null },
    ));
    render(<PartnersTab />);

    expect(await screen.findByText('Owe ₹4,000')).toBeInTheDocument();
    expect(screen.getByText(/You owe partners ₹4,000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Weeks/ }));

    const utr = screen.getByPlaceholderText('UTR / reference no.');
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    expect(screen.getByText(/Enter the UTR/)).toBeInTheDocument();

    fireEvent.change(utr, { target: { value: '412345678901' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('admin_mark_partner_week_paid', { p_week_id: 'w-1', p_utr: '412345678901' }));
  });

  it('will not remove a partner who is still owed money', async () => {
    rpcMock.mockImplementation(() => Promise.resolve({ data: [partner], error: null }));
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<PartnersTab />);

    await screen.findByText('Owe ₹4,000');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/You still owe Rahul ₹4,000/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalledWith('admin_remove_partner', expect.anything());
    confirmSpy.mockRestore();
  });

  it('removes a settled partner after confirming', async () => {
    const settled = { ...partner, due_total: 0, weeks: [] };
    rpcMock.mockImplementation((name: string) => Promise.resolve(
      name === 'admin_list_partners' ? { data: [settled], error: null } : { data: { players_untagged: 3 }, error: null },
    ));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PartnersTab />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('their 3 players go back to you'));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('admin_remove_partner', { p_user_id: 'p-1' }));
    expect(await screen.findByText('Rahul is no longer a partner. 3 players moved back to you.')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('adds a partner by invite code with their share', async () => {
    rpcMock.mockImplementation((name: string) => Promise.resolve(
      name === 'admin_list_partners' ? { data: [], error: null } : { data: { tagged_players: 2 }, error: null },
    ));
    render(<PartnersTab />);

    await screen.findByText('No partners yet.');
    fireEvent.change(screen.getByLabelText("Partner's invite code or email"), { target: { value: 'RAHUL2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make partner' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('admin_save_partner', { p_lookup: 'RAHUL2', p_share_percent: null }));
    expect(await screen.findByText(/2 players they had already invited are now theirs/)).toBeInTheDocument();
  });

  it('shows a levels partner and saves edited levels', async () => {
    const levelsPartner = { ...partner, share_percent: null, week: { ...partner.week, share_percent: 50 } };
    rpcMock.mockImplementation((name: string) => Promise.resolve(
      name === 'admin_list_partners' ? { data: [levelsPartner], error: null }
        : name === 'admin_get_partner_levels' ? { data: [{ min_profit: 0, percent: 30 }, { min_profit: 1001, percent: 40 }, { min_profit: 2001, percent: 50 }], error: null }
        : { data: [], error: null },
    ));
    render(<PartnersTab />);

    expect(await screen.findByText('Levels · 50% now')).toBeInTheDocument();
    const percent = await screen.findByLabelText('Level 3 percent');
    expect(percent).toHaveValue(50);
    expect(screen.getByText('up to ₹1,000')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Level 3 starts at profit'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save levels' }));
    expect(screen.getByText('Each level must start at a higher profit than the one before.')).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith('admin_save_partner_levels', expect.anything());

    fireEvent.change(screen.getByLabelText('Level 3 starts at profit'), { target: { value: '3001' } });
    fireEvent.change(percent, { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save levels' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('admin_save_partner_levels', {
      p_levels: [{ min_profit: 0, percent: 30 }, { min_profit: 1001, percent: 40 }, { min_profit: 3001, percent: 45 }],
    }));
  });
});
