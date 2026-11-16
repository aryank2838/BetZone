import { describe, expect, it } from 'vitest';
import { isInAppBrowser, isIosSafari } from './installPrompt';

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0.0';
const WHATSAPP = 'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 WhatsApp/2.24';
const FACEBOOK = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

describe('isInAppBrowser', () => {
  it('spots browsers inside other apps', () => {
    for (const ua of [WEBVIEW, INSTAGRAM, WHATSAPP, FACEBOOK]) expect(isInAppBrowser(ua)).toBe(true);
  });
  it('leaves normal browsers alone', () => {
    expect(isInAppBrowser(CHROME_ANDROID)).toBe(false);
    expect(isInAppBrowser(IOS_SAFARI)).toBe(false);
  });
});

describe('isIosSafari', () => {
  it('is true for iPhone Safari and false for Android Chrome', () => {
    expect(isIosSafari(IOS_SAFARI)).toBe(true);
    expect(isIosSafari(CHROME_ANDROID)).toBe(false);
  });
});
