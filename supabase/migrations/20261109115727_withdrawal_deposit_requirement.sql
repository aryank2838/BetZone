CREATE OR REPLACE FUNCTION request_withdrawal(p_amount integer, p_upi_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_wallet integer;
  v_pending_count integer;
  v_min_withdrawal integer := 100;
  v_banned boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;

  IF p_amount < v_min_withdrawal THEN
    RAISE EXCEPTION 'Minimum withdrawal is % points.', v_min_withdrawal;
  END IF;

  IF COALESCE((
    SELECT SUM(amount)
    FROM add_funds_requests
    WHERE user_id = v_uid AND status = 'approved'
  ), 0) < 100 THEN
    RAISE EXCEPTION 'Add at least 100 points before your first withdrawal.';
  END IF;

  IF p_upi_id IS NULL OR length(trim(p_upi_id)) = 0 THEN
    RAISE EXCEPTION 'UPI ID is required';
  END IF;

  SELECT is_banned INTO v_banned
  FROM profiles
  WHERE id = v_uid;
  IF v_banned THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  -- Lock before checking pending requests so concurrent calls serialize.
  SELECT wallet INTO v_wallet
  FROM profiles
  WHERE id = v_uid
  FOR UPDATE;
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  SELECT count(*) INTO v_pending_count
  FROM withdrawals
  WHERE user_id = v_uid AND status = 'pending';
  IF v_pending_count > 0 THEN
    RAISE EXCEPTION
      'You already have a withdrawal awaiting admin approval. Wait for it to be processed before requesting another.';
  END IF;

  IF v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. You have %, requested %.', v_wallet, p_amount;
  END IF;

  UPDATE profiles
  SET wallet = wallet - p_amount
  WHERE id = v_uid;

  INSERT INTO withdrawals (user_id, amount, status, upi_id)
  VALUES (v_uid, p_amount, 'pending', trim(p_upi_id));

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (
    v_uid,
    -p_amount,
    'withdrawal_request',
    jsonb_build_object('upi_id', trim(p_upi_id))
  );

  SELECT wallet INTO v_wallet
  FROM profiles
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'status', 'pending',
    'amount', p_amount,
    'remaining_wallet', v_wallet
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION request_withdrawal(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_withdrawal(integer, text) TO authenticated;
