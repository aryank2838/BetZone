ALTER TABLE public.profiles
  VALIDATE CONSTRAINT display_name_len;

REVOKE UPDATE (display_name) ON TABLE public.profiles FROM authenticated;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

GRANT SELECT ON TABLE
  public.profiles,
  public.selections,
  public.point_ledger,
  public.withdrawals,
  public.add_funds_requests
TO authenticated;

GRANT SELECT ON TABLE
  public.winning_results,
  public.game_schedule
TO authenticated;

GRANT SELECT ON TABLE public.admin_action_log TO authenticated;
GRANT UPDATE (display_name) ON TABLE public.profiles TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_valid_patti(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_patti(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.patti_digit(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patti_digit(text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_valid_patti_combo(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_valid_patti_combo(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_add_funds(
  p_amount integer,
  p_payment_ref text,
  p_screenshot_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_banned boolean;
  v_existing_pending integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  PERFORM 1
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  SELECT is_banned INTO v_banned
  FROM public.profiles
  WHERE id = v_uid;
  IF COALESCE(v_banned, false) THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;
  IF p_amount > 100000 THEN
    RAISE EXCEPTION 'Maximum add-funds amount is 100000';
  END IF;
  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) = 0 THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  IF p_screenshot_path IS NOT NULL
     AND (
       p_screenshot_path NOT LIKE v_uid::text || '/%'
       OR (storage.foldername(p_screenshot_path))[1] IS DISTINCT FROM v_uid::text
     ) THEN
    RAISE EXCEPTION 'Invalid screenshot path';
  END IF;

  SELECT count(*) INTO v_existing_pending
  FROM public.add_funds_requests
  WHERE user_id = v_uid
    AND status = 'pending';
  IF v_existing_pending > 0 THEN
    RAISE EXCEPTION 'You already have a pending add-funds request. Wait for it to be processed.';
  END IF;

  IF p_screenshot_path IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.add_funds_requests
    WHERE screenshot_path = p_screenshot_path
  ) THEN
    RAISE EXCEPTION 'This screenshot has already been used for another request.';
  END IF;

  INSERT INTO public.add_funds_requests (
    user_id, amount, status, payment_ref, screenshot_path
  )
  VALUES (
    v_uid, p_amount, 'pending', trim(p_payment_ref), p_screenshot_path
  );

  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_add_funds(integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_add_funds(integer, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.request_withdrawal(p_amount integer, p_upi_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_wallet integer;
  v_banned boolean;
  v_pending_count integer;
  v_approved_deposits bigint;
  v_wagered_turnover bigint;
  v_remaining_turnover bigint;
  v_min_withdrawal CONSTANT integer := 100;
  v_max_withdrawal CONSTANT integer := 100000;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  SELECT wallet, is_banned
  INTO v_wallet, v_banned
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF COALESCE(v_banned, false) THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;
  IF p_amount < v_min_withdrawal THEN
    RAISE EXCEPTION 'Minimum withdrawal is % points.', v_min_withdrawal;
  END IF;
  IF p_amount > v_max_withdrawal THEN
    RAISE EXCEPTION 'Maximum withdrawal is % points.', v_max_withdrawal;
  END IF;
  IF p_upi_id IS NULL
     OR trim(p_upi_id) !~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'Enter a valid UPI ID in the format username@provider.';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
  INTO v_approved_deposits
  FROM public.add_funds_requests
  WHERE user_id = v_uid
    AND status = 'approved';

  IF v_approved_deposits < v_min_withdrawal THEN
    RAISE EXCEPTION 'Add at least 100 approved deposit points before requesting a withdrawal.';
  END IF;

  SELECT COALESCE(SUM(ABS(delta::bigint)), 0)
  INTO v_wagered_turnover
  FROM public.point_ledger
  WHERE user_id = v_uid
    AND reason = 'selection_submit';

  v_remaining_turnover := GREATEST(v_approved_deposits - v_wagered_turnover, 0);
  IF v_remaining_turnover > 0 THEN
    RAISE EXCEPTION
      'Wager % more points before withdrawing. Required turnover: % points; completed: % points.',
      v_remaining_turnover, v_approved_deposits, v_wagered_turnover;
  END IF;

  SELECT count(*) INTO v_pending_count
  FROM public.withdrawals
  WHERE user_id = v_uid
    AND status = 'pending';
  IF v_pending_count > 0 THEN
    RAISE EXCEPTION
      'You already have a withdrawal awaiting admin approval. Wait for it to be processed before requesting another.';
  END IF;

  IF v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. You have %, requested %.', v_wallet, p_amount;
  END IF;

  UPDATE public.profiles
  SET wallet = wallet - p_amount
  WHERE id = v_uid;

  INSERT INTO public.withdrawals (user_id, amount, status, upi_id)
  VALUES (v_uid, p_amount, 'pending', trim(p_upi_id));

  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (
    v_uid,
    -p_amount,
    'withdrawal_request',
    jsonb_build_object('upi_id', trim(p_upi_id))
  );

  SELECT wallet INTO v_wallet
  FROM public.profiles
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'status', 'pending',
    'amount', p_amount,
    'remaining_wallet', v_wallet
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_withdrawal(integer, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_withdrawal(integer, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_adjust_points(
  p_user_id uuid,
  p_delta integer,
  p_reason text,
  p_target text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_new_balance integer;
  v_ledger_reason text;
  v_max_adjustment CONSTANT integer := 10000;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can adjust balances';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;
  IF p_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot adjust your own balance';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'Delta cannot be zero';
  END IF;
  IF abs(p_delta::bigint) > v_max_adjustment THEN
    RAISE EXCEPTION 'Balance adjustment cannot exceed % in either direction', v_max_adjustment;
  END IF;
  IF p_target IS NULL OR p_target NOT IN ('points', 'wallet') THEN
    RAISE EXCEPTION 'Target must be points or wallet';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'Reason must be at least 5 characters';
  END IF;

  v_ledger_reason := CASE
    WHEN p_target = 'points' THEN 'admin_adjust_points'
    ELSE 'admin_adjust_wallet'
  END;

  IF p_target = 'points' THEN
    UPDATE public.profiles
    SET points = points + p_delta
    WHERE id = p_user_id
    RETURNING points INTO v_new_balance;
  ELSE
    UPDATE public.profiles
    SET wallet = wallet + p_delta
    WHERE id = p_user_id
    RETURNING wallet INTO v_new_balance;
  END IF;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'Adjustment would make balance negative (result: %)', v_new_balance;
  END IF;

  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (
    p_user_id,
    p_delta,
    v_ledger_reason,
    jsonb_build_object('target', p_target)
  );

  INSERT INTO public.admin_action_log (
    actor_id, target_user_id, action, amount, metadata
  )
  VALUES (
    v_uid,
    p_user_id,
    CASE WHEN p_target = 'points' THEN 'adjust_points' ELSE 'adjust_wallet' END,
    p_delta,
    jsonb_build_object('reason', trim(p_reason), 'new_balance', v_new_balance)
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'new_balance', v_new_balance,
    'delta', p_delta,
    'target', p_target
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_adjust_points(uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_points(uuid, integer, text, text)
  TO authenticated;
