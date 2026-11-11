/*
# Server-enforced game hours (fixed timezone: Asia/Kolkata, IST)

## Why
The Test game must be open 08:00–16:00 every day, with the same window for all
users regardless of their local device clock. Enforcing it on the server (in a
fixed timezone) is the only way to guarantee that — a client-side check can be
bypassed or disagree across timezones.

## What
- `is_game_open(p_game text)`: returns true/false based on the current hour in
  IST. Test = 08:00–16:00, Test2 = open all day.
- `submit_selection`: now also checks `is_game_open` before accepting a submit,
  so even if the client is stale or tampered with, the server refuses.
- `get_game_status()`: returns { game, label, open, opens_at, closes_at } for all
  games, so the client can render open/closed badges from one call.
*/

CREATE OR REPLACE FUNCTION is_game_open(p_game text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hour int;
BEGIN
  IF p_game = 'test2' THEN
    RETURN true;  -- open 24/7
  END IF;

  IF p_game = 'test' THEN
    -- Hour of day in IST (Asia/Kolkata, fixed UTC+5:30)
    v_hour := EXTRACT(HOUR FROM now() AT TIME ZONE 'Asia/Kolkata')::int;
    RETURN v_hour >= 8 AND v_hour < 16;
  END IF;

  RETURN false;
END;
$$;

REVOKE EXECUTE ON FUNCTION is_game_open(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_game_open(text) TO authenticated;

-- ---------- get_game_status: batch status for the dashboard ----------
CREATE OR REPLACE FUNCTION get_game_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN jsonb_build_array(
    jsonb_build_object(
      'game', 'test',
      'label', 'Test',
      'open', is_game_open('test'),
      'opens_at', '08:00',
      'closes_at', '16:00'
    ),
    jsonb_build_object(
      'game', 'test2',
      'label', 'Test2',
      'open', true,
      'opens_at', null,
      'closes_at', null
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION get_game_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_game_status() TO authenticated;

-- ---------- Enforce hours inside submit_selection ----------
CREATE OR REPLACE FUNCTION submit_selection(p_game text, p_selections jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_new_total integer := 0;
  v_balance integer;
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  -- Enforce fixed game hours (IST)
  IF NOT is_game_open(p_game) THEN
    RAISE EXCEPTION 'This game is closed. Test is open 8 AM to 4 PM (IST) daily.';
  END IF;

  IF COALESCE(jsonb_typeof(p_selections), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  SELECT selections INTO v_existing
  FROM selections
  WHERE user_id = v_uid AND game = p_game;

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
    IF NOT (v_num ~ '^\d{2}$') OR v_num::int > 99 THEN
      RAISE EXCEPTION 'Number must be between 00 and 99';
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

  SELECT points INTO v_balance FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_balance < v_new_total THEN
    RAISE EXCEPTION 'Insufficient points. You have %, new picks cost %.', v_balance, v_new_total;
  END IF;

  UPDATE profiles
  SET points = points - v_new_total
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
    jsonb_build_object('game', p_game, 'new_numbers', v_new_count));

  RETURN jsonb_build_object(
    'points', v_balance - v_new_total,
    'new_points', v_new_total,
    'new_count', v_new_count,
    'total_numbers', jsonb_array_length(v_merged)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_selection(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_selection(text, jsonb) TO authenticated;
