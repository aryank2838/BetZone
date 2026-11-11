/*
# Balance breakdown + add funds requests

## Overview
Adds a detailed balance breakdown function and an add-funds request system so
users can request to add play points (approved by admin), mirroring the
withdrawal flow.

## New table: add_funds_requests
- `id` (uuid, primary key)
- `user_id` (uuid, not null, references auth.users)
- `amount` (integer, not null) — points requested to add
- `status` (text, default 'pending') — 'pending' | 'approved' | 'rejected'
- `payment_ref` (text) — UPI transaction reference / payment confirmation
- `created_at`, `processed_at` (timestamptz)

## New functions
- `get_balance_breakdown()`: returns full ledger-derived breakdown for the
  current user: signup_earned, ad_earned, selections_spent, play_balance,
  wallet, pending_withdrawals, pending_add_funds.
- `request_add_funds(p_amount, p_payment_ref)`: user requests to add play
  points. Creates a pending request; admin approves to credit.
- `admin_list_add_funds()`: admin-only, returns all add-funds requests.
- `admin_process_add_funds(p_id, p_status)`: admin-only. If approved, credits
  the user's play points (profiles.points) and logs to ledger.

## Security
- `add_funds_requests`: SELECT own rows only; all writes via functions.
- Admin functions check `is_current_user_admin()`.
*/

CREATE TABLE IF NOT EXISTS add_funds_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payment_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE add_funds_requests ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON add_funds_requests TO authenticated;

DROP POLICY IF EXISTS "add_funds_select_own" ON add_funds_requests;
CREATE POLICY "add_funds_select_own"
  ON add_funds_requests FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ---------- get_balance_breakdown ----------
CREATE OR REPLACE FUNCTION get_balance_breakdown()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_signup_earned integer := 0;
  v_ad_earned integer := 0;
  v_selections_spent integer := 0;
  v_play_balance integer;
  v_wallet integer;
  v_pending_withdrawals integer := 0;
  v_pending_add_funds integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT COALESCE(SUM(delta), 0) INTO v_signup_earned
  FROM point_ledger WHERE user_id = v_uid AND reason = 'signup_bonus';

  SELECT COALESCE(SUM(delta), 0) INTO v_ad_earned
  FROM point_ledger WHERE user_id = v_uid AND reason = 'ad_reward';

  SELECT COALESCE(SUM(ABS(delta)), 0) INTO v_selections_spent
  FROM point_ledger WHERE user_id = v_uid AND reason = 'selection_submit';

  SELECT points, wallet INTO v_play_balance, v_wallet
  FROM profiles WHERE id = v_uid;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_withdrawals
  FROM withdrawals WHERE user_id = v_uid AND status = 'pending';

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_add_funds
  FROM add_funds_requests WHERE user_id = v_uid AND status = 'pending';

  RETURN jsonb_build_object(
    'signup_earned', v_signup_earned,
    'ad_earned', v_ad_earned,
    'selections_spent', v_selections_spent,
    'play_balance', v_play_balance,
    'wallet', v_wallet,
    'pending_withdrawals', v_pending_withdrawals,
    'pending_add_funds', v_pending_add_funds
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION get_balance_breakdown() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_balance_breakdown() TO authenticated;

-- ---------- request_add_funds ----------
CREATE OR REPLACE FUNCTION request_add_funds(p_amount integer, p_payment_ref text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;

  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) = 0 THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  -- Only one pending add-funds request at a time
  SELECT COALESCE(SUM(amount), 0) INTO v_existing
  FROM add_funds_requests
  WHERE user_id = v_uid AND status = 'pending';

  IF v_existing > 0 THEN
    RAISE EXCEPTION 'You already have a pending add-funds request. Wait for it to be processed.';
  END IF;

  INSERT INTO add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_uid, p_amount, 'pending', trim(p_payment_ref));

  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount);
END;
$$;

REVOKE EXECUTE ON FUNCTION request_add_funds(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_add_funds(integer, text) TO authenticated;

-- ---------- admin_list_add_funds ----------
CREATE OR REPLACE FUNCTION admin_list_add_funds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list add-funds requests';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'user_id', a.user_id,
      'amount', a.amount,
      'status', a.status,
      'payment_ref', a.payment_ref,
      'created_at', a.created_at,
      'user_name', p.display_name
    ) ORDER BY a.created_at DESC
  ), '[]'::jsonb) INTO v_result
  FROM add_funds_requests a
  JOIN profiles p ON p.id = a.user_id;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_list_add_funds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_add_funds() TO authenticated;

-- ---------- admin_process_add_funds ----------
CREATE OR REPLACE FUNCTION admin_process_add_funds(p_request_id uuid, p_new_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_user_id uuid;
  v_amount integer;
  v_status text;
  v_ref text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can process add-funds requests';
  END IF;

  IF p_new_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Status must be approved or rejected';
  END IF;

  SELECT user_id, amount, status, payment_ref
  INTO v_user_id, v_amount, v_status, v_ref
  FROM add_funds_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Request already processed';
  END IF;

  UPDATE add_funds_requests
  SET status = p_new_status, processed_at = now()
  WHERE id = p_request_id;

  IF p_new_status = 'approved' THEN
    UPDATE profiles SET points = points + v_amount WHERE id = v_user_id;
    INSERT INTO point_ledger (user_id, delta, reason, metadata)
    VALUES (v_user_id, v_amount, 'add_funds',
      jsonb_build_object('request_id', p_request_id, 'payment_ref', v_ref));
  END IF;

  RETURN jsonb_build_object('id', p_request_id, 'status', p_new_status, 'amount', v_amount);
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_process_add_funds(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_process_add_funds(uuid, text) TO authenticated;
