import { useEffect, useState } from 'react';

/** Chrome/Edge/Samsung's install event (not in the TypeScript DOM types). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'betzone_install_dismissed';
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/**
 * Call once at startup, before React renders: the browser can fire
 * beforeinstallprompt before any component mounts.
 */
export function captureInstallPrompt() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // show our own banner instead of the mini-infobar
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** Registers the service worker (production only) so the app is installable. */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('Service worker registration failed', error);
    });
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone/iPad Safari: no install event, the user must use Share → Add to Home Screen. */
export function isIosSafari(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  const ios = /iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && typeof document !== 'undefined' && 'ontouchend' in document);
  const otherBrowser = /crios|fxios|edgios|opios/i.test(userAgent);
  return ios && !otherBrowser;
}

/**
 * Browsers built into other apps (WhatsApp, Instagram, Facebook, Android
 * WebViews) cannot install web apps; the player has to open the link in Chrome.
 */
export function isInAppBrowser(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|Snapchat|; wv\)/i.test(userAgent);
}

/** Re-renders the caller when the browser's install offer appears or goes away. */
function useInstallEvents() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
}

async function promptInstall(): Promise<'accepted' | 'dismissed' | null> {
  const event = deferred;
  if (!event) return null;
  await event.prompt();
  const choice = await event.userChoice;
  deferred = null;
  notify();
  return choice.outcome;
}

/**
 * For the Account page: always available, whatever the Home banner's
 * "Not now" said. 'installed' when running as the installed app.
 */
export function useInstallOptions() {
  useInstallEvents();
  const mode: 'installed' | 'prompt' | 'ios' | 'in-app' | 'manual' = isStandalone() ? 'installed'
    : deferred ? 'prompt'
      : isInAppBrowser() ? 'in-app'
        : isIosSafari() ? 'ios'
          : 'manual';
  return { mode, install: promptInstall };
}

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

export function useInstallPrompt() {
  useInstallEvents();
  const [dismissed, setDismissed] = useState(readDismissed);

  const standalone = isStandalone();
  const mode: 'prompt' | 'ios' | null = standalone || dismissed ? null : deferred ? 'prompt' : isIosSafari() ? 'ios' : null;

  const install = async () => {
    if (await promptInstall() === 'dismissed') dismiss();
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage blocked */ }
    setDismissed(true);
  };

  return { mode, install, dismiss };
}

/** Where the Android app (APK) is published, next to the website. */
export const ANDROID_APK_PATH = '/downloads/betzone.apk';

export function isAndroid(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /android/i.test(userAgent);
}

let apkCheck: Promise<boolean> | null = null;

/**
 * Is the APK really on the server? The site sends index.html (200) for any
 * unknown path, so a missing file is caught by its content type. Checked once
 * per page load, so the button never links to a file that is not there.
 */
export function checkAndroidApk(fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!apkCheck) {
    apkCheck = fetcher(ANDROID_APK_PATH, { method: 'HEAD', cache: 'no-store' })
      .then((response) => response.ok && !(response.headers.get('content-type') ?? '').includes('text/html'))
      .catch(() => false);
  }
  return apkCheck;
}

/** For tests. */
export function resetAndroidApkCheck() {
  apkCheck = null;
}

/** True on an Android phone's browser when the APK can be downloaded. */
export function useAndroidApk(): boolean {
  const eligible = isAndroid() && !isStandalone();
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    void checkAndroidApk().then((ok) => { if (active) setAvailable(ok); });
    return () => { active = false; };
  }, [eligible]);
  return eligible && available;
}
