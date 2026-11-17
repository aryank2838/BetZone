import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { isStandalone } from '@/lib/installPrompt';
import type { Language } from '@/i18n/context';

/**
 * Public VAPID key (safe to publish). The matching private key is only in the
 * send-push Edge Function secrets (VAPID_PRIVATE_KEY). If the pair is ever
 * replaced, update both, and devices re-subscribe the next time they open the app.
 */
export const VAPID_PUBLIC_KEY = 'BJjwSlCAL3pcacSaZ-mMFDyrRW1q01mLIQ6089fhf_V_Rbf845qSZiXrn5Rcyn7GCn8V8CnN72-CAfW8anL7t4k';

export type PushState = 'loading' | 'unsupported' | 'ios-install' | 'blocked' | 'off' | 'on';

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(key: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!key) return false;
  const actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (/macintosh/i.test(navigator.userAgent) && typeof document !== 'undefined' && 'ontouchend' in document);
}

function pushApisAvailable(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!pushApisAvailable()) return undefined;
  // The service worker is only registered in production builds.
  return navigator.serviceWorker.getRegistration();
}

export async function readPushState(): Promise<PushState> {
  if (!pushApisAvailable()) return isIosDevice() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const registration = await getRegistration();
  if (!registration) return 'unsupported';
  const subscription = await registration.pushManager.getSubscription();
  return subscription && Notification.permission === 'granted' ? 'on' : 'off';
}

async function saveSubscription(subscription: PushSubscription, language: Language) {
  const json = subscription.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys?.p256dh,
    p_auth: json.keys?.auth,
    p_language: language,
  });
  if (error) throw error;
}

/** Asks for permission (must run from a tap) and subscribes this device. */
export async function enablePush(language: Language): Promise<PushState> {
  const registration = await getRegistration();
  if (!registration) return readPushState();
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';

  const key = base64UrlToBytes(VAPID_PUBLIC_KEY);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(subscription, language);
  return 'on';
}

/** Turns notifications off for this device (server row and browser subscription). */
export async function disablePush(): Promise<void> {
  const registration = await getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const { error } = await supabase.rpc('delete_push_subscription', { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe();
  if (error) throw error;
}

/**
 * Keeps the server copy of this device's subscription current: browsers can
 * rotate subscriptions, and the notification language follows the app's.
 */
export async function syncPush(language: Language): Promise<void> {
  if (!pushApisAvailable() || Notification.permission !== 'granted') return;
  const registration = await getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  if (!sameKey(subscription.options.applicationServerKey, base64UrlToBytes(VAPID_PUBLIC_KEY))) {
    // Key was replaced: subscribe again with the new one.
    await enablePush(language);
    return;
  }
  await saveSubscription(subscription, language);
}

/** State and actions for a "Turn on notifications" control. */
export function usePushNotifications(language: Language) {
  const [state, setState] = useState<PushState>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    readPushState()
      .then((next) => { if (active) setState(next); })
      .catch(() => { if (active) setState('unsupported'); });
    return () => { active = false; };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const next = await enablePush(language);
      setState(next);
      return next;
    } finally {
      setBusy(false);
    }
  }, [language]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await disablePush();
      setState(await readPushState());
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, enable, disable };
}
