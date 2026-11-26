/*
# Remove a partner

admin_remove_partner(p_user_id) turns a partner back into a normal player:
- Finished weeks are closed first. If any week is still unpaid ('due'), the
  removal is refused: pay and mark those weeks paid first.
- The current, unfinished week earns nothing.
- Their players lose the partner tag (profiles.partner_id → NULL via the FK)
  and count as the house's again.
- Their partner_weeks rows are deleted. A snapshot of every paid week (amount,
  UTR, date) is kept in admin_action_log so the payment record survives.
- From now on they are a normal player again, so the normal referral bonus
  applies to future first deposits of people they invite.
*/

ALTER TABLE public.admin_action_log
  DROP CONSTRAINT IF EXISTS admin_action_log_action_check;
ALTER TABLE public.admin_action_log
  ADD CONSTRAINT admin_action_log_action_check
  CHECK (action IN (
    'ban', 'unban', 'grant_admin', 'revoke_admin',
    'adjust_points', 'adjust_wallet',
    'approve_withdrawal', 'reject_withdrawal',
    'approve_add_funds', 'reject_add_funds',
    'post_open_result', 'post_close_result', 'set_setting',
    'close_support_ticket', 'add_blocked_domain',
    'set_holiday', 'end_holiday',
    'set_sport_settings', 'void_sport_event', 'settle_sport_event',
    'verify_email',
    'save_partner', 'pause_partner', 'assign_player_partner', 'partner_week_paid',
    'remove_partner'
  ));

CREATE OR REPLACE FUNCTION public.admin_remove_partner(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_partner public.partners%ROWTYPE;
  v_due bigint;
  v_players integer;
  v_paid jsonb;
  v_paid_total bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  -- Close finished weeks first, so a week that just ended is checked for money owed.
  PERFORM public.close_partner_weeks();
  SELECT * INTO v_partner FROM public.partners WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partner not found'; END IF;

  SELECT COALESCE(SUM(share), 0) INTO v_due
  FROM public.partner_weeks WHERE partner_id = p_user_id AND status = 'due';
  IF v_due > 0 THEN
    RAISE EXCEPTION 'You still owe this partner ₹% for finished weeks. Pay and mark those weeks paid first.', v_due;
  END IF;

  SELECT count(*) INTO v_players
  FROM public.profiles WHERE partner_id = p_user_id AND id <> p_user_id AND NOT is_admin;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'week_start', w.week_start, 'share', w.share, 'share_percent', w.share_percent,
      'paid_at', w.paid_at, 'paid_utr', w.paid_utr
    ) ORDER BY w.week_start), '[]'::jsonb),
    COALESCE(SUM(w.share), 0)
  INTO v_paid, v_paid_total
  FROM public.partner_weeks w WHERE w.partner_id = p_user_id AND w.status = 'paid';

  DELETE FROM public.partner_weeks WHERE partner_id = p_user_id;
  -- profiles.partner_id is ON DELETE SET NULL: their players are untagged here.
  DELETE FROM public.partners WHERE user_id = p_user_id;

  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (auth.uid(), 'remove_partner', jsonb_build_object(
    'user_id', p_user_id,
    'share_percent', v_partner.share_percent,
    'was_active', v_partner.active,
    'first_week', v_partner.first_week,
    'partner_since', v_partner.created_at,
    'payout_upi', v_partner.payout_upi,
    'players_untagged', v_players,
    'paid_total', v_paid_total,
    'paid_weeks', v_paid
  ));
  RETURN jsonb_build_object('user_id', p_user_id, 'players_untagged', v_players, 'paid_total', v_paid_total);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_remove_partner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remove_partner(uuid) TO authenticated;
