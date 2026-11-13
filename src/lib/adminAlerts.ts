/** Sound and browser-notification helpers for live admin alerts. */

const SOUND_KEY = 'betzone_admin_sound';

export function readSoundEnabled(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}

export function writeSoundEnabled(enabled: boolean) {
  try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch { /* storage blocked */ }
}

let audioContext: AudioContext | null = null;

/** A short two-tone chime made with Web Audio, so no sound file is needed. */
export function playAlertSound() {
  try {
    const Context = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audioContext ??= new Context();
    const context = audioContext;
    if (context.state === 'suspended') void context.resume();
    const start = context.currentTime;
    [880, 1320].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * 0.18;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.32);
    });
  } catch {
    // Audio can be unavailable (no user gesture yet, unsupported browser).
  }
}

export type NotificationState = NotificationPermission | 'unsupported';

export function notificationState(): NotificationState {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (notificationState() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationState();
  }
}

/**
 * Shows a system notification. Android Chrome only allows notifications from a
 * service worker, so that is tried first; desktop browsers fall back to
 * `new Notification`.
 */
export async function showSystemNotification(title: string, body: string, onClick?: () => void) {
  if (notificationState() !== 'granted') return;
  const options: NotificationOptions = { body, icon: '/icon-192.png', badge: '/icon-192.png', tag: 'betzone-admin-request' };
  try {
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Notifications can still fail (e.g. OS-level block); the in-app badge remains.
  }
}
