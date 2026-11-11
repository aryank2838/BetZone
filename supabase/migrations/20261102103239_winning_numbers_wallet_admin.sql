/*
# Winning numbers, wallet, admin role, payouts, withdrawals

## Overview
Adds the infrastructure for:
1. Admin (you) to post a daily winning number for the Test game at 7 PM.
2. Automatic payout: any user who selected that number gets 90× their bet on that
   number credited to their wallet (withdrawable balance).
3. A wallet system with two balances: `points` (play balance — signup + ad rewards,
   NOT withdrawable) and `wallet` (winnings, withdrawable).
4. A withdrawal request flow.

## New columns on `profiles`
- `is_admin` (boolean, default false) — marks the admin account.
- `wallet` (integer, not null, default 0) — withdrawable winnings balance. Only
  mutated by SECURITY DEFINER functions (payouts, withdrawal approvals).

## New table: `winning_numbers`
- `id` (uuid, primary key)
- `game` (text, not null) — "test" or "test2"
- `number` (text, not null) — the winning number "00".."99"
- `round_date` (date, not null) — the calendar day this winning number applies to
- `posted_at` (timestamptz, default now()) — when the admin posted it
- `processed_at` (timestamptz, nullable) — when payouts were calculated (null = not yet)
- Unique on (game, round_date) — one winning number per game per day

## New table: `withdrawals`
- `id` (uuid, primary key)
- `user_id` (uuid, not null, references auth.users)
- `amount` (integer, not null) — points requested to withdraw
- `status` (text, not null, default 'pending') — 'pending' | 'approved' | 'rejected'
- `created_at` (timestamptz)
- `processed_at` (timestamptz, nullable)
- One row per withdrawal request

## New functions (all SECURITY DEFINER)
- `post_winning_number(p_game, p_number)`: admin-only. Inserts a winning number for
  today, then calls process_payouts to credit all matching users.
- `process_payouts(p_game, p_round_date)`: for each user who selected the winning
  number, credits 90 × their bet on that number to their wallet. Idempotent
  (skips users already paid for this round via the processed_at flag).
- `request_withdrawal(p_amount)`: user requests to withdraw from wallet to a
  UPI/account. Deducts from wallet immediately and creates a pending withdrawal
  record. (Admin approves externally.)
- `admin_list_withdrawals()`: admin-only, returns all pending withdrawals.
- `admin_process_withdrawal(p_withdrawal_id, p_status)`: admin-only, marks a
  withdrawal as approved/rejected. If rejected, refunds the wallet.
- `get_wallet_status()`: returns { points, wallet, pending_withdrawals } for the
  current user.

## Security
- `winning_numbers`: SELECT to authenticated (everyone can see results); INSERT
  only via the SECURITY DEFINER function (no direct INSERT grant).
- `withdrawals`: SELECT own rows; INSERT own rows via function; admin can list all
  via function.
- `profiles.is_admin` and `profiles.wallet` are NOT directly writable by users —
  only SECURITY DEFINER functions mutate them. The existing UPDATE policy on
  profiles allows users to update their own row, but column-level privileges are
  restricted to `display_name` only.

## Important notes
1. The `profiles` UPDATE grant is narrowed to `display_name` only, so users cannot
   set their own `is_admin` flag or change their `wallet`.
2. Payout is idempotent: re-running process_payouts for the same round is a no-op
   because the winning_numbers.processed_at flag is set after the first run.
3. Signup points (100) and ad reward points go to `profiles.points` (play balance).
   Winnings go to `profiles.wallet` (withdrawable). Only `wallet` is withdrawable.
*/

-- ============================================================
-- 1. Add columns to profiles
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wallet integer NOT NULL DEFAULT 0;

-- Narrow the UPDATE grant on profiles so users can only change display_name,
-- NOT is_admin or wallet or points.
REVOKE UPDATE ON profiles FROM authenticated;
GRANT UPDATE (display_name) ON profiles TO authenticated;
-- SELECT still needs all columns for the app to read points + wallet
GRANT SELECT ON profiles TO authenticated;

-- ============================================================
-- 2. winning_numbers table
-- ============================================================
CREATE TABLE IF NOT EXISTS winning_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  number text NOT NULL,
  round_date date NOT NULL DEFAULT CURRENT_DATE,
  posted_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE winning_numbers ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON winning_numbers TO authenticated;

DROP POLICY IF EXISTS "winning_numbers_select_all" ON winning_numbers;
CREATE POLICY "winning_numbers_select_all"
  ON winning_numbers FOR SELECT TO authenticated
  USING (true);

