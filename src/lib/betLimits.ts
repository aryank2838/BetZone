import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/** Rule values the server exposes through get_public_rules (see internal_rule_constants). */
export interface PublicRules {
  minimum_withdrawal: number;
  maximum_withdrawal: number;
  approved_deposit_minimum: number;
  maximum_add_funds: number;
  turnover_multiplier: number;
  maximum_bet: number;
  maximum_submit: number;
}

export interface BetLimits {
  maxPerBet: number;
  maxPerSubmit: number;
  quickStakes: readonly number[];
}

/** UI-only quick-pick stake buttons. */
export const QUICK_STAKES = [10, 50, 100, 500] as const;

/**
 * Used only until get_public_rules answers (or if it fails). The database
 * enforces the real limits either way, so these are never trusted for safety.
 */
export const FALLBACK_BET_LIMITS: BetLimits = {
  maxPerBet: 5000,
  maxPerSubmit: 20000,
  quickStakes: QUICK_STAKES,
};

let rulesRequest: Promise<PublicRules | null> | null = null;

function isPublicRules(value: unknown): value is PublicRules {
  if (!value || typeof value !== 'object') return false;
  const rules = value as Record<string, unknown>;
  return typeof rules.maximum_bet === 'number' && typeof rules.maximum_submit === 'number';
}

/** Fetches get_public_rules once per page load and shares the result. */
export function fetchPublicRules(): Promise<PublicRules | null> {
  if (!rulesRequest) {
    rulesRequest = Promise.resolve(supabase.rpc('get_public_rules'))
      .then(({ data, error }) => {
        if (error || !isPublicRules(data)) {
          rulesRequest = null;
          return null;
        }
        return data;
      })
      .catch(() => {
        rulesRequest = null;
        return null;
      });
  }
  return rulesRequest;
}

/** Test helper: forget the cached rules. */
export function resetPublicRulesCache() {
  rulesRequest = null;
}

export function betLimitsFromRules(rules: PublicRules | null): BetLimits {
  if (!rules) return FALLBACK_BET_LIMITS;
  return { maxPerBet: rules.maximum_bet, maxPerSubmit: rules.maximum_submit, quickStakes: QUICK_STAKES };
}

export function usePublicRules(): PublicRules | null {
  const [rules, setRules] = useState<PublicRules | null>(null);
  useEffect(() => {
    let active = true;
    void fetchPublicRules().then((result) => {
      if (active) setRules(result);
    });
    return () => { active = false; };
  }, []);
  return rules;
}

export function useBetLimits(): BetLimits {
  return betLimitsFromRules(usePublicRules());
}
