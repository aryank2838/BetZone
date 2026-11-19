import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Gift, Share2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { referralLink, whatsappShareUrl } from '@/lib/referral';
import { useToast } from '@/components/ui/toastContext';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

export interface ReferralFriend {
  name: string;
  joined_at: string;
  status: 'paid' | 'capped' | 'too_small' | 'not_eligible' | null;
  reward: number;
}

export interface MyReferral {
  code: string;
  rules: { percent: number; max_reward: number; min_deposit: number; max_friends_per_30_days: number };
  friends_joined: number;
  friends_rewarded: number;
  total_earned: number;
  friends: ReferralFriend[];
}

const FRIEND_STATUS: Record<Exclude<ReferralFriend['status'], 'paid' | null>, TranslationKey> = {
  capped: 'referral.statusCapped',
  too_small: 'referral.statusTooSmall',
  not_eligible: 'referral.statusNotEligible',
};

/** Home screen: the player's invite link, how to share it, and what it earned. */
export default function ReferralCard() {
  const { t } = useT();
  const { formatNumber, formatDate } = useFormat();
  const toast = useToast();
  const [data, setData] = useState<MyReferral | null>(null);
  const [showFriends, setShowFriends] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data: result, error } = await supabase.rpc('get_my_referral');
        if (active && !error && result) setData(result as MyReferral);
      } catch {
        // The card is extra: without it the home screen still works.
      }
    })();
    return () => { active = false; };
  }, []);

  if (!data) return null;

  const link = referralLink(data.code);
  const rupees = (value: number) => `₹${formatNumber(value)}`;
  const shareText = interpolate(t('referral.shareText'), { link, code: data.code });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.show(t('referral.copied'), 'success');
    } catch {
      toast.show(interpolate(t('referral.copyFailed'), { link }), 'info');
    }
  };

  const friendStatus = (friend: ReferralFriend) => {
    if (friend.status === 'paid') return interpolate(t('referral.statusPaid'), { amount: rupees(friend.reward) });
    if (friend.status === null) return t('referral.statusWaiting');
    return interpolate(t(FRIEND_STATUS[friend.status]), { min: rupees(data.rules.min_deposit) });
  };

  return (
    <section aria-labelledby="referral-title" className="space-y-4 rounded-card border border-emerald-500/30 bg-gradient-to-br from-emerald-950/60 to-cyan-950/40 p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-300" aria-hidden="true">
          <Gift className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="referral-title" className="text-base font-semibold text-ink-strong">{t('referral.title')}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            {interpolate(t('referral.pitch'), { percent: data.rules.percent, max: rupees(data.rules.max_reward) })}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-control border border-surface-strong bg-surface-page/60 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-ink-muted">{t('referral.yourCode')}</p>
          <p className="text-lg font-bold tracking-[0.3em] text-emerald-300">{data.code}</p>
        </div>
        <button
          type="button"
          onClick={() => void copyLink()}
          className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-control border border-surface-strong px-3 text-sm font-semibold text-ink-strong hover:border-emerald-400"
        >
          <Copy className="h-4 w-4" aria-hidden="true" /> {t('referral.copyLink')}
        </button>
      </div>

      <a
        href={whatsappShareUrl(shareText)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-control bg-[#25D366] px-4 text-sm font-bold text-slate-950 hover:brightness-110"
      >
        <Share2 className="h-4 w-4" aria-hidden="true" /> {t('referral.shareWhatsapp')}
      </a>

      <dl className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-control bg-surface-page/50 px-2 py-2">
          <dt className="text-[11px] text-ink-muted">{t('referral.friendsJoined')}</dt>
          <dd className="text-lg font-bold tabular-nums text-ink-strong">{formatNumber(data.friends_joined)}</dd>
        </div>
        <div className="rounded-control bg-surface-page/50 px-2 py-2">
          <dt className="text-[11px] text-ink-muted">{t('referral.earned')}</dt>
          <dd className="text-lg font-bold tabular-nums text-emerald-300">{rupees(data.total_earned)}</dd>
        </div>
      </dl>

      {data.friends.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowFriends((value) => !value)}
            aria-expanded={showFriends}
            className="flex w-full items-center justify-between text-sm font-semibold text-ink-soft"
          >
            {t('referral.seeFriends')}
            {showFriends ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showFriends && (
            <ul className="mt-2 divide-y divide-surface-border">
              {data.friends.map((friend, index) => (
                <li key={`${friend.joined_at}-${index}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-ink-strong">
                    {friend.name}
                    <span className="ml-2 text-xs text-ink-muted">{formatDate(friend.joined_at, { day: 'numeric', month: 'short' })}</span>
                  </span>
                  <span className={`shrink-0 text-xs ${friend.status === 'paid' ? 'font-semibold text-emerald-300' : 'text-ink-muted'}`}>
                    {friendStatus(friend)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-muted">
        {interpolate(t('referral.rules'), {
          min: rupees(data.rules.min_deposit),
          friends: data.rules.max_friends_per_30_days,
        })}
      </p>
    </section>
  );
}
