/*
# Admin panel: full admin rights

## Overview
Adds the server-side functions a professional admin needs:
1. Dashboard stats — total users, points in circulation, wallet totals,
   pending withdrawals/add-funds, today's selection counts.
2. User management — list/search all users, ban/unban, grant/revoke admin,
   manually adjust play points or wallet balance.
3. Game oversight — list all current selections per game with user names.

## Schema changes
- `profiles.is_banned` (boolean, default false) — when true the user is
  blocked from playing, withdrawing, or adding funds.
- `profiles.is_admin` already exists (added in winning_numbers_wallet_admin migration).

## New functions (all SECURITY DEFINER, admin-only)
- `admin_get_stats()` → dashboard summary numbers
- `admin_list_users(p_search text)` → all profiles with points, wallet, admin/ban status
- `admin_toggle_ban(p_user_id uuid)` → flips is_banned, prevents self-ban
- `admin_set_admin(p_user_id uuid, p_is_admin boolean)` → grant/revoke admin
- `admin_adjust_points(p_user_id uuid, p_delta integer, p_reason text, p_target text)`
  → manually adjust play points ('points') or wallet ('wallet'); logs to ledger
- `admin_list_selections(p_game text)` → all current selections for a game

## Ban enforcement
Updated `submit_selection`, `award_ad_reward`, `request_withdrawal`,
`request_add_funds` to reject banned users with a clear message.

## Security
- All new functions: REVOKE from PUBLIC/anon, GRANT to authenticated, admin check
- No new RLS policies needed (all access via SECURITY DEFINER functions)
- is_banned column added with safe IF NOT EXISTS
*/

-- ============================================================
-- 1. Add is_banned column to profiles
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false;

-- ============================================================
-- 2. admin_get_stats — dashboard summary
-- ============================================================
CREATE OR REPLACE FUNCTION admin_get_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_total_users integer;
  v_banned_users integer;
  v_admin_count integer;
  v_total_points integer;
  v_total_wallet integer;
  v_pending_wd_count integer;
  v_pending_wd_amount integer;
  v_pending_af_count integer;
  v_pending_af_amount integer;
  v_today_sel_test integer;
  v_today_sel_test2 integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can view stats';
  END IF;

  SELECT count(*), COALESCE(SUM(CASE WHEN is_banned THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN is_admin THEN 1 ELSE 0 END), 0)
    INTO v_total_users, v_banned_users, v_admin_count
  FROM profiles;

  SELECT COALESCE(SUM(points), 0), COALESCE(SUM(wallet), 0)
    INTO v_total_points, v_total_wallet
  FROM profiles;

  SELECT count(*), COALESCE(SUM(amount), 0)
    INTO v_pending_wd_count, v_pending_wd_amount
  FROM withdrawals WHERE status = 'pending';

  SELECT count(*), COALESCE(SUM(amount), 0)
    INTO v_pending_af_count, v_pending_af_amount
  FROM add_funds_requests WHERE status = 'pending';

  SELECT count(*), count(*) INTO v_today_sel_test, v_today_sel_test2
  FROM selections WHERE game = 'test';

  SELECT count(*) INTO v_today_sel_test2
  FROM selections WHERE game = 'test2';

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'banned_users', v_banned_users,
    'admin_count', v_admin_count,
    'total_points', v_total_points,
    'total_wallet', v_total_wallet,
    'pending_withdrawals_count', v_pending_wd_count,
    'pending_withdrawals_amount', v_pending_wd_amount,
    'pending_addfunds_count', v_pending_af_count,
    'pending_addfunds_amount', v_pending_af_amount,
    'selections_test', v_today_sel_test,
    'selections_test2', v_today_sel_test2
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_get_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_get_stats() TO authenticated;