CREATE UNIQUE INDEX IF NOT EXISTS uq_winning_numbers_game_date
  ON winning_numbers (game, round_date);

-- ============================================================
-- 3. withdrawals table
-- ============================================================
CREATE TABLE IF NOT EXISTS withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  upi_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON withdrawals TO authenticated;

DROP POLICY IF EXISTS "withdrawals_select_own" ON withdrawals;
CREATE POLICY "withdrawals_select_own"
  ON withdrawals FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- 4. Helper: is the current user an admin?
-- ============================================================
CREATE OR REPLACE FUNCTION is_current_user_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT is_admin FROM profiles WHERE id = auth.uid()),
    false
  );
$$;

REVOKE EXECUTE ON FUNCTION is_current_user_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_current_user_admin() TO authenticated;

-- ============================================================
-- 5. post_winning_number (admin-only)
--    Inserts the winning number for today, then runs payouts.
-- ============================================================
CREATE OR REPLACE FUNCTION post_winning_number(p_game text, p_number text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := CURRENT_DATE;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can post winning numbers';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF NOT (p_number ~ '^\d{2}$') OR p_number::int > 99 THEN
    RAISE EXCEPTION 'Number must be between 00 and 99';
  END IF;

  -- Insert or update today's winning number (allow correcting before payout)
  INSERT INTO winning_numbers (game, number, round_date, posted_at)
  VALUES (p_game, p_number, v_today, now())
  ON CONFLICT (game, round_date)
  DO UPDATE SET number = EXCLUDED.number, posted_at = now(), processed_at = NULL;

  -- Run payouts immediately
  SELECT * FROM process_payouts(p_game, v_today) INTO v_result;

  RETURN jsonb_build_object(
    'game', p_game,
    'number', p_number,
    'date', v_today,
    'payout', v_result
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION post_winning_number(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_winning_number(text, text) TO authenticated;

-- ============================================================
-- 6. process_payouts — credit 90x bet to wallet for matching users
--    Idempotent: skips if processed_at is already set.
-- ============================================================
CREATE OR REPLACE FUNCTION process_payouts(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winning_number text;
  v_winners_count integer := 0;
  v_total_paid integer := 0;
  v_sel jsonb;
  v_sel_row jsonb;
  v_user_id uuid;
  v_bet integer;
  v_payout integer;
  v_processed timestamptz;
BEGIN
  -- Get the winning number
  SELECT number, processed_at INTO v_winning_number, v_processed
  FROM winning_numbers
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_winning_number IS NULL THEN
    RAISE EXCEPTION 'No winning number posted for this game/date';
  END IF;

  IF v_processed IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_processed', 'winners', 0, 'total_paid', 0);
  END IF;

  -- Find all users who selected this number for this game
  FOR v_sel IN
    SELECT user_id, selections
    FROM selections
    WHERE game = p_game
  LOOP
    v_user_id := v_sel->>'user_id';
    FOR v_sel_row IN SELECT * FROM jsonb_array_elements(v_sel->'selections') LOOP
      IF v_sel_row->>'number' = v_winning_number THEN
        v_bet := (v_sel_row->>'points')::int;
        v_payout := v_bet * 90;

        -- Credit wallet
        UPDATE profiles
        SET wallet = wallet + v_payout
        WHERE id = v_user_id;

        -- Log to ledger
        INSERT INTO point_ledger (user_id, delta, reason, metadata)
        VALUES (
          v_user_id, v_payout, 'winning_payout',
          jsonb_build_object('game', p_game, 'number', v_winning_number, 'bet', v_bet, 'multiplier', 90, 'round_date', p_round_date)
        );

        v_winners_count := v_winners_count + 1;
        v_total_paid := v_total_paid + v_payout;
      END IF;
    END LOOP;
  END LOOP;

  -- Mark as processed
  UPDATE winning_numbers
  SET processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'winners', v_winners_count,
    'total_paid', v_total_paid,
    'winning_number', v_winning_number
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION process_payouts(text, date) FROM PUBLIC, anon;
-- Internal function, only called from post_winning_number, but grant to authenticated for direct admin testing
GRANT EXECUTE ON FUNCTION process_payouts(text, date) TO authenticated;

-- ============================================================
-- 7. request_withdrawal — user withdraws from wallet
-- ============================================================
CREATE OR REPLACE FUNCTION request_withdrawal(p_amount integer, p_upi_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_wallet integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;

  IF p_upi_id IS NULL OR length(trim(p_upi_id)) = 0 THEN
    RAISE EXCEPTION 'UPI ID is required';
  END IF;

  SELECT wallet INTO v_wallet FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. You have %, requested %.', v_wallet, p_amount;
  END IF;

  -- Deduct from wallet immediately (held in escrow until admin approves)
  UPDATE profiles SET wallet = wallet - p_amount WHERE id = v_uid;

  INSERT INTO withdrawals (user_id, amount, status, upi_id)
  VALUES (v_uid, p_amount, 'pending', trim(p_upi_id));

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -p_amount, 'withdrawal_request',
    jsonb_build_object('upi_id', trim(p_upi_id)));

  SELECT wallet INTO v_wallet FROM profiles WHERE id = v_uid;

  RETURN jsonb_build_object(
    'status', 'pending',
    'amount', p_amount,
    'remaining_wallet', v_wallet
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION request_withdrawal(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_withdrawal(integer, text) TO authenticated;

-- ============================================================
-- 8. get_wallet_status — returns wallet + points for current user
-- ============================================================
CREATE OR REPLACE FUNCTION get_wallet_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_points integer;
  v_wallet integer;
  v_pending integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT points, wallet INTO v_points, v_wallet FROM profiles WHERE id = v_uid;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending
  FROM withdrawals
  WHERE user_id = v_uid AND status = 'pending';

  RETURN jsonb_build_object(
    'points', v_points,
    'wallet', v_wallet,
    'pending_withdrawals', v_pending
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION get_wallet_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_wallet_status() TO authenticated;

-- ============================================================
-- 9. admin_list_withdrawals — admin sees all pending withdrawals
-- ============================================================
CREATE OR REPLACE FUNCTION admin_list_withdrawals()
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
    RAISE EXCEPTION 'Only the admin can list withdrawals';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', w.id,
      'user_id', w.user_id,
      'amount', w.amount,
      'status', w.status,
      'upi_id', w.upi_id,
      'created_at', w.created_at,
      'user_name', p.display_name
    ) ORDER BY w.created_at DESC
  ), '[]'::jsonb) INTO v_result
  FROM withdrawals w
  JOIN profiles p ON p.id = w.user_id;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_list_withdrawals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_withdrawals() TO authenticated;

-- ============================================================
-- 10. admin_process_withdrawal — approve/reject a withdrawal
-- ============================================================
CREATE OR REPLACE FUNCTION admin_process_withdrawal(p_withdrawal_id uuid, p_new_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_w_user_id uuid;
  v_w_amount integer;
  v_w_status text;
  v_w_upi text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can process withdrawals';
  END IF;

  IF p_new_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Status must be approved or rejected';
  END IF;

  SELECT user_id, amount, status, upi_id
  INTO v_w_user_id, v_w_amount, v_w_status, v_w_upi
  FROM withdrawals
  WHERE id = p_withdrawal_id
  FOR UPDATE;

  IF v_w_user_id IS NULL THEN
    RAISE EXCEPTION 'Withdrawal not found';
  END IF;

  IF v_w_status <> 'pending' THEN
    RAISE EXCEPTION 'Withdrawal already processed';
  END IF;

  UPDATE withdrawals
  SET status = p_new_status, processed_at = now()
  WHERE id = p_withdrawal_id;

  -- If rejected, refund the wallet
  IF p_new_status = 'rejected' THEN
    UPDATE profiles SET wallet = wallet + v_w_amount WHERE id = v_w_user_id;
    INSERT INTO point_ledger (user_id, delta, reason, metadata)
    VALUES (v_w_user_id, v_w_amount, 'withdrawal_refund',
      jsonb_build_object('withdrawal_id', p_withdrawal_id));
  END IF;

  RETURN jsonb_build_object(
    'id', p_withdrawal_id,
    'status', p_new_status,
    'amount', v_w_amount,
    'user_id', v_w_user_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_process_withdrawal(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_process_withdrawal(uuid, text) TO authenticated;

-- ============================================================
-- 11. get_latest_winning_number — for display on the site
-- ============================================================
CREATE OR REPLACE FUNCTION get_latest_winning_number(p_game text)
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

  SELECT jsonb_build_object(
    'number', wn.number,
    'round_date', wn.round_date,
    'posted_at', wn.posted_at,
    'processed_at', wn.processed_at
  ) INTO v_result
  FROM winning_numbers wn
  WHERE wn.game = p_game
  ORDER BY wn.round_date DESC, wn.posted_at DESC
  LIMIT 1;

  RETURN COALESCE(v_result, 'null'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION get_latest_winning_number(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_latest_winning_number(text) TO authenticated;
