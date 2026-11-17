/*
Remove the last trace of the old ad rewards feature.

The ad_rewards table and its functions were dropped earlier
(20261109114629, 20261109150000). 'ad_reward' was still allowed as a ledger
reason in case old rows existed; production has none, so it is removed.
The check below stops the migration if any such row exists.
*/
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.point_ledger WHERE reason = 'ad_reward') THEN
    RAISE EXCEPTION 'point_ledger still has ad_reward rows; review them before removing the reason';
  END IF;
END
$$;

ALTER TABLE public.point_ledger DROP CONSTRAINT IF EXISTS point_ledger_reason_valid;
ALTER TABLE public.point_ledger
  ADD CONSTRAINT point_ledger_reason_valid CHECK (reason IN (
    'signup_bonus', 'first_deposit_bonus', 'selection_submit', 'winning_payout',
    'withdrawal_request', 'withdrawal_refund', 'add_funds',
    'admin_adjust_points', 'admin_adjust_wallet', 'bet_refund'
  ));
