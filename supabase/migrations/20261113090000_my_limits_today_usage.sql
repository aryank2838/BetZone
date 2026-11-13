-- Show players how much of their daily limits they have used today (IST), so
-- the home screen can display e.g. "Today: ₹200 of ₹1,000 loss limit".
-- The two sums use exactly the same rules the limits are enforced with:
--   * net loss: submit_selection (stakes minus winnings, today IST)
--   * deposits: request_add_funds (approved + pending requests, today IST)
-- Return shape is a superset of the previous version, so older clients keep working.

CREATE OR REPLACE FUNCTION public.get_my_limits()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_limits public.user_limits%ROWTYPE;
  v_day_start timestamptz;
  v_today_net_loss bigint;
  v_today_deposits bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  PERFORM public.apply_pending_user_limits(v_uid);
  INSERT INTO public.user_limits (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_limits FROM public.user_limits WHERE user_id = v_uid;

  v_day_start := ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');

  SELECT COALESCE(SUM(CASE WHEN reason = 'selection_submit' THEN -delta::bigint
                           WHEN reason = 'winning_payout' THEN -delta::bigint ELSE 0 END), 0)
  INTO v_today_net_loss
  FROM public.point_ledger
  WHERE user_id = v_uid AND reason IN ('selection_submit', 'winning_payout')
    AND created_at >= v_day_start;

  SELECT COALESCE(SUM(amount), 0) INTO v_today_deposits
  FROM public.add_funds_requests
  WHERE user_id = v_uid AND status IN ('approved', 'pending') AND created_at >= v_day_start;

  RETURN jsonb_build_object(
    'daily_deposit_limit', v_limits.daily_deposit_limit,
    'daily_loss_limit', v_limits.daily_loss_limit,
    'cooldown_until', v_limits.cooldown_until,
    'self_excluded_until', v_limits.self_excluded_until,
    'pending_deposit_limit', v_limits.pending_deposit_limit,
    'pending_loss_limit', v_limits.pending_loss_limit,
    'pending_effective_at', v_limits.pending_effective_at,
    'today_net_loss', v_today_net_loss,
    'today_deposits', v_today_deposits
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_limits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_limits() TO authenticated;
