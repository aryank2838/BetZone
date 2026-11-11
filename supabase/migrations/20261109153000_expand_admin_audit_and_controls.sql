ALTER TABLE public.admin_action_log
  ALTER COLUMN target_user_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS game text,
  ADD COLUMN IF NOT EXISTS round_date date,
  ADD COLUMN IF NOT EXISTS amount bigint;

DO $$
DECLARE
  v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.admin_action_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%action%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.admin_action_log DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END;
$$;

ALTER TABLE public.admin_action_log
  ADD CONSTRAINT admin_action_log_action_check
  CHECK (action IN (
    'ban', 'unban', 'grant_admin', 'revoke_admin',
    'adjust_points', 'adjust_wallet',
    'approve_withdrawal', 'reject_withdrawal',
    'approve_add_funds', 'reject_add_funds',
    'post_open_result', 'post_close_result', 'set_setting'
  ));

CREATE OR REPLACE FUNCTION public.admin_toggle_ban(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_is_admin boolean;
  v_was_banned boolean;
  v_name text;
  v_new_ban boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;
  IF p_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot ban yourself';
  END IF;

  PERFORM pg_advisory_xact_lock(724102, 1);
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can ban users';
  END IF;

  SELECT is_admin, is_banned, display_name
  INTO v_is_admin, v_was_banned, v_name
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_is_admin THEN
    RAISE EXCEPTION 'Administrators cannot be banned';
  END IF;

  v_new_ban := NOT v_was_banned;
  UPDATE public.profiles
  SET is_banned = v_new_ban
  WHERE id = p_user_id;

  INSERT INTO public.admin_action_log (actor_id, target_user_id, action, metadata)
  VALUES (
    v_uid,
    p_user_id,
    CASE WHEN v_new_ban THEN 'ban' ELSE 'unban' END,
    jsonb_build_object('display_name', v_name, 'was_banned', v_was_banned)
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_banned', v_new_ban,
    'display_name', v_name
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_toggle_ban(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_toggle_ban(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_admin(p_user_id uuid, p_is_admin boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_was_admin boolean;
  v_name text;
  v_admin_count bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF p_user_id IS NULL OR p_is_admin IS NULL THEN
    RAISE EXCEPTION 'User ID and admin status are required';
  END IF;

  PERFORM pg_advisory_xact_lock(724102, 1);
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can manage admin roles';
  END IF;

  SELECT is_admin, display_name
  INTO v_was_admin, v_name
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF v_was_admin AND NOT p_is_admin THEN
    SELECT count(*) INTO v_admin_count
    FROM public.profiles
    WHERE is_admin;
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot remove the last administrator';
    END IF;
  END IF;

  UPDATE public.profiles
  SET is_admin = p_is_admin
  WHERE id = p_user_id;

  INSERT INTO public.admin_action_log (actor_id, target_user_id, action, metadata)
  VALUES (
    v_uid,
    p_user_id,
    CASE WHEN p_is_admin THEN 'grant_admin' ELSE 'revoke_admin' END,
    jsonb_build_object(
      'display_name', v_name,
      'was_admin', v_was_admin,
      'is_admin', p_is_admin
    )
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_admin', p_is_admin,
    'display_name', v_name
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_set_admin(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_admin(uuid, boolean) TO authenticated;

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
    RAISE EXCEPTION 'Only the admin can adjust points';
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
    jsonb_build_object('admin_id', v_uid, 'admin_reason', trim(p_reason), 'target', p_target)
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

CREATE OR REPLACE FUNCTION public.admin_process_withdrawal(
  p_withdrawal_id uuid,
  p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_user_id uuid;
  v_amount integer;
  v_status text;
  v_upi text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can process withdrawals';
  END IF;
  IF p_new_status IS NULL OR p_new_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Status must be approved or rejected';
  END IF;

  SELECT user_id, amount, status, upi_id
  INTO v_user_id, v_amount, v_status, v_upi
  FROM public.withdrawals
  WHERE id = p_withdrawal_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Withdrawal not found';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Withdrawal already processed';
  END IF;

  UPDATE public.withdrawals
  SET status = p_new_status, processed_at = now()
  WHERE id = p_withdrawal_id;

  IF p_new_status = 'rejected' THEN
    UPDATE public.profiles
    SET wallet = wallet + v_amount
    WHERE id = v_user_id;
    INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
    VALUES (
      v_user_id, v_amount, 'withdrawal_refund',
      jsonb_build_object('withdrawal_id', p_withdrawal_id)
    );
  END IF;

  INSERT INTO public.admin_action_log (
    actor_id, target_user_id, action, amount, metadata
  )
  VALUES (
    v_uid,
    v_user_id,
    CASE WHEN p_new_status = 'approved'
      THEN 'approve_withdrawal' ELSE 'reject_withdrawal' END,
    v_amount,
    jsonb_build_object('withdrawal_id', p_withdrawal_id, 'upi_id', v_upi)
  );

  RETURN jsonb_build_object(
    'id', p_withdrawal_id,
    'status', p_new_status,
    'amount', v_amount,
    'user_id', v_user_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_process_withdrawal(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_process_withdrawal(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_process_add_funds(
  p_request_id uuid,
  p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_user_id uuid;
  v_amount integer;
  v_status text;
  v_ref text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can process add-funds requests';
  END IF;
  IF p_new_status IS NULL OR p_new_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Status must be approved or rejected';
  END IF;

  SELECT user_id, amount, status, payment_ref
  INTO v_user_id, v_amount, v_status, v_ref
  FROM public.add_funds_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Request already processed';
  END IF;

  UPDATE public.add_funds_requests
  SET status = p_new_status, processed_at = now()
  WHERE id = p_request_id;

  IF p_new_status = 'approved' THEN
    UPDATE public.profiles
    SET points = points + v_amount
    WHERE id = v_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'User profile not found';
    END IF;
    INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
    VALUES (
      v_user_id, v_amount, 'add_funds',
      jsonb_build_object('request_id', p_request_id, 'payment_ref', v_ref)
    );
  END IF;

  INSERT INTO public.admin_action_log (
    actor_id, target_user_id, action, amount, metadata
  )
  VALUES (
    v_uid,
    v_user_id,
    CASE WHEN p_new_status = 'approved'
      THEN 'approve_add_funds' ELSE 'reject_add_funds' END,
    v_amount,
    jsonb_build_object('request_id', p_request_id, 'payment_ref', v_ref)
  );

  RETURN jsonb_build_object(
    'id', p_request_id,
    'status', p_new_status,
    'amount', v_amount
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_process_add_funds(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_process_add_funds(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_app_setting(p_key text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_numeric numeric;
  v_value text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can update settings';
  END IF;

  IF p_key IS NULL OR p_key NOT IN (
    'merchant_upi_id', 'merchant_name',
    'max_user_round_points', 'max_number_liability'
  ) THEN
    RAISE EXCEPTION 'Unknown setting';
  END IF;
  IF p_value IS NULL OR length(trim(p_value)) = 0 THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;
  v_value := trim(p_value);

  IF p_key = 'merchant_upi_id'
     AND v_value !~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'UPI ID must use the format username@provider';
  END IF;

  IF p_key IN ('max_user_round_points', 'max_number_liability') THEN
    IF v_value !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'Exposure limits must be positive whole numbers';
    END IF;
    v_numeric := v_value::numeric;
    IF v_numeric > 2147483647 THEN
      RAISE EXCEPTION 'Exposure limit is too large';
    END IF;
  END IF;

  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES (p_key, v_value, v_uid)
  ON CONFLICT (key)
  DO UPDATE SET
    value = EXCLUDED.value,
    updated_by = v_uid,
    updated_at = now();

  INSERT INTO public.admin_action_log (
    actor_id, action, metadata
  )
  VALUES (
    v_uid,
    'set_setting',
    jsonb_build_object('key', p_key, 'value', v_value)
  );

  RETURN jsonb_build_object('key', p_key, 'value', v_value);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_set_app_setting(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_app_setting(text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_post_open_result(
  p_game text,
  p_round_date date,
  p_patti text,
  p_digit text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_sched public.game_schedule%ROWTYPE;
  v_done timestamptz;
  v_payout jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF p_round_date IS NULL THEN
    RAISE EXCEPTION 'Round date is required';
  END IF;

  SELECT * INTO v_sched
  FROM public.game_schedule
  WHERE game = p_game;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF NOT public.is_valid_patti(p_patti) THEN
    RAISE EXCEPTION 'Invalid patti';
  END IF;
  IF p_digit IS NULL OR p_digit !~ '^[0-9]$'
     OR public.patti_digit(p_patti)::text <> p_digit THEN
    RAISE EXCEPTION 'Digit must match the patti';
  END IF;
  IF now() < (
    (p_round_date + v_sched.open_bets_close)::timestamp AT TIME ZONE 'Asia/Kolkata'
  ) THEN
    RAISE EXCEPTION 'Open betting for this round has not closed yet';
  END IF;

  INSERT INTO public.winning_results (game, round_date)
  VALUES (p_game, p_round_date)
  ON CONFLICT (game, round_date) DO NOTHING;

  SELECT open_processed_at INTO v_done
  FROM public.winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Open result for this round was already posted and paid';
  END IF;

  UPDATE public.winning_results
  SET open_patti = p_patti,
      open_digit = p_digit,
      open_posted_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  v_payout := public.process_open_payouts(p_game, p_round_date);

  INSERT INTO public.admin_action_log (
    actor_id, action, game, round_date, metadata
  )
  VALUES (
    v_uid,
    'post_open_result',
    p_game,
    p_round_date,
    jsonb_build_object('patti', p_patti, 'digit', p_digit, 'payout', v_payout)
  );

  RETURN v_payout;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_post_open_result(text, date, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_post_open_result(text, date, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_post_close_result(
  p_game text,
  p_round_date date,
  p_patti text,
  p_digit text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_sched public.game_schedule%ROWTYPE;
  v_open_done timestamptz;
  v_done timestamptz;
  v_payout jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF p_round_date IS NULL THEN
    RAISE EXCEPTION 'Round date is required';
  END IF;

  SELECT * INTO v_sched
  FROM public.game_schedule
  WHERE game = p_game;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF NOT public.is_valid_patti(p_patti) THEN
    RAISE EXCEPTION 'Invalid patti';
  END IF;
  IF p_digit IS NULL OR p_digit !~ '^[0-9]$'
     OR public.patti_digit(p_patti)::text <> p_digit THEN
    RAISE EXCEPTION 'Digit must match the patti';
  END IF;
  IF now() < (
    (p_round_date + v_sched.close_bets_close)::timestamp AT TIME ZONE 'Asia/Kolkata'
  ) THEN
    RAISE EXCEPTION 'Close betting for this round has not closed yet';
  END IF;

  SELECT open_processed_at, close_processed_at
  INTO v_open_done, v_done
  FROM public.winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;
  IF NOT FOUND OR v_open_done IS NULL THEN
    RAISE EXCEPTION 'Post the open result first';
  END IF;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Close result for this round was already posted and paid';
  END IF;

  UPDATE public.winning_results
  SET close_patti = p_patti,
      close_digit = p_digit,
      close_posted_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  v_payout := public.process_close_payouts(p_game, p_round_date);

  INSERT INTO public.admin_action_log (
    actor_id, action, game, round_date, metadata
  )
  VALUES (
    v_uid,
    'post_close_result',
    p_game,
    p_round_date,
    jsonb_build_object('patti', p_patti, 'digit', p_digit, 'payout', v_payout)
  );

  RETURN v_payout;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_post_close_result(text, date, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_post_close_result(text, date, text, text)
  TO authenticated;
