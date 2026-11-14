import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/components/ui/toastContext';
import { interpolate, useT } from '@/i18n/useT';
import { useFormat } from '@/i18n/useFormat';
import { titleWithCount } from '@/lib/adminOverview';
import {
  notificationState, playAlertSound, readSoundEnabled, requestNotificationPermission,
  showSystemNotification, writeSoundEnabled, type NotificationState,
} from '@/lib/adminAlerts';
import { useVisibleInterval } from '@/lib/useVisibleInterval';
import { useScreenshotCleanup } from '@/lib/screenshotCleanup';
import { AdminAlertsContext, istToday, type AdminAlertsValue, type PendingStats } from '@/lib/adminAlertsContext';

const BASE_TITLE = 'BetZone';

/**
 * Admin-only: keeps the waiting-request count up to date through Supabase
 * Realtime, and on each new request plays a chime, shows a system notification
 * when the tab is in the background, and puts the count in the tab title.
 * Polls every minute as a fallback if the live connection drops.
 */
export default function AdminAlertsProvider({ children, onOpenRequests }: { children: ReactNode; onOpenRequests: () => void }) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const toast = useToast();
  const [stats, setStats] = useState<PendingStats | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState(false);
  const [notifications, setNotifications] = useState<NotificationState>(notificationState);
  const [soundEnabled, setSoundState] = useState(readSoundEnabled);

  // Event handlers below are registered once; refs give them current values.
  const latest = useRef({ t, formatNumber, toast, soundEnabled, onOpenRequests });
  latest.current = { t, formatNumber, toast, soundEnabled, onOpenRequests };

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_get_stats', { p_round_date: istToday() });
    if (error || !data) {
      setFailed(true);
      return;
    }
    setStats(data as PendingStats);
    setFailed(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  // Fallback poll; the live connection below keeps working in the background.
  useVisibleInterval(() => { void refresh(); }, 60_000);
  useScreenshotCleanup();

  useEffect(() => {
    let reloadTimer: number | undefined;
    const scheduleReload = () => {
      window.clearTimeout(reloadTimer);
      // Several rows can change at once (e.g. bulk approval); reload once.
      reloadTimer = window.setTimeout(() => {
        setVersion((value) => value + 1);
        void refresh();
      }, 400);
    };
    const announce = (kind: 'deposit' | 'withdrawal', row: Record<string, unknown>) => {
      const { t: translate, formatNumber: format, toast: toastApi, soundEnabled: sound, onOpenRequests: open } = latest.current;
      const amount = typeof row.amount === 'number' ? `₹${format(row.amount)}` : '';
      const title = translate(kind === 'deposit' ? 'adminAlerts.newDeposit' : 'adminAlerts.newWithdrawal');
      const body = interpolate(translate('adminAlerts.body'), { amount });
      if (sound) playAlertSound();
      if (document.visibilityState === 'hidden') void showSystemNotification(title, body, open);
      else toastApi.show(`${title} · ${amount}`, 'info');
    };
    const onChange = (kind: 'deposit' | 'withdrawal') => (payload: { eventType: string; new: Record<string, unknown> }) => {
      if (payload.eventType === 'INSERT' && payload.new?.status === 'pending') announce(kind, payload.new);
      scheduleReload();
    };
    const channel = supabase
      .channel('admin-request-alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'add_funds_requests' }, onChange('deposit'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawals' }, onChange('withdrawal'))
      .subscribe((status) => {
        setLive(status === 'SUBSCRIBED');
        // Catch anything that arrived while the connection was down.
        if (status === 'SUBSCRIBED') scheduleReload();
      });
    return () => {
      window.clearTimeout(reloadTimer);
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  // Clicking a notification shown by the service worker opens the Requests tab.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'open-admin-requests') latest.current.onOpenRequests();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  const waiting = stats ? stats.pending_addfunds_count + stats.pending_withdrawals_count : 0;

  useEffect(() => {
    document.title = titleWithCount(BASE_TITLE, waiting);
  }, [waiting]);
  useEffect(() => () => { document.title = BASE_TITLE; }, []);

  const enableNotifications = useCallback(async () => {
    setNotifications(await requestNotificationPermission());
    // The click is a user gesture, which also unlocks audio for later alerts.
    if (latest.current.soundEnabled) playAlertSound();
  }, []);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    writeSoundEnabled(enabled);
    setSoundState(enabled);
    if (enabled) playAlertSound();
  }, []);

  const value = useMemo<AdminAlertsValue>(() => ({
    stats, failed, waiting, version, live, notifications, enableNotifications, soundEnabled, setSoundEnabled, refresh,
  }), [stats, failed, waiting, version, live, notifications, enableNotifications, soundEnabled, setSoundEnabled, refresh]);

  return <AdminAlertsContext.Provider value={value}>{children}</AdminAlertsContext.Provider>;
}
