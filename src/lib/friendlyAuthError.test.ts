import { describe, expect, it } from 'vitest';
import { friendlyAuthError } from '@/lib/friendlyAuthError';

describe('friendlyAuthError', () => {
  it('uses a neutral message for any signup trigger failure', () => {
    expect(friendlyAuthError('Database error saving new user')).toBe(
      "We couldn't create your account. Try a different email or contact support.",
    );
  });

  it.each([
    'EMAIL_DOMAIN_BLOCKED',
    'EMAIL_ALREADY_USED',
    'User already registered',
  ])('uses the same non-enumerating message for %s', (message) => {
    expect(friendlyAuthError(message)).toBe(
      "This email address can't be used. Please use a different, permanent email.",
    );
  });

  it('keeps the existing invalid-credentials message', () => {
    expect(friendlyAuthError('Invalid login credentials')).toBe('Email or password is incorrect.');
  });
});
