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
  IF p_upi_id IS NULL OR length(trim(p_upi_id)) = 0 THEN
    RAISE EXCEPTION 'UPI ID is required';
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
