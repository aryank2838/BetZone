import { useEffect, useRef } from 'react';

/**
 * Calls `callback` every `intervalMs`, but only while the page is on screen.
 * Ticks are skipped while the app is in the background (saving Supabase
 * requests and egress), and the callback runs once as soon as the app comes
 * back into view so the data is fresh again.
 */
export function useVisibleInterval(callback: () => void, intervalMs: number, enabled = true) {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') latest.current();
    }, intervalMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
