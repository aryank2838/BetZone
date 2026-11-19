import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import ReferralCard, { ReferralTeaser, useMyReferral, type MyReferral } from '@/components/ReferralCard';

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
  it('shows the code, the offer, and a WhatsApp link with the invite link', () => {
    render(<ReferralCard data={sample} />);
    expect(screen.getByText('ABC234')).toBeTruthy();
    expect(screen.getByText(/you get 10% of it, up to ₹200/i)).toBeTruthy();
    const share = screen.getByRole('link', { name: /share on whatsapp/i }) as HTMLAnchorElement;
    expect(decodeURIComponent(share.href)).toContain(`${window.location.origin}/?ref=ABC234`);
    expect(screen.getByText('₹150')).toBeTruthy();
  });

  it('lists friends with what each one earned', () => {
    render(<ReferralCard data={sample} />);
    fireEvent.click(screen.getByRole('button', { name: /your friends/i }));
    expect(screen.getByText('+₹150 bonus')).toBeTruthy();
    expect(screen.getByText('Waiting for first deposit')).toBeTruthy();
    expect(screen.getByText('First deposit under ₹100')).toBeTruthy();
  });
});

describe('ReferralTeaser', () => {
  it('pitches the offer before anything is earned and opens the card on tap', () => {
    const onOpen = vi.fn();
    render(<ReferralTeaser data={{ ...sample, total_earned: 0 }} onOpen={onOpen} />);
    expect(screen.getByText(/10% of a friend's first deposit, up to ₹200/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /invite friends/i }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows what was earned once there is something', () => {
    render(<ReferralTeaser data={sample} onOpen={() => {}} />);
    expect(screen.getByText(/earned ₹150 so far/i)).toBeTruthy();
  });
});

describe('useMyReferral', () => {
  it('loads the referral data', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: sample, error: null });
    const { result } = renderHook(() => useMyReferral());
    await waitFor(() => expect(result.current?.code).toBe('ABC234'));
  });

  it('stays null when the data cannot load', async () => {
    supabaseMock.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useMyReferral());
    await waitFor(() => expect(supabaseMock.rpc).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('does not fetch when disabled (admins)', () => {
    renderHook(() => useMyReferral(false));
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});
