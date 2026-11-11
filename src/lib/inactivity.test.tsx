import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { AuthProvider, useAuth } from '@/lib/auth';
import { ACTIVITY_STORAGE_KEY, INACTIVITY_TIMEOUT_MS, INACTIVITY_WARNING_MS } from '@/lib/inactivity';

const { authMock, supabaseMock } = vi.hoisted(() => {
  const authMock = { getUser: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() };
  const supabaseMock = { auth: authMock, from: vi.fn() };
  return { authMock, supabaseMock };
});
vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));

const user = { id: 'user-1', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: 't', token_type: 'bearer', expires_in: 3600, expires_at: 1893456000, refresh_token: 'r', user } as Session;
const profile = {
  id: user.id, display_name: 'Test', points: 0, wallet: 0, is_admin: false, is_banned: false,
  created_at: '2026-01-01T00:00:00Z', terms_accepted_at: '2026-01-01T00:00:00Z', terms_version: 'test', age_confirmed: true,
};

function Warning() {
  const { inactivityWarning } = useAuth();
  return <p data-testid="warning">{inactivityWarning === null ? 'none' : String(inactivityWarning)}</p>;
}

async function signIn() {
  let listener: ((event: AuthChangeEvent, value: Session | null) => void) | undefined;
  authMock.onAuthStateChange.mockImplementation((callback: typeof listener) => {
    listener = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  render(<AuthProvider><Warning /></AuthProvider>);
  await act(async () => {
    listener?.('SIGNED_IN', session);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-11T10:00:00Z') });
  localStorage.clear();
  authMock.signOut.mockResolvedValue({ error: null });
  supabaseMock.from.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: profile, error: null }) }) }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('inactivity logout', () => {
  it('warns 60 seconds before the 30-minute timeout and then signs out', async () => {
    await signIn();
    await advance(INACTIVITY_TIMEOUT_MS - INACTIVITY_WARNING_MS - 1000);
    expect(screen.getByTestId('warning')).toHaveTextContent('none');
    await advance(1000);
    expect(screen.getByTestId('warning')).toHaveTextContent('60');
    expect(authMock.signOut).not.toHaveBeenCalled();
    await advance(INACTIVITY_WARNING_MS);
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });

  it('activity resets the timer and is shared at most once per second', async () => {
    await signIn();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await advance(20 * 60_000);
    act(() => {
      for (let index = 0; index < 10; index += 1) window.dispatchEvent(new Event('pointermove'));
    });
    expect(setItem.mock.calls.filter(([key]) => key === ACTIVITY_STORAGE_KEY)).toHaveLength(1);
    await advance(1000);
    act(() => { window.dispatchEvent(new Event('keydown')); });
    expect(setItem.mock.calls.filter(([key]) => key === ACTIVITY_STORAGE_KEY)).toHaveLength(2);

    // 29 minutes after the last activity: still signed in, no warning yet.
    await advance(INACTIVITY_TIMEOUT_MS - INACTIVITY_WARNING_MS - 1000);
    expect(screen.getByTestId('warning')).toHaveTextContent('none');
    expect(authMock.signOut).not.toHaveBeenCalled();
    await advance(INACTIVITY_WARNING_MS + 1000);
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
  });

  it('does not sign out an idle tab while another tab is active', async () => {
    await signIn();
    await advance(25 * 60_000);
    // Another tab reports activity through localStorage.
    act(() => {
      const now = String(Date.now());
      localStorage.setItem(ACTIVITY_STORAGE_KEY, now);
      window.dispatchEvent(new StorageEvent('storage', { key: ACTIVITY_STORAGE_KEY, newValue: now }));
    });
    await advance(25 * 60_000);
    expect(authMock.signOut).not.toHaveBeenCalled();

    // The other tab writes activity without a storage event reaching us; the
    // logout timer re-reads the shared timestamp before signing out.
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now()));
    await advance(5 * 60_000);
    expect(authMock.signOut).not.toHaveBeenCalled();

    await advance(INACTIVITY_TIMEOUT_MS);
    expect(authMock.signOut).toHaveBeenCalledTimes(1);
  });
});
