import type { EmailOtpType } from '@supabase/supabase-js';

/** Where Supabase email links (confirm, reset) should send people back to. */
export function authRedirectUrl(): string {
  const configured = (import.meta.env.VITE_SITE_URL as string | undefined)?.trim();
  return configured || window.location.origin;
}

const OTP_TYPES: EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

export interface AuthRedirect {
  /** Set when Supabase sent the person back with an error (e.g. otp_expired). */
  error?: { code: string; description: string };
  /** Set when the email template links here with ?token_hash=...&type=... */
  tokenHash?: { token_hash: string; type: EmailOtpType };
}

/**
 * Reads the auth result that Supabase puts on the URL after an email link
 * is opened, and strips it from the address bar so a reload does not repeat it.
 * Successful implicit-flow tokens (#access_token=...) are left alone: the
 * Supabase client reads those itself.
 */
export function consumeAuthRedirect(location: Location = window.location): AuthRedirect {
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const result: AuthRedirect = {};

  const errorCode = hash.get('error_code') || search.get('error_code') || hash.get('error') || search.get('error');
  if (errorCode) {
    result.error = {
      code: errorCode,
      description: (hash.get('error_description') || search.get('error_description') || '').replace(/\+/g, ' '),
    };
  }

  const tokenHash = search.get('token_hash');
  const type = search.get('type') as EmailOtpType | null;
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    result.tokenHash = { token_hash: tokenHash, type };
  }

  if (result.error || result.tokenHash) {
    for (const key of ['error', 'error_code', 'error_description', 'token_hash', 'type', 'sb']) search.delete(key);
    const query = search.toString();
    const keepHash = !result.error && location.hash ? location.hash : '';
    window.history.replaceState(window.history.state, '', `${location.pathname}${query ? `?${query}` : ''}${keepHash}`);
  }
  return result;
}

/** Supabase's "you must confirm your email first" sign-in error. */
export function isEmailNotConfirmedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 'email_not_confirmed' || (typeof message === 'string' && /email not confirmed/i.test(message));
}
