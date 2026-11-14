/*
# Drop the "bet as much as you added" withdrawal rule

Deposits are credited to the betting balance (profiles.points) and only
winnings reach the withdrawable balance (profiles.wallet), which is the only
balance request_withdrawal() takes from. Deposited money therefore can never be
withdrawn, so the turnover requirement is no longer needed.

Setting turnover_multiplier to 0 switches the rule off in both places that read
it: request_withdrawal() and get_wallet_status(). Every other rule is
unchanged, including the 100-point approved deposit minimum, the 100 / 100000
withdrawal limits and one pending withdrawal at a time.
*/

CREATE OR REPLACE FUNCTION public.internal_rule_constants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN jsonb_build_object(
    'minimum_withdrawal', 100,
    'maximum_withdrawal', 100000,
    'approved_deposit_minimum', 100,
    'maximum_add_funds', 100000,
    'turnover_multiplier', 0,
    'maximum_bet', 5000,
    'maximum_submit', 20000,
    'current_terms_version', '2026-11-10'
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.internal_rule_constants() FROM PUBLIC, anon, authenticated;
