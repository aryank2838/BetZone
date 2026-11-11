/*
# Kalyan-style multi-bet game redesign

## Overview
Redesigns the game to support the full Kalyan-style betting structure with:
- Open result: 1-digit (0-9) + 3-digit patti (000-999), comes at ~5 PM
- Close result: 1-digit (0-9) + 3-digit patti (000-999), comes at ~7 PM
- Final result format: 123-69-513 (open_patti-open_digit-close_digit-close_patti)

## Bet Types & Payouts
1. Single Open (single_open): bet on 1 digit (0-9) for open -> 9x payout
2. Single Close (single_close): bet on 1 digit (0-9) for close -> 9x payout
3. Jodi (jodi): bet on 2-digit number (00-99) -> 90x payout
4. Patti Open (patti_open): bet on exact 3-digit patti for open -> 120x payout
5. Patti Close (patti_close): bet on exact 3-digit patti for close -> 120x payout

## New Tables
- winning_results: replaces winning_numbers with separate open/close fields

## Modified Tables
- selections: add bet_type column (default 'jodi' for backward compat)

## New/Updated Functions
- submit_selection(p_game, p_selections, p_bet_type): now accepts bet_type
- post_open_result(p_game, p_digit, p_patti): admin posts open result
- post_close_result(p_game, p_digit, p_patti): admin posts close result
- process_open_payouts(p_game, p_round_date): pays single_open + patti_open
- process_close_payouts(p_game, p_round_date): pays single_close + patti_close + jodi
- get_latest_results(p_game): returns full result card

## Security
- winning_results: SELECT to authenticated, INSERT via admin functions only
- selections: add bet_type column, keep existing RLS
*/

-- ============================================================
-- 1. Add bet_type column to selections and update unique constraint
-- ============================================================
ALTER TABLE selections ADD COLUMN IF NOT EXISTS bet_type text NOT NULL DEFAULT 'jodi';

ALTER TABLE selections DROP CONSTRAINT IF EXISTS selections_user_id_game_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_selections_user_game_bettype
  ON selections (user_id, game, bet_type);

-- ============================================================
-- 2. Create winning_results table
-- ============================================================
CREATE TABLE IF NOT EXISTS winning_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  round_date date NOT NULL DEFAULT CURRENT_DATE,
  open_digit text,
  close_digit text,
  open_patti text,
  close_patti text,
  open_posted_at timestamptz,
  close_posted_at timestamptz,
  open_processed_at timestamptz,
  close_processed_at timestamptz,
  UNIQUE (game, round_date)
);

ALTER TABLE winning_results ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON winning_results TO authenticated;

DROP POLICY IF EXISTS "winning_results_select_all" ON winning_results;
CREATE POLICY "winning_results_select_all"
  ON winning_results FOR SELECT TO authenticated
  USING (true);

