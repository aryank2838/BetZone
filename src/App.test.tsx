import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Gate } from '@/App';
import { TERMS_VERSION, needsTermsAcceptance } from '@/lib/terms';
import type { Profile } from '@/types';

const { authState } = vi.hoisted(() => ({ authState: { current: {} as Record<string, unknown> } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('@/components/Dashboard', () => ({ default: () => <p>Dashboard</p> }));
vi.mock('@/components/AuthScreen', () => ({ default: () => <p>Sign in</p> }));
vi.mock('@/components/HelpButton', () => ({ default: () => null }));

const baseProfile: Profile = {
  id: 'user-1', display_name: 'Test', points: 0, wallet: 0, is_admin: false, is_banned: false,
  created_at: '2026-01-01T00:00:00Z', terms_accepted_at: '2026-01-01T00:00:00Z', terms_version: TERMS_VERSION, age_confirmed: true,
} as Profile;

function renderGate(profile: Profile) {
  authState.current = {
    user: { id: profile.id }, profile, profileError: null, profileErrorDetails: null, loading: false,
    refreshProfile: vi.fn(), passwordRecovery: false, inactivityWarning: null, signOut: vi.fn(),
  };
  render(<Gate />);
}

afterEach(() => { cleanup(); });

describe('terms version gate', () => {
  it('needs acceptance when never accepted or accepted an older version', () => {
    expect(needsTermsAcceptance({ terms_accepted_at: null, terms_version: null })).toBe(true);
    expect(needsTermsAcceptance({ terms_accepted_at: '2026-01-01T00:00:00Z', terms_version: '2025-01-01' })).toBe(true);
    expect(needsTermsAcceptance({ terms_accepted_at: '2026-01-01T00:00:00Z', terms_version: TERMS_VERSION })).toBe(false);
  });

  it('shows the terms screen to a user who accepted an older version', () => {
    renderGate({ ...baseProfile, terms_version: '2025-01-01' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Our terms have been updated');
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('lets a user who accepted the current version through', () => {
    renderGate(baseProfile);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
