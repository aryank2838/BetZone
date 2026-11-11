ALTER TABLE public.add_funds_requests
  ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE public.withdrawals
  ADD COLUMN IF NOT EXISTS reject_reason text;

DROP FUNCTION IF EXISTS public.admin_process_withdrawal(uuid, text);
CREATE FUNCTION public.admin_process_withdrawal(
  p_withdrawal_id uuid,
  p_new_status text,
  p_reason text DEFAULT NULL
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
  v_reason text;
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
  IF p_reason IS NOT NULL AND length(trim(p_reason)) > 200 THEN
    RAISE EXCEPTION 'Rejection reason cannot exceed 200 characters';
  END IF;
  v_reason := NULLIF(trim(p_reason), '');
  IF p_new_status = 'rejected'
     AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RAISE EXCEPTION 'A rejection reason of at least 3 characters is required';
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
  SET status = p_new_status,
      processed_at = now(),
      reject_reason = CASE WHEN p_new_status = 'rejected' THEN v_reason ELSE NULL END
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
    jsonb_build_object('withdrawal_id', p_withdrawal_id, 'upi_id', v_upi, 'reason', v_reason)
  );

  RETURN jsonb_build_object(
    'id', p_withdrawal_id,
    'status', p_new_status,
    'amount', v_amount,
    'user_id', v_user_id
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_process_withdrawal(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_process_withdrawal(uuid, text, text)
  TO authenticated;

DROP FUNCTION IF EXISTS public.admin_process_add_funds(uuid, text);
CREATE FUNCTION public.admin_process_add_funds(
  p_request_id uuid,
  p_new_status text,
  p_reason text DEFAULT NULL
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
  v_reason text;
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
  IF p_reason IS NOT NULL AND length(trim(p_reason)) > 200 THEN
    RAISE EXCEPTION 'Rejection reason cannot exceed 200 characters';
  END IF;
  v_reason := NULLIF(trim(p_reason), '');
  IF p_new_status = 'rejected'
     AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RAISE EXCEPTION 'A rejection reason of at least 3 characters is required';
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
  SET status = p_new_status,
      processed_at = now(),
      reject_reason = CASE WHEN p_new_status = 'rejected' THEN v_reason ELSE NULL END
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
    jsonb_build_object('request_id', p_request_id, 'payment_ref', v_ref, 'reason', v_reason)
  );

  RETURN jsonb_build_object(
    'id', p_request_id,
    'status', p_new_status,
    'amount', v_amount
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_process_add_funds(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_process_add_funds(uuid, text, text)
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
    'merchant_upi_id', 'merchant_name', 'approval_time_note',
    'max_user_round_points', 'max_number_liability'
  ) THEN
    RAISE EXCEPTION 'Unknown setting';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;
  v_value := trim(p_value);
  IF p_key <> 'approval_time_note' AND length(v_value) = 0 THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;
  IF p_key = 'approval_time_note' AND char_length(v_value) > 120 THEN
    RAISE EXCEPTION 'Approval time note cannot exceed 120 characters';
  END IF;

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

CREATE OR REPLACE FUNCTION public.get_app_setting(p_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_value text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_key IS NULL OR p_key NOT IN (
    'merchant_upi_id', 'merchant_name', 'approval_time_note'
  ) THEN
    RAISE EXCEPTION 'Unknown setting';
  END IF;

  SELECT value INTO v_value
  FROM public.app_settings
  WHERE key = p_key;
  RETURN v_value;
END
$$;
REVOKE EXECUTE ON FUNCTION public.get_app_setting(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_app_setting(text) TO authenticated;

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
  IF p_payment_ref IS NULL OR trim(p_payment_ref) !~ '^[0-9A-Za-z]{8,30}$' THEN
    RAISE EXCEPTION 'Payment reference must be 8 to 30 letters or numbers';
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

CREATE OR REPLACE FUNCTION public.admin_list_withdrawals(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list withdrawals';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;

  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', w.id, 'user_id', w.user_id, 'amount', w.amount, 'status', w.status,
      'upi_id', w.upi_id, 'created_at', w.created_at, 'processed_at', w.processed_at,
      'reject_reason', w.reject_reason, 'user_name', p.display_name
    ) AS request_row, w.created_at, w.id AS request_id
    FROM public.withdrawals w
    JOIN public.profiles p ON p.id = w.user_id
    ORDER BY w.created_at DESC, w.id DESC
    LIMIT p_limit OFFSET p_offset
  ) request_page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_add_funds(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list add-funds requests';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;

  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', a.id, 'user_id', a.user_id, 'amount', a.amount, 'status', a.status,
      'payment_ref', a.payment_ref, 'screenshot_path', a.screenshot_path,
      'created_at', a.created_at, 'processed_at', a.processed_at,
      'reject_reason', a.reject_reason, 'user_name', p.display_name
    ) AS request_row, a.created_at, a.id AS request_id
    FROM public.add_funds_requests a
    JOIN public.profiles p ON p.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT p_limit OFFSET p_offset
  ) request_page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer) TO authenticated;
