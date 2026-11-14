import { useCallback, useEffect, useState } from 'react';
import { friendlyErrorDetails } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { useVisibleInterval } from '@/lib/useVisibleInterval';

export interface MyLimits {
  daily_deposit_limit: number | null;
  daily_loss_limit: number | null;
  cooldown_until: string | null;
  self_excluded_until: string | null;
  pending_deposit_limit: number | null;
  pending_loss_limit: number | null;
  pending_effective_at: string | null;
  /** Today's (IST) stakes minus winnings. Missing until the 20261113 migration is applied. */
  today_net_loss?: number;
  /** Today's (IST) approved + pending deposits. Missing until the 20261113 migration is applied. */
  today_deposits?: number;
}

export function useMyLimits() {
  const [limits, setLimits] = useState<MyLimits | null>(null);
  const [error, setError] = useState<{ message: string; raw?: string } | null>(null);
  const refresh = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('get_my_limits');
    if (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setError({ message: friendly.message, raw: friendly.raw });
      return;
    }
    setLimits(data as MyLimits);
    setError(null);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useVisibleInterval(() => { void refresh(); }, 30_000);
  return { limits, error, refresh };
}

export function activePlayRestriction(limits: MyLimits | null) {
  const now = Date.now();
  if (limits?.self_excluded_until && Date.parse(limits.self_excluded_until) > now) {
    return { kind: 'self-exclusion' as const, until: limits.self_excluded_until };
  }
  if (limits?.cooldown_until && Date.parse(limits.cooldown_until) > now) {
    return { kind: 'cooldown' as const, until: limits.cooldown_until };
  }
  return null;
}

export function formatLimitEnd(value: string) {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' IST';
}
