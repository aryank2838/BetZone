import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { interpolate, useT } from '@/i18n/useT';
import { useFormat } from '@/i18n/useFormat';

export interface MoneyNotice {
  id: string;
  kind: 'deposit' | 'withdrawal';
  amount: number;
  status: 'approved' | 'rejected';
  reject_reason: string | null;
  processed_at: string;
}

type NoticeRow = Omit<MoneyNotice, 'kind'>;

const MESSAGE_KEY = {
  deposit: { approved: 'notices.depositApproved', rejected: 'notices.depositRejected' },
  withdrawal: { approved: 'notices.withdrawalApproved', rejected: 'notices.withdrawalRejected' },
} as const;

/** Text for one notice, e.g. "₹500 added to your balance". */
export function useNoticeText() {
  const { t } = useT();
  const { formatNumber } = useFormat();
  return (notice: MoneyNotice) => interpolate(t(MESSAGE_KEY[notice.kind][notice.status]), { amount: `₹${formatNumber(notice.amount)}` });
}
const COLUMNS = 'id, amount, status, reject_reason, processed_at';

/** Push tags of the money notifications (see send-push/messages.ts). */
const MONEY_PUSH_TAGS = new Set(['deposit_approved', 'deposit_rejected', 'withdrawal_approved', 'withdrawal_rejected']);

/**
 * Removes this app's money notifications from the phone's notification tray.
 * Called when the app is opened: the Home card shows the same news, so a
 * notification the player never tapped should not stay in the tray.
 */
export async function clearMoneyNotifications(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.getNotifications) return;
    const shown = await registration.getNotifications();
    for (const notification of shown) {
      if (notification.tag && MONEY_PUSH_TAGS.has(notification.tag)) notification.close();
    }
  } catch { /* the tray is best effort */ }
}

const dismissedKey = (userId: string) => `betzone_notices_dismissed_${userId}`;

function readDismissed(userId: string): string | null {
  try { return localStorage.getItem(dismissedKey(userId)); } catch { return null; }
}

function saveDismissed(userId: string, until: string) {
  try { localStorage.setItem(dismissedKey(userId), until); } catch { /* private mode */ }
}

/** Later of two ISO times (null-safe). */
function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Newest first, one entry per request. */
export function mergeNotices(deposits: NoticeRow[], withdrawals: NoticeRow[]): MoneyNotice[] {
  return [
    ...deposits.map((row) => ({ ...row, kind: 'deposit' as const })),
    ...withdrawals.map((row) => ({ ...row, kind: 'withdrawal' as const })),
  ].sort((a, b) => Date.parse(b.processed_at) - Date.parse(a.processed_at));
}

/**
 * Tells players what happened to their money: requests approved or rejected
 * since they last dismissed these notices. "Last seen" is stored on the
 * profile, so a notice shows once per account, not once per device. Updates
 * arrive live through Supabase Realtime, with a refresh when the app regains
 * focus. If the database migration is missing, nothing is shown.
 */
export function useMoneyNotices(onNew?: (notices: MoneyNotice[]) => void) {
  const { user, refreshProfile } = useAuth();
  const userId = user?.id ?? null;
  const [notices, setNotices] = useState<MoneyNotice[]>([]);
  const known = useRef<Set<string> | null>(null);
  const callbacks = useRef({ onNew, refreshProfile });
  callbacks.current = { onNew, refreshProfile };

  const load = useCallback(async () => {
    if (!userId) return;
    const profile = await supabase.from('profiles').select('money_notices_seen_at').eq('id', userId).maybeSingle();
    const serverSeenAt = (profile.data as { money_notices_seen_at?: string } | null)?.money_notices_seen_at;
    if (profile.error || !serverSeenAt) return;
    // A dismissal on this phone that the server did not save (bad network) still counts,
    // and is sent again so other devices catch up.
    const localSeenAt = readDismissed(userId);
    const seenAt = laterOf(serverSeenAt, localSeenAt) ?? serverSeenAt;
    if (localSeenAt && seenAt !== serverSeenAt) {
      void supabase.rpc('mark_money_notices_seen', { p_until: localSeenAt });
    }
    const [deposits, withdrawals] = await Promise.all([
      supabase.from('add_funds_requests').select(COLUMNS).eq('user_id', userId)
        .in('status', ['approved', 'rejected']).gt('processed_at', seenAt).order('processed_at', { ascending: false }).limit(20),
      supabase.from('withdrawals').select(COLUMNS).eq('user_id', userId)
        .in('status', ['approved', 'rejected']).gt('processed_at', seenAt).order('processed_at', { ascending: false }).limit(20),
    ]);
    if (deposits.error || withdrawals.error) return;
    // A load that started before the player tapped "Got it" must not bring the card back.
    const dismissedUntil = readDismissed(userId);
    const next = mergeNotices((deposits.data ?? []) as NoticeRow[], (withdrawals.data ?? []) as NoticeRow[])
      .filter((notice) => !dismissedUntil || Date.parse(notice.processed_at) > Date.parse(dismissedUntil));
    const previous = known.current;
    known.current = new Set(next.map((notice) => `${notice.kind}:${notice.id}`));
    if (previous) {
      const fresh = next.filter((notice) => !previous.has(`${notice.kind}:${notice.id}`));
      if (fresh.length > 0) {
        void callbacks.current.refreshProfile();
        callbacks.current.onNew?.(fresh);
      }
    }
    setNotices(next);
  }, [userId]);

  useEffect(() => {
    known.current = null;
    setNotices([]);
    void load();
    void clearMoneyNotifications();
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
      void clearMoneyNotifications();
    };
    document.addEventListener('visibilitychange', onVisible);
    const filter = `user_id=eq.${userId}`;
    const channel = supabase
      .channel(`money-notices-${userId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'add_funds_requests', filter }, () => { void load(); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'withdrawals', filter }, () => { void load(); })
      .subscribe();
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [userId, load]);

  const dismiss = useCallback(async () => {
    const newest = notices[0]?.processed_at;
    setNotices([]);
    void clearMoneyNotifications();
    if (!newest || !userId) return;
    // Saved on the phone first, so the card stays gone even if the server call fails.
    saveDismissed(userId, laterOf(readDismissed(userId), newest) ?? newest);
    try {
      const { error } = await supabase.rpc('mark_money_notices_seen', { p_until: newest });
      if (error) console.error('Could not save that money notices were seen', error);
    } catch (error) {
      console.error('Could not save that money notices were seen', error);
    }
  }, [notices, userId]);

  return { notices, dismiss };
}
