import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ReferralCard, { type MyReferral } from '@/components/ReferralCard';

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: { rpc: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sample: MyReferral = {
  code: 'ABC234',
  rules: { percent: 10, max_reward: 200, min_deposit: 100, max_friends_per_30_days: 20 },
  friends_joined: 3,
  friends_rewarded: 1,
  total_earned: 150,
  friends: [
    { name: 'Ravi', joined_at: '2026-11-18T10:00:00Z', status: 'paid', reward: 150 },
    { name: 'Asha', joined_at: '2026-11-17T10:00:00Z', status: null, reward: 0 },
    { name: 'Vik', joined_at: '2026-11-16T10:00:00Z', status: 'too_small', reward: 0 },
  ],
};

describe('ReferralCard', () => {
  it('shows the code, the offer, and a WhatsApp link with the invite link', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: sample, error: null });
    render(<ReferralCard />);
    await screen.findByText('ABC234');
    expect(screen.getByText(/you get 10% of it, up to ₹200/i)).toBeTruthy();
    const share = screen.getByRole('link', { name: /share on whatsapp/i }) as HTMLAnchorElement;
    expect(decodeURIComponent(share.href)).toContain(`${window.location.origin}/?ref=ABC234`);
    expect(screen.getByText('₹150')).toBeTruthy();
  });

  it('lists friends with what each one earned', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: sample, error: null });
    render(<ReferralCard />);
    fireEvent.click(await screen.findByRole('button', { name: /your friends/i }));
    expect(screen.getByText('+₹150 bonus')).toBeTruthy();
    expect(screen.getByText('Waiting for first deposit')).toBeTruthy();
    expect(screen.getByText('First deposit under ₹100')).toBeTruthy();
  });

  it('stays hidden when the data cannot load', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { container } = render(<ReferralCard />);
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });
});
