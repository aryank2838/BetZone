import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';

/** One week's numbers. Net = bets − wins − bonuses; the share applies to net + carry_in. */
export interface PartnerWeekNumbers {
  week_start: string;
  week_end: string;
  bets: number;
  wins: number;
  bonuses: number;
  net: number;
  carry_in: number;
  share_percent: number;
}

export interface PartnerLiveWeek extends PartnerWeekNumbers {
  projected_share: number;
}

export type PartnerWeekStatus = 'due' | 'paid' | 'nothing_due';

export interface PartnerClosedWeek extends PartnerWeekNumbers {
  id?: string;
  carry_out: number;
  share: number;
  status: PartnerWeekStatus;
  paid_at: string | null;
  paid_utr: string | null;
}

export interface PartnerPlayer {
  name: string;
  joined_at: string;
  bets: number;
  wins: number;
  net: number;
  last_active: string | null;
}

export interface PartnerDashboard {
  code: string;
  share_percent: number;
  active: boolean;
  payout_upi: string | null;
  player_count: number;
  week: PartnerLiveWeek;
  players: PartnerPlayer[];
  weeks: PartnerClosedWeek[];
}

export const UPI_PATTERN = /^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$/;

/** True when the signed-in user has a partner row (RLS only shows their own). */
export function useIsPartner(userId: string | null | undefined, enabled = true): boolean {
  const [isPartner, setIsPartner] = useState(false);
  useEffect(() => {
    let active = true;
    if (!userId || !enabled) {
      setIsPartner(false);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const { data, error } = await supabase.from('partners').select('user_id').eq('user_id', userId).maybeSingle();
        if (active) setIsPartner(!error && Boolean(data));
      } catch {
        if (active) setIsPartner(false);
      }
    })();
    return () => { active = false; };
  }, [userId, enabled]);
  return isPartner;
}

export function usePartnerDashboard() {
  const [data, setData] = useState<PartnerDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; raw?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: result, error: rpcError } = await supabase.rpc('get_my_partner_dashboard');
      if (rpcError) throw rpcError;
      setData((result as PartnerDashboard | null) ?? null);
      setError(null);
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setError({ message: friendly.message, raw: friendly.raw });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { data, loading, error, reload: load };
}

/** "24 Nov – 29 Nov" style label for a Monday–Saturday week. */
export function weekLabel(weekStart: string, weekEnd: string, locale: string): string {
  const format = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return `${format(weekStart)} – ${format(weekEnd)}`;
}
