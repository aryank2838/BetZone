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
  /** True when the percent comes from the levels, not a fixed percent. */
  uses_levels?: boolean;
  /** The next level up (the profit it starts at, and its percent), if there is one. */
  next_level_min?: number | null;
  next_level_percent?: number | null;
}

/** One level: a week's profit from min_profit (whole rupees) up pays percent. */
export interface PartnerLevel {
  min_profit: number;
  percent: number;
}

/** "₹0 – ₹1,000", "₹1,001 – ₹2,000", "₹2,001+" for each level, in order. */
export function levelRanges(levels: PartnerLevel[], formatNumber: (value: number) => string): Array<{ label: string; percent: number }> {
  return levels.map((level, index) => {
    const next = levels[index + 1];
    const from = `₹${formatNumber(level.min_profit)}`;
    return { label: next ? `${from} – ₹${formatNumber(next.min_profit - 1)}` : `${from}+`, percent: level.percent };
  });
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
  /** This week's percent: the current level, or the fixed percent. */
  share_percent: number;
  uses_levels?: boolean;
  levels?: PartnerLevel[];
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
