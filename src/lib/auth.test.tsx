import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { AuthProvider, useAuth } from '@/lib/auth';

const { authMock, maybeSingleMock, supabaseMock } = vi.hoisted(() => {
  const authMock = {
    getUser: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  };
  const maybeSingleMock = vi.fn();
  const supabaseMock = { auth: authMock, from: vi.fn() };
  return { authMock, maybeSingleMock, supabaseMock };
});

vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }));

const user = {
  id: 'user-1',
  app_metadata: {},
  user_metadata: {},
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
};
const session = {
  access_token: 'access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 1893456000,
  refresh_token: 'refresh-token',
  user,
} as Session;
const profile = {
  id: user.id,
  display_name: 'Test User',
  points: 100,
  wallet: 0,
  is_admin: false,
  is_banned: false,
  created_at: '2026-01-01T00:00:00Z',
  terms_accepted_at: '2026-01-01T00:00:00Z',
  terms_version: 'test',
  age_confirmed: true,
};

function TestScreen() {
  const { loading, user: authUser, profile: authProfile, refreshProfile } = useAuth();
  const [value, setValue] = useState('');

  if (loading) return <p>Loading</p>;
  if (!authUser || !authProfile) return <p>Profile unavailable</p>;
  return (
    <section data-testid="screen">
      <input aria-label="Typed input" value={value} onChange={(event) => setValue(event.target.value)} />
      <button type="button" onClick={() => void refreshProfile()}>Refresh profile</button>
    </section>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthProvider profile refresh', () => {
  it('keeps the active screen and typed input mounted on same-user refreshes', async () => {
    const authListener: { current?: (event: AuthChangeEvent, session: Session | null) => void } = {};
    const deferredProfiles: Array<(result: { data: typeof profile; error: null }) => void> = [];

    authMock.getUser.mockResolvedValue({ data: { user }, error: null });
    authMock.onAuthStateChange.mockImplementation(
      (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
        authListener.current = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    );
    supabaseMock.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: maybeSingleMock,
        }),
      }),
    });
    maybeSingleMock.mockImplementation(() => {
      if (deferredProfiles.length > 0 || maybeSingleMock.mock.calls.length > 1) {
        return new Promise((resolve) => deferredProfiles.push(resolve));
      }
      return Promise.resolve({ data: profile, error: null });
    });

    render(<AuthProvider><TestScreen /></AuthProvider>);
    await act(async () => {
      authListener.current?.('SIGNED_IN', session);
    });
    await screen.findByRole('textbox', { name: 'Typed input' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Typed input' }), {
      target: { value: 'half-filled deposit details' },
    });
    const activeScreen = screen.getByTestId('screen');

    await act(async () => {
      authListener.current?.('SIGNED_IN', session);
    });
    await waitFor(() => expect(deferredProfiles).toHaveLength(1));
    expect(screen.getByTestId('screen')).toBe(activeScreen);
    expect(screen.getByRole('textbox', { name: 'Typed input' })).toHaveValue('half-filled deposit details');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh profile' }));
    await waitFor(() => expect(deferredProfiles).toHaveLength(2));
    expect(screen.getByTestId('screen')).toBe(activeScreen);
    expect(screen.getByRole('textbox', { name: 'Typed input' })).toHaveValue('half-filled deposit details');

    await act(async () => {
      deferredProfiles.forEach((resolve) => resolve({ data: profile, error: null }));
    });
    expect(screen.getByTestId('screen')).toBe(activeScreen);
    expect(screen.getByRole('textbox', { name: 'Typed input' })).toHaveValue('half-filled deposit details');
  });
});