-- ============================================================
-- 3. admin_list_users — list/search all users
-- ============================================================
CREATE OR REPLACE FUNCTION admin_list_users(p_search text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
  v_search text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list users';
  END IF;

  v_search := lower(trim(COALESCE(p_search, '')));

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'email', u.email,
      'points', p.points,
      'wallet', p.wallet,
      'is_admin', p.is_admin,
      'is_banned', p.is_banned,
      'created_at', p.created_at
    ) ORDER BY p.created_at DESC
  ), '[]'::jsonb) INTO v_result
  FROM profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE v_search = ''
     OR lower(p.display_name) LIKE '%' || v_search || '%'
     OR lower(u.email) LIKE '%' || v_search || '%';

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_list_users(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_users(text) TO authenticated;

-- ============================================================
-- 4. admin_toggle_ban — ban/unban a user
-- ============================================================
CREATE OR REPLACE FUNCTION admin_toggle_ban(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_new_ban boolean;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can ban users';
  END IF;
  IF p_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot ban yourself';
  END IF;

  UPDATE profiles
    SET is_banned = NOT is_banned
    WHERE id = p_user_id
    RETURNING is_banned, display_name INTO v_new_ban, v_name;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_banned', v_new_ban,
    'display_name', v_name
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_toggle_ban(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_toggle_ban(uuid) TO authenticated;

-- ============================================================
-- 5. admin_set_admin — grant or revoke admin
-- ============================================================
CREATE OR REPLACE FUNCTION admin_set_admin(p_user_id uuid, p_is_admin boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can manage admin roles';
  END IF;

  UPDATE profiles
    SET is_admin = p_is_admin
    WHERE id = p_user_id
    RETURNING display_name INTO v_name;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_admin', p_is_admin,
    'display_name', v_name
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_set_admin(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_admin(uuid, boolean) TO authenticated;

-- ============================================================
-- 6. admin_adjust_points — manually adjust points or wallet
-- ============================================================
CREATE OR REPLACE FUNCTION admin_adjust_points(
  p_user_id uuid,
  p_delta integer,
  p_reason text,
  p_target text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_new_balance integer;
  v_ledger_reason text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can adjust points';
  END IF;
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta cannot be zero';
  END IF;
  IF p_target NOT IN ('points', 'wallet') THEN
    RAISE EXCEPTION 'Target must be points or wallet';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  v_ledger_reason := CASE WHEN p_target = 'points' THEN 'admin_adjust_points' ELSE 'admin_adjust_wallet' END;

  IF p_target = 'points' THEN
    UPDATE profiles SET points = points + p_delta WHERE id = p_user_id
    RETURNING points INTO v_new_balance;
  ELSE
    UPDATE profiles SET wallet = wallet + p_delta WHERE id = p_user_id
    RETURNING wallet INTO v_new_balance;
  END IF;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Prevent negative balances
  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'Adjustment would make balance negative (result: %)', v_new_balance;
  END IF;

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (p_user_id, p_delta, v_ledger_reason,
    jsonb_build_object('admin_id', v_uid, 'admin_reason', trim(p_reason), 'target', p_target));

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'new_balance', v_new_balance,
    'delta', p_delta,
    'target', p_target
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_adjust_points(uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_adjust_points(uuid, integer, text, text) TO authenticated;

-- ============================================================
-- 7. admin_list_selections — all current selections for a game
-- ============================================================
CREATE OR REPLACE FUNCTION admin_list_selections(p_game text)
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
    RAISE EXCEPTION 'Only the admin can view selections';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'user_name', p.display_name,
      'selections', s.selections,
      'total_points', s.total_points,
      'updated_at', s.updated_at
    ) ORDER BY s.updated_at DESC
  ), '[]'::jsonb) INTO v_result
  FROM selections s
  JOIN profiles p ON p.id = s.user_id
  WHERE s.game = p_game;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_list_selections(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_selections(text) TO authenticated;

-- ============================================================
-- 8. Ban enforcement — update existing functions
-- ============================================================

-- submit_selection: reject banned users
CREATE OR REPLACE FUNCTION submit_selection(p_game text, p_selections jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_total integer := 0;
  v_balance integer;
  v_count integer;
  v_item jsonb;
  v_num text;
  v_pts numeric;
  v_banned boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF NOT jsonb_typeof(p_selections) = 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  SELECT is_banned INTO v_banned FROM profiles WHERE id = v_uid;
  IF v_banned THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  v_count := jsonb_array_length(p_selections);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'No numbers selected';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_selections) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::numeric;
    IF v_num IS NULL OR v_pts IS NULL THEN
      RAISE EXCEPTION 'Each selection needs a number and points';
    END IF;
    IF NOT (v_num ~ '^\d{2}$') OR v_num::int > 99 THEN
      RAISE EXCEPTION 'Number must be between 00 and 99';
    END IF;
    IF v_pts <= 0 OR v_pts <> floor(v_pts) THEN
      RAISE EXCEPTION 'Points must be a positive whole number';
    END IF;
    v_total := v_total + v_pts::int;
  END LOOP;

  SELECT points INTO v_balance FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_balance < v_total THEN
    RAISE EXCEPTION 'Insufficient points. You have %, this selection costs %.', v_balance, v_total;
  END IF;

  UPDATE profiles
    SET points = points - v_total
    WHERE id = v_uid;

  INSERT INTO selections (user_id, game, selections, total_points, updated_at)
  VALUES (v_uid, p_game, p_selections, v_total, now())
  ON CONFLICT (user_id, game)
  DO UPDATE SET
    selections = EXCLUDED.selections,
    total_points = EXCLUDED.total_points,
    updated_at = now();

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -v_total, 'selection_submit',
    jsonb_build_object('game', p_game, 'numbers', v_count));

  RETURN jsonb_build_object(
    'points', v_balance - v_total,
    'total_points', v_total,
    'selections_count', v_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_selection(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_selection(text, jsonb) TO authenticated;

-- award_ad_reward: reject banned users
CREATE OR REPLACE FUNCTION award_ad_reward()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := CURRENT_DATE;
  v_count integer;
  v_points integer;
  v_banned boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT is_banned INTO v_banned FROM profiles WHERE id = v_uid;
  IF v_banned THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  INSERT INTO ad_rewards (user_id, reward_date, count)
  VALUES (v_uid, v_today, 0)
  ON CONFLICT (user_id, reward_date) DO NOTHING;

  SELECT count INTO v_count
  FROM ad_rewards
  WHERE user_id = v_uid AND reward_date = v_today
  FOR UPDATE;

  IF v_count >= 10 THEN
    RAISE EXCEPTION 'Daily ad reward limit reached';
  END IF;

  UPDATE ad_rewards
    SET count = count + 1
    WHERE user_id = v_uid AND reward_date = v_today;

  UPDATE profiles
    SET points = points + 1
    WHERE id = v_uid
    RETURNING points INTO v_points;

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, 1, 'ad_reward', jsonb_build_object('reward_index', v_count + 1, 'date', v_today));

  RETURN jsonb_build_object('points', v_points, 'rewards_today', v_count + 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION award_ad_reward() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION award_ad_reward() TO authenticated;

-- request_withdrawal: reject banned users (add ban check to existing logic)
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

  IF p_upi_id IS NULL OR length(trim(p_upi_id)) = 0 THEN
    RAISE EXCEPTION 'UPI ID is required';
  END IF;

  SELECT is_banned INTO v_banned FROM profiles WHERE id = v_uid;
  IF v_banned THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  SELECT count(*) INTO v_pending_count
  FROM withdrawals WHERE user_id = v_uid AND status = 'pending';

  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'You already have a withdrawal awaiting admin approval. Wait for it to be processed before requesting another.';
  END IF;

  SELECT wallet INTO v_wallet FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. You have %, requested %.', v_wallet, p_amount;
  END IF;

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

-- request_add_funds: reject banned users
CREATE OR REPLACE FUNCTION request_add_funds(p_amount integer, p_payment_ref text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing integer;
  v_banned boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT is_banned INTO v_banned FROM profiles WHERE id = v_uid;
  IF v_banned THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  IF p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;

  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) = 0 THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_existing
  FROM add_funds_requests WHERE user_id = v_uid AND status = 'pending';

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
