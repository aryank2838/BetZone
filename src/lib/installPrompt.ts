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

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

export function useInstallPrompt() {
  const [, setTick] = useState(0);
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const standalone = isStandalone();
  const mode: 'prompt' | 'ios' | null = standalone || dismissed ? null : deferred ? 'prompt' : isIosSafari() ? 'ios' : null;

  const install = async () => {
    const event = deferred;
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice;
    deferred = null;
    if (choice.outcome === 'dismissed') dismiss();
    notify();
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage blocked */ }
    setDismissed(true);
  };

  return { mode, install, dismiss };
}
