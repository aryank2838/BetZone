/*
# Patti bets now require both patti AND digit to match

## Overview
Previously, patti_open/patti_close bets only matched the 3-digit patti number
independently. Now the user must bet a combined "patti-digit" pair (e.g. "123-6")
and the 120x payout only fires if BOTH the 3-digit patti AND the 1-digit digit
match the posted result exactly.

## Changes
1. submit_selection: validation pattern for patti_open/patti_close changes
   from `^\d{3}$` to `^\d{3}-\d$` (format: "123-6")
2. process_open_payouts: patti_open match changes from `number = open_patti`
   to `number = open_patti || '-' || open_digit`
3. process_close_payouts: patti_close match changes from `number = close_patti`
   to `number = close_patti || '-' || close_digit`
*/

-- ============================================================
-- 1. Update submit_selection validation for patti format
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
    v_num_pattern := '^\d{3}-\d$';
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
-- 2. Update process_open_payouts — patti_open must match patti+digit combo
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
  v_combo text;
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

  -- Single open: 9x payout for matching the open digit
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

  -- Patti open: 120x payout only if BOTH patti AND digit match (stored as "123-6")
  IF v_open_patti IS NOT NULL AND v_open_digit IS NOT NULL THEN
    v_combo := v_open_patti || '-' || v_open_digit;
    FOR v_sel_row IN
      SELECT user_id, selections FROM selections
      WHERE game = p_game AND bet_type = 'patti_open'
    LOOP
      v_user_id := v_sel_row.user_id;
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
        IF v_item->>'number' = v_combo THEN
          v_bet := (v_item->>'points')::int;
          v_payout := v_bet * 120;
          UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
          INSERT INTO point_ledger (user_id, delta, reason, metadata)
          VALUES (v_user_id, v_payout, 'winning_payout',
            jsonb_build_object('game', p_game, 'bet_type', 'patti_open',
              'number', v_combo, 'bet', v_bet, 'multiplier', 120));
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
-- 3. Update process_close_payouts — patti_close must match patti+digit combo
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
  v_combo text;
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

  -- Single close: 9x payout for matching the close digit
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

  -- Patti close: 120x payout only if BOTH patti AND digit match (stored as "513-9")
  IF v_close_patti IS NOT NULL AND v_close_digit IS NOT NULL THEN
    v_combo := v_close_patti || '-' || v_close_digit;
    FOR v_sel_row IN
      SELECT user_id, selections FROM selections
      WHERE game = p_game AND bet_type = 'patti_close'
    LOOP
      v_user_id := v_sel_row.user_id;
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_sel_row.selections) LOOP
        IF v_item->>'number' = v_combo THEN
          v_bet := (v_item->>'points')::int;
          v_payout := v_bet * 120;
          UPDATE profiles SET wallet = wallet + v_payout WHERE id = v_user_id;
          INSERT INTO point_ledger (user_id, delta, reason, metadata)
          VALUES (v_user_id, v_payout, 'winning_payout',
            jsonb_build_object('game', p_game, 'bet_type', 'patti_close',
              'number', v_combo, 'bet', v_bet, 'multiplier', 120));
          v_winners := v_winners + 1;
          v_total_paid := v_total_paid + v_payout;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  -- Jodi: 90x payout if both open and close digits posted
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
