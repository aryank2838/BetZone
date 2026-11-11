/*
# Playable wallet: spend points first, then wallet

## Why
Users should be able to play with BOTH their play balance (signup + ad rewards)
AND their withdrawable wallet (winnings). The play balance must be spent first;
the wallet is only drawn from when the play balance is insufficient.

## Changes
- `submit_selection`: checks `points + wallet` as the available pool, deducts
  from `points` first, then from `wallet` for the remainder. Ledger records the
  split so the breakdown stays accurate. Returns both `points` and `wallet`
  after the deduction.
- No schema changes. All existing behavior (locked picks, dedup, validation) is
  preserved.
*/

CREATE OR REPLACE FUNCTION submit_selection(p_game text, p_selections jsonb)
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF COALESCE(jsonb_typeof(p_selections), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  -- Load existing locked selection for this game
  SELECT selections INTO v_existing
  FROM selections
  WHERE user_id = v_uid AND game = p_game;

  IF v_existing IS NULL THEN
    v_existing := '[]'::jsonb;
  END IF;

  -- Iterate existing locked picks
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_existing) LOOP
    v_existing_nums := array_append(v_existing_nums, v_row->>'number');
    v_existing_total := v_existing_total + (v_row->>'points')::int;
  END LOOP;

  -- Process incoming NEW picks
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
    -- Skip numbers already locked (cannot change existing picks)
    IF v_num = ANY(v_existing_nums) THEN
      CONTINUE;
    END IF;
    -- Dedupe within the incoming batch
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

  -- Lock the row and read both balances
  SELECT points, wallet INTO v_points, v_wallet FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_points IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  v_total_available := v_points + v_wallet;

  IF v_total_available < v_new_total THEN
    RAISE EXCEPTION 'Insufficient balance. You have % (play: %, wallet: %), new picks cost %.',
      v_total_available, v_points, v_wallet, v_new_total;
  END IF;

  -- Spend points first, then wallet
  v_from_points := LEAST(v_points, v_new_total);
  v_from_wallet := v_new_total - v_from_points;

  UPDATE profiles
  SET points = points - v_from_points,
      wallet = wallet - v_from_wallet
  WHERE id = v_uid;

  v_merged := v_existing || v_merged;

  INSERT INTO selections (user_id, game, selections, total_points, updated_at)
  VALUES (v_uid, p_game, v_merged, v_existing_total + v_new_total, now())
  ON CONFLICT (user_id, game)
  DO UPDATE SET
    selections = EXCLUDED.selections,
    total_points = EXCLUDED.total_points,
    updated_at = now();

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -v_new_total, 'selection_submit',
    jsonb_build_object(
      'game', p_game,
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

REVOKE EXECUTE ON FUNCTION submit_selection(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_selection(text, jsonb) TO authenticated;
