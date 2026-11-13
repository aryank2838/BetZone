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
    const seenAt = (profile.data as { money_notices_seen_at?: string } | null)?.money_notices_seen_at;
    if (profile.error || !seenAt) return;
    const [deposits, withdrawals] = await Promise.all([
      supabase.from('add_funds_requests').select(COLUMNS).eq('user_id', userId)
        .in('status', ['approved', 'rejected']).gt('processed_at', seenAt).order('processed_at', { ascending: false }).limit(20),
      supabase.from('withdrawals').select(COLUMNS).eq('user_id', userId)
        .in('status', ['approved', 'rejected']).gt('processed_at', seenAt).order('processed_at', { ascending: false }).limit(20),
    ]);
    if (deposits.error || withdrawals.error) return;
    const next = mergeNotices((deposits.data ?? []) as NoticeRow[], (withdrawals.data ?? []) as NoticeRow[]);
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
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
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
    if (!newest) return;
    const { error } = await supabase.rpc('mark_money_notices_seen', { p_until: newest });
    if (error) console.error('Could not save that money notices were seen', error);
  }, [notices]);

  return { notices, dismiss };
}
