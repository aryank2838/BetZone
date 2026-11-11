-- Add-money requests must include a payment screenshot and a UTR number.
-- The UTR (8-30 letters/digits) was already required; this makes the
-- screenshot required too and checks the uploaded file exists in storage.
-- Requests created before this migration are not changed.

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
  v_terms_accepted_at timestamptz;
  v_existing_pending integer;
  v_limits public.user_limits%ROWTYPE;
  v_today_deposits bigint;
  v_day_start timestamptz;
  v_max_add_funds integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  v_max_add_funds := (public.internal_rule_constants()->>'maximum_add_funds')::integer;
  PERFORM 1 FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  SELECT is_banned, terms_accepted_at INTO v_banned, v_terms_accepted_at
  FROM public.profiles WHERE id = v_uid;
  IF v_terms_accepted_at IS NULL THEN RAISE EXCEPTION 'Please accept the Terms and Privacy Policy first.'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be a positive whole number'; END IF;
  IF p_amount > v_max_add_funds THEN
    RAISE EXCEPTION 'Maximum add-funds amount is %', v_max_add_funds;
  END IF;
  IF p_payment_ref IS NULL OR trim(p_payment_ref) !~ '^[0-9A-Za-z]{8,30}$' THEN
    RAISE EXCEPTION 'Payment reference must be 8 to 30 letters or numbers';
  END IF;
  IF p_screenshot_path IS NOT NULL AND (
       p_screenshot_path NOT LIKE v_uid::text || '/%'
       OR (storage.foldername(p_screenshot_path))[1] IS DISTINCT FROM v_uid::text
     ) THEN RAISE EXCEPTION 'Invalid screenshot path'; END IF;
  PERFORM public.apply_pending_user_limits(v_uid);
  SELECT * INTO v_limits FROM public.user_limits WHERE user_id = v_uid;
  IF v_limits.self_excluded_until > now() THEN
    RAISE EXCEPTION 'Deposits are unavailable until your self-exclusion ends on %.', v_limits.self_excluded_until;
  END IF;
  IF v_limits.daily_deposit_limit IS NOT NULL THEN
    v_day_start := ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
    SELECT COALESCE(SUM(amount), 0) INTO v_today_deposits
    FROM public.add_funds_requests
    WHERE user_id = v_uid AND status IN ('approved', 'pending') AND created_at >= v_day_start;
    IF v_today_deposits + p_amount > v_limits.daily_deposit_limit THEN
      RAISE EXCEPTION 'Daily deposit limit reached. Limit: % points; today: % points.',
        v_limits.daily_deposit_limit, v_today_deposits;
    END IF;
  END IF;
  SELECT count(*) INTO v_existing_pending FROM public.add_funds_requests
  WHERE user_id = v_uid AND status = 'pending';
  IF v_existing_pending > 0 THEN
    RAISE EXCEPTION 'You already have a pending add-funds request. Wait for it to be processed.';
  END IF;
  -- R8: the same UTR as a pending or approved request (case-insensitive).
  IF EXISTS (
    SELECT 1 FROM public.add_funds_requests
    WHERE lower(payment_ref) = lower(trim(p_payment_ref)) AND status <> 'rejected'
  ) THEN RAISE EXCEPTION 'This payment reference has already been used.'; END IF;
  -- A payment screenshot is required, and it must be a file this user really
  -- uploaded to the payment-screenshots bucket (the path was validated above).
  IF p_screenshot_path IS NULL OR trim(p_screenshot_path) = '' THEN
    RAISE EXCEPTION 'Please upload a screenshot of your payment.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.add_funds_requests WHERE screenshot_path = p_screenshot_path
  ) THEN RAISE EXCEPTION 'This screenshot has already been used for another request.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'payment-screenshots' AND o.name = p_screenshot_path
  ) THEN
    RAISE EXCEPTION 'We could not find your payment screenshot. Please upload it again.';
  END IF;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref, screenshot_path)
  VALUES (v_uid, p_amount, 'pending', trim(p_payment_ref), p_screenshot_path);
  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.request_add_funds(integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_add_funds(integer, text, text) TO authenticated;
