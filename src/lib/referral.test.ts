import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReferralFromUrl, clearStoredReferralCode, normalizeReferralCode, referralLink,
  storedReferralCode, whatsappShareUrl,
} from './referral';

afterEach(() => {
  clearStoredReferralCode();
  window.history.replaceState(null, '', '/');
});

describe('referral helpers', () => {
  it('accepts only real invite codes', () => {
    expect(normalizeReferralCode(' abc234 ')).toBe('ABC234');
    expect(normalizeReferralCode('ABC23')).toBeNull();
    expect(normalizeReferralCode('ABCI00')).toBeNull(); // no I, O, 0 or 1 in codes
    expect(normalizeReferralCode(null)).toBeNull();
  });

  it('builds the invite and WhatsApp links', () => {
    expect(referralLink('ABC234')).toBe(`${window.location.origin}/?ref=ABC234`);
    expect(whatsappShareUrl('Join me: https://x.test/?ref=ABC234'))
      .toBe('https://wa.me/?text=Join%20me%3A%20https%3A%2F%2Fx.test%2F%3Fref%3DABC234');
  });

  it('keeps the code from an invite link and cleans the address bar', () => {
    window.history.replaceState(null, '', '/?ref=xyz789&open=sports#top');
    captureReferralFromUrl();
    expect(storedReferralCode()).toBe('XYZ789');
    expect(window.location.search).toBe('?open=sports');
    expect(window.location.hash).toBe('#top');
  });

  it('ignores a broken code but still cleans the address bar', () => {
    window.history.replaceState(null, '', '/?ref=nope');
    captureReferralFromUrl();
    expect(storedReferralCode()).toBeNull();
    expect(window.location.search).toBe('');
  });
});
