import { authRedirectUrl } from '@/lib/authRedirect';

const STORAGE_KEY = 'betzone_ref';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/** Upper-cases and checks an invite code; null when it cannot be one. */
export function normalizeReferralCode(value: string | null | undefined): string | null {
  const code = (value ?? '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

export function referralLink(code: string): string {
  return `${authRedirectUrl().replace(/\/+$/, '')}/?ref=${encodeURIComponent(code)}`;
}

export function whatsappShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

/**
 * Keeps `?ref=CODE` from an invite link so the sign-up form can fill it in,
 * even if the friend browses around first, and removes it from the address bar.
 */
export function captureReferralFromUrl(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('ref')) return;
  const code = normalizeReferralCode(params.get('ref'));
  if (code) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* storage blocked: the code can still be typed */ }
  }
  params.delete('ref');
  const query = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

export function storedReferralCode(): string | null {
  try {
    return normalizeReferralCode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearStoredReferralCode(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