-- ============================================================
-- 3. Post open result (admin-only)
-- ============================================================
CREATE OR REPLACE FUNCTION post_open_result(p_game text, p_digit text, p_patti text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := CURRENT_DATE;
  v_payout jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can post results';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF NOT (p_digit ~ '^\d$') THEN
    RAISE EXCEPTION 'Open digit must be 0-9';
  END IF;

  IF p_patti IS NOT NULL AND NOT (p_patti ~ '^\d{3}$') THEN
    RAISE EXCEPTION 'Open patti must be 3 digits (000-999)';
  END IF;

  INSERT INTO winning_results (game, round_date, open_digit, open_patti, open_posted_at)
  VALUES (p_game, v_today, p_digit, p_patti, now())
  ON CONFLICT (game, round_date)
  DO UPDATE SET
    open_digit = EXCLUDED.open_digit,
    open_patti = EXCLUDED.open_patti,
    open_posted_at = now(),
    open_processed_at = NULL;

  SELECT * FROM process_open_payouts(p_game, v_today) INTO v_payout;

  RETURN jsonb_build_object(
    'game', p_game,
    'open_digit', p_digit,
    'open_patti', p_patti,
    'date', v_today,
    'payout', v_payout
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION post_open_result(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_open_result(text, text, text) TO authenticated;

-- ============================================================
-- 4. Post close result (admin-only)
-- ============================================================
CREATE OR REPLACE FUNCTION post_close_result(p_game text, p_digit text, p_patti text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := CURRENT_DATE;
  v_payout jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can post results';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF NOT (p_digit ~ '^\d$') THEN
    RAISE EXCEPTION 'Close digit must be 0-9';
  END IF;

  IF p_patti IS NOT NULL AND NOT (p_patti ~ '^\d{3}$') THEN
    RAISE EXCEPTION 'Close patti must be 3 digits (000-999)';
  END IF;

  INSERT INTO winning_results (game, round_date, close_digit, close_patti, close_posted_at)
  VALUES (p_game, v_today, p_digit, p_patti, now())
  ON CONFLICT (game, round_date)
  DO UPDATE SET
    close_digit = EXCLUDED.close_digit,
    close_patti = EXCLUDED.close_patti,
    close_posted_at = now(),
    close_processed_at = NULL;

  SELECT * FROM process_close_payouts(p_game, v_today) INTO v_payout;

  RETURN jsonb_build_object(
    'game', p_game,
    'close_digit', p_digit,
    'close_patti', p_patti,
    'date', v_today,
    'payout', v_payout
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION post_close_result(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_close_result(text, text, text) TO authenticated;

-- ============================================================
-- 5. Process open payouts (single_open 9x, patti_open 120x)
-- ============================================================
CREATE OR REPLACE FUNCTION process_open_payouts(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open_digit text;
  v_open_patti text;
  v_processed timestamptz;
  v_winners integer := 0;
  v_total_paid integer := 0;
  v_sel_row RECORD;
  v_item jsonb;
  v_user_id uuid;
  v_bet integer;
  v_payout integer;
BEGIN
  SELECT open_digit, open_patti, open_processed_at
  INTO v_open_digit, v_open_patti, v_processed
  FROM winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_open_digit IS NULL THEN
    RAISE EXCEPTION 'No open result posted';
  END IF;

  IF v_processed IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_processed', 'winners', 0, 'total_paid', 0);
  END IF;

  FOR v_sel_row IN
    SELECT user_id, selections FROM selections
    WHERE game = p_game AND bet_type = 'single_open'
  LOOP
    v_user_id := v_sel_row.user_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
      IF v_item->>'number' = v_open_digit THEN
        v_bet := (v_item->>'points')::int;
        v_payout := v_bet * 9;
        UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
        INSERT INTO point_ledger (user_id, delta, reason, metadata)
        VALUES (v_user_id, v_payout, 'winning_payout',
          jsonb_build_object('game', p_game, 'bet_type', 'single_open',
            'number', v_open_digit, 'bet', v_bet, 'multiplier', 9));
        v_winners := v_winners + 1;
        v_total_paid := v_total_paid + v_payout;
      END IF;
    END LOOP;
  END LOOP;

  IF v_open_patti IS NOT NULL THEN
    FOR v_sel_row IN
      SELECT user_id, selections FROM selections
      WHERE game = p_game AND bet_type = 'patti_open'
    LOOP
      v_user_id := v_sel_row.user_id;
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
        IF v_item->>'number' = v_open_patti THEN
          v_bet := (v_item->>'points')::int;
          v_payout := v_bet * 120;
          UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
          INSERT INTO point_ledger (user_id, delta, reason, metadata)
          VALUES (v_user_id, v_payout, 'winning_payout',
            jsonb_build_object('game', p_game, 'bet_type', 'patti_open',
              'number', v_open_patti, 'bet', v_bet, 'multiplier', 120));
          v_winners := v_winners + 1;
          v_total_paid := v_total_paid + v_payout;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  UPDATE winning_results SET open_processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'phase', 'open',
    'winners', v_winners,
    'total_paid', v_total_paid
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION process_open_payouts(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION process_open_payouts(text, date) TO authenticated;

-- ============================================================
-- 6. Process close payouts (single_close 9x, patti_close 120x, jodi 90x)
-- ============================================================
CREATE OR REPLACE FUNCTION process_close_payouts(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_close_digit text;
  v_open_digit text;
  v_close_patti text;
  v_close_processed timestamptz;
  v_winners integer := 0;
  v_total_paid integer := 0;
  v_sel_row RECORD;
  v_item jsonb;
  v_user_id uuid;
  v_bet integer;
  v_payout integer;
  v_jodi_number text;
BEGIN
  SELECT open_digit, close_digit, close_patti, close_processed_at
  INTO v_open_digit, v_close_digit, v_close_patti, v_close_processed
  FROM winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_close_digit IS NULL THEN
    RAISE EXCEPTION 'No close result posted';
  END IF;

  IF v_close_processed IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_processed', 'winners', 0, 'total_paid', 0);
  END IF;

  FOR v_sel_row IN
    SELECT user_id, selections FROM selections
    WHERE game = p_game AND bet_type = 'single_close'
  LOOP
    v_user_id := v_sel_row.user_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
      IF v_item->>'number' = v_close_digit THEN
        v_bet := (v_item->>'points')::int;
        v_payout := v_bet * 9;
        UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
        INSERT INTO point_ledger (user_id, delta, reason, metadata)
        VALUES (v_user_id, v_payout, 'winning_payout',
          jsonb_build_object('game', p_game, 'bet_type', 'single_close',
            'number', v_close_digit, 'bet', v_bet, 'multiplier', 9));
        v_winners := v_winners + 1;
        v_total_paid := v_total_paid + v_payout;
      END IF;
    END LOOP;
  END LOOP;

  IF v_close_patti IS NOT NULL THEN
    FOR v_sel_row IN
      SELECT user_id, selections FROM selections
      WHERE game = p_game AND bet_type = 'patti_close'
    LOOP
      v_user_id := v_sel_row.user_id;
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
        IF v_item->>'number' = v_close_patti THEN
          v_bet := (v_item->>'points')::int;
          v_payout := v_bet * 120;
          UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
          INSERT INTO point_ledger (user_id, delta, reason, metadata)
          VALUES (v_user_id, v_payout, 'winning_payout',
            jsonb_build_object('game', p_game, 'bet_type', 'patti_close',
              'number', v_close_patti, 'bet', v_bet, 'multiplier', 120));
          v_winners := v_winners + 1;
          v_total_paid := v_total_paid + v_payout;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  IF v_open_digit IS NOT NULL AND v_close_digit IS NOT NULL THEN
    v_jodi_number := v_open_digit || v_close_digit;
    FOR v_sel_row IN
      SELECT user_id, selections FROM selections
      WHERE game = p_game AND bet_type = 'jodi'
    LOOP
      v_user_id := v_sel_row.user_id;
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
        IF v_item->>'number' = v_jodi_number THEN
          v_bet := (v_item->>'points')::int;
          v_payout := v_bet * 90;
          UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
          INSERT INTO point_ledger (user_id, delta, reason, metadata)
          VALUES (v_user_id, v_payout, 'winning_payout',
            jsonb_build_object('game', p_game, 'bet_type', 'jodi',
              'number', v_jodi_number, 'bet', v_bet, 'multiplier', 90));
          v_winners := v_winners + 1;
          v_total_paid := v_total_paid + v_payout;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  UPDATE winning_results SET close_processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'phase', 'close',
    'winners', v_winners,
    'total_paid', v_total_paid
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION process_close_payouts(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION process_close_payouts(text, date) TO authenticated;

-- ============================================================
-- 7. Get latest results (full result card)
-- ============================================================
CREATE OR REPLACE FUNCTION get_latest_results(p_game text)
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
    'round_date', wr.round_date,
    'open_digit', wr.open_digit,
    'close_digit', wr.close_digit,
    'open_patti', wr.open_patti,
    'close_patti', wr.close_patti,
    'open_posted_at', wr.open_posted_at,
    'close_posted_at', wr.close_posted_at,
    'open_processed', wr.open_processed_at IS NOT NULL,
    'close_processed', wr.close_processed_at IS NOT NULL
  ) INTO v_result
  FROM winning_results wr
  WHERE wr.game = p_game
  ORDER BY wr.round_date DESC, wr.open_posted_at DESC NULLS LAST
  LIMIT 1;

  RETURN COALESCE(v_result, 'null'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION get_latest_results(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_latest_results(text) TO authenticated;

-- ============================================================
-- 8. Updated submit_selection with bet_type parameter
-- ============================================================
CREATE OR REPLACE FUNCTION submit_selection(p_game text, p_selections jsonb, p_bet_type text DEFAULT 'jodi')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_new_total integer := 0;
  v_points integer;
  v_wallet integer;
  v_new_count integer := 0;
  v_item jsonb;
  v_num text;
  v_pts numeric;
  v_existing jsonb := '[]'::jsonb;
  v_existing_nums text[] := '{}';
  v_merged jsonb := '[]'::jsonb;
  v_row jsonb;
  v_existing_total integer := 0;
  v_seen_nums text[] := '{}';
  v_from_points integer;
  v_from_wallet integer;
  v_total_available integer;
  v_num_pattern text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF NOT is_game_open(p_game) THEN
    RAISE EXCEPTION 'This game is closed. Kalyan is open 8 AM to 4 PM (IST) daily.';
  END IF;

  IF p_bet_type NOT IN ('single_open', 'single_close', 'jodi', 'patti_open', 'patti_close') THEN
    RAISE EXCEPTION 'Invalid bet type';
  END IF;

  IF COALESCE(jsonb_typeof(p_selections), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  IF p_bet_type IN ('single_open', 'single_close') THEN
    v_num_pattern := '^\d$';
  ELSIF p_bet_type = 'jodi' THEN
    v_num_pattern := '^\d{2}$';
  ELSIF p_bet_type IN ('patti_open', 'patti_close') THEN
    v_num_pattern := '^\d{3}$';
  END IF;

  SELECT selections INTO v_existing
  FROM selections
  WHERE user_id = v_uid AND game = p_game AND bet_type = p_bet_type;

  IF v_existing IS NULL THEN
    v_existing := '[]'::jsonb;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_existing) LOOP
    v_existing_nums := array_append(v_existing_nums, v_row->>'number');
    v_existing_total := v_existing_total + (v_row->>'points')::int;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_selections) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::numeric;
    IF v_num IS NULL OR v_pts IS NULL THEN
      RAISE EXCEPTION 'Each selection needs a number and points';
    END IF;
    IF NOT (v_num ~ v_num_pattern) THEN
      RAISE EXCEPTION 'Invalid number format for this bet type';
    END IF;
    IF v_pts <= 0 OR v_pts <> floor(v_pts) THEN
      RAISE EXCEPTION 'Points must be a positive whole number';
    END IF;
    IF v_num = ANY(v_existing_nums) THEN
      CONTINUE;
    END IF;
    IF v_num = ANY(v_seen_nums) THEN
      CONTINUE;
    END IF;
    v_seen_nums := array_append(v_seen_nums, v_num);
    v_merged := v_merged || jsonb_build_array(jsonb_build_object('number', v_num, 'points', v_pts::int));
    v_new_total := v_new_total + v_pts::int;
    v_new_count := v_new_count + 1;
  END LOOP;

  IF v_new_count = 0 THEN
    RAISE EXCEPTION 'No new numbers to add. Existing picks are locked.';
  END IF;

  SELECT points, wallet INTO v_points, v_wallet FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_points IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  v_total_available := v_points + v_wallet;

  IF v_total_available < v_new_total THEN
    RAISE EXCEPTION 'Insufficient balance. You have % (play: %, wallet: %), new picks cost %.',
      v_total_available, v_points, v_wallet, v_new_total;
  END IF;

  v_from_points := LEAST(v_points, v_new_total);
  v_from_wallet := v_new_total - v_from_points;

  UPDATE profiles
  SET points = points - v_from_points,
      wallet = wallet - v_from_wallet
  WHERE id = v_uid;

  v_merged := v_existing || v_merged;

  INSERT INTO selections (user_id, game, bet_type, selections, total_points, updated_at)
  VALUES (v_uid, p_game, p_bet_type, v_merged, v_existing_total + v_new_total, now())
  ON CONFLICT (user_id, game, bet_type)
  DO UPDATE SET
    selections = EXCLUDED.selections,
    total_points = EXCLUDED.total_points,
    updated_at = now();

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -v_new_total, 'selection_submit',
    jsonb_build_object(
      'game', p_game,
      'bet_type', p_bet_type,
      'new_numbers', v_new_count,
      'from_points', v_from_points,
      'from_wallet', v_from_wallet
    ));

  RETURN jsonb_build_object(
    'points', v_points - v_from_points,
    'wallet', v_wallet - v_from_wallet,
    'new_points', v_new_total,
    'new_count', v_new_count,
    'total_numbers', jsonb_array_length(v_merged)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_selection(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_selection(text, jsonb, text) TO authenticated;

-- ============================================================
-- 9. Updated admin_list_selections with bet_type
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
    RAISE EXCEPTION 'Only the admin can list selections';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'user_name', p.display_name,
      'bet_type', s.bet_type,
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
-- 10. Updated admin_get_stats with bet_type counts
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
  v_banned integer;
  v_admin_count integer;
  v_total_points integer;
  v_total_wallet integer;
  v_pending_wd_count integer;
  v_pending_wd_amount integer;
  v_pending_af_count integer;
  v_pending_af_amount integer;
  v_sel_single_open integer;
  v_sel_single_close integer;
  v_sel_jodi integer;
  v_sel_patti_open integer;
  v_sel_patti_close integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can view stats';
  END IF;

  SELECT count(*), COALESCE(SUM(CASE WHEN is_banned THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN is_admin THEN 1 ELSE 0 END), 0),
         COALESCE(SUM(points), 0), COALESCE(SUM(wallet), 0)
  INTO v_total_users, v_banned, v_admin_count, v_total_points, v_total_wallet
  FROM profiles;

  SELECT count(*), COALESCE(SUM(amount), 0) INTO v_pending_wd_count, v_pending_wd_amount
  FROM withdrawals WHERE status = 'pending';

  SELECT count(*), COALESCE(SUM(amount), 0) INTO v_pending_af_count, v_pending_af_amount
  FROM add_funds_requests WHERE status = 'pending';

  SELECT count(*) INTO v_sel_single_open FROM selections WHERE bet_type = 'single_open';
  SELECT count(*) INTO v_sel_single_close FROM selections WHERE bet_type = 'single_close';
  SELECT count(*) INTO v_sel_jodi FROM selections WHERE bet_type = 'jodi';
  SELECT count(*) INTO v_sel_patti_open FROM selections WHERE bet_type = 'patti_open';
  SELECT count(*) INTO v_sel_patti_close FROM selections WHERE bet_type = 'patti_close';

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'banned_users', v_banned,
    'admin_count', v_admin_count,
    'total_points', v_total_points,
    'total_wallet', v_total_wallet,
    'pending_withdrawals_count', v_pending_wd_count,
    'pending_withdrawals_amount', v_pending_wd_amount,
    'pending_addfunds_count', v_pending_af_count,
    'pending_addfunds_amount', v_pending_af_amount,
    'sel_single_open', v_sel_single_open,
    'sel_single_close', v_sel_single_close,
    'sel_jodi', v_sel_jodi,
    'sel_patti_open', v_sel_patti_open,
    'sel_patti_close', v_sel_patti_close
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_get_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_get_stats() TO authenticated;