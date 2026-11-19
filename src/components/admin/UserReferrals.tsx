import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { formatDate } from '@/i18n/format';
import { useFormat } from '@/i18n/useFormat';

interface ReferralFriendRow {
  id: string;
  display_name: string;
  joined_at: string;
  is_banned: boolean;
  status: 'paid' | 'capped' | 'too_small' | 'not_eligible' | null;
  reward: number;
  deposit_amount: number | null;
}

interface UserReferralData {
  code: string;
  invited_by: { id: string; display_name: string } | null;
  friends: ReferralFriendRow[];
  total_earned: number;
}

const STATUS_LABEL: Record<NonNullable<ReferralFriendRow['status']>, string> = {
  paid: 'Bonus paid',
  capped: 'Over the 30-day limit (no bonus)',
  too_small: 'First deposit too small (no bonus)',
  not_eligible: 'Inviter banned or admin (no bonus)',
};

/** Admin user page: who invited this player, and the friends they invited. */
export default function UserReferrals({ userId, onOpenUser }: { userId: string; onOpenUser?: (id: string) => void }) {
  const { formatNumber } = useFormat();
  const [data, setData] = useState<UserReferralData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data: result, error: rpcError } = await supabase.rpc('admin_user_referrals', { p_user_id: userId });
        if (rpcError) throw rpcError;
        if (active) setData(result as UserReferralData);
      } catch (caught) {
        if (!active) return;
        const friendly = friendlyErrorDetails(caught);
        setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      }
    })();
    return () => { active = false; };
  }, [userId]);

  const name = (value: string) => value || 'Unnamed user';
  const userLink = (id: string, label: string) => onOpenUser
    ? <button type="button" onClick={() => onOpenUser(id)} className="text-cyan-300 underline">{label}</button>
    : <span className="text-slate-200">{label}</span>;

  return (
    <section className="space-y-2 rounded-control border border-surface-border bg-surface p-4">
      <h4 className="font-semibold">Referrals</h4>
      {error ? <p role="alert" className="text-xs text-rose-300">{error}</p> : !data ? (
        <p className="text-xs text-ink-muted">Loading…</p>
      ) : (
        <>
          <p className="text-xs text-ink-muted">
            Invite code <span className="font-semibold tracking-widest text-slate-200">{data.code}</span>
            {' · '}Invited by {data.invited_by ? userLink(data.invited_by.id, name(data.invited_by.display_name)) : 'nobody'}
            {' · '}Bonus earned {formatNumber(data.total_earned)}
          </p>
          {data.friends.length === 0 ? (
            <p className="py-1 text-xs text-ink-muted">Has not invited anyone.</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {data.friends.map((friend) => (
                <div key={friend.id} className="flex items-start justify-between gap-3 py-2 text-xs">
                  <div className="min-w-0">
                    {userLink(friend.id, name(friend.display_name))}
                    {friend.is_banned && <span className="ml-2 text-rose-300">Banned</span>}
                    <span className="block text-ink-muted">Joined {formatDate(friend.joined_at, { dateStyle: 'medium' })}</span>
                  </div>
                  <div className="shrink-0 text-right text-ink-soft">
                    {friend.status ? (
                      <>
                        <span className={friend.status === 'paid' ? 'text-emerald-300' : 'text-amber-300'}>
                          {friend.status === 'paid' ? `+${formatNumber(friend.reward)}` : STATUS_LABEL[friend.status]}
                        </span>
                        {friend.deposit_amount !== null && (
                          <span className="block text-ink-muted">First deposit {formatNumber(friend.deposit_amount)}</span>
                        )}
                      </>
                    ) : <span className="text-ink-muted">No deposit yet</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-ink-muted">
            Watch for one person inviting their own extra accounts: same UPI payer name, joined minutes apart, or friends who stop after the first deposit.
          </p>
        </>
      )}
    </section>
  );
}
