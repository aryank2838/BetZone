CREATE OR REPLACE FUNCTION submit_selection(
  p_game text,
  p_selections jsonb,
  p_bet_type text DEFAULT 'jodi'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_round date;
  v_points integer;
  v_wallet integer;
  v_banned boolean;
  v_existing jsonb;
  v_existing_nums text[] := '{}';
  v_existing_total integer := 0;
  v_new jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_new_total integer := 0;
  v_new_count integer := 0;
  v_item jsonb;
  v_row jsonb;
  v_num text;
  v_pts numeric;
  v_from_points integer;
  v_from_wallet integer;
  v_max_bet CONSTANT integer := 5000;
  v_max_submit CONSTANT integer := 20000;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM game_schedule WHERE game = p_game) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_bet_type NOT IN ('single_open', 'single_close', 'jodi', 'patti_open', 'patti_close') THEN
    RAISE EXCEPTION 'Invalid bet type';
  END IF;
  IF COALESCE(jsonb_typeof(p_selections), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  SELECT points, wallet, is_banned
  INTO v_points, v_wallet, v_banned
  FROM profiles
  WHERE id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF COALESCE(v_banned, false) THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  v_round := bet_round(p_game, p_bet_type);
  IF v_round IS NULL THEN
    RAISE EXCEPTION 'Betting is closed for this bet type right now.';
  END IF;

  SELECT selections INTO v_existing
  FROM selections
  WHERE user_id = v_uid
    AND game = p_game
    AND bet_type = p_bet_type
    AND round_date = v_round;
  v_existing := COALESCE(v_existing, '[]'::jsonb);

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
    IF p_bet_type IN ('single_open', 'single_close') THEN
      IF v_num !~ '^[0-9]$' THEN
        RAISE EXCEPTION 'Single bets must be one digit (0-9)';
      END IF;
    ELSIF p_bet_type = 'jodi' THEN
      IF v_num !~ '^[0-9]{2}$' THEN
        RAISE EXCEPTION 'Jodi must be two digits (00-99)';
      END IF;
    ELSIF NOT is_valid_patti_combo(v_num) THEN
      RAISE EXCEPTION 'Invalid patti-digit combination: %', v_num;
    END IF;
    IF v_pts <> floor(v_pts) OR v_pts < 1 OR v_pts > v_max_bet THEN
      RAISE EXCEPTION 'Each bet must be a whole number from 1 to %', v_max_bet;
    END IF;
    IF v_num = ANY(v_existing_nums) OR v_num = ANY(v_seen) THEN
      CONTINUE;
    END IF;
    v_seen := array_append(v_seen, v_num);
    v_new := v_new || jsonb_build_array(
      jsonb_build_object('number', v_num, 'points', v_pts::int)
    );
    v_new_total := v_new_total + v_pts::int;
    v_new_count := v_new_count + 1;
  END LOOP;

  IF v_new_count = 0 THEN
    RAISE EXCEPTION 'No new numbers to add. Existing picks for this round are locked.';
  END IF;
  IF v_new_total > v_max_submit THEN
    RAISE EXCEPTION 'A single submit can total at most % points', v_max_submit;
  END IF;
  IF v_points + v_wallet < v_new_total THEN
    RAISE EXCEPTION
      'Insufficient balance. You have % (play: %, wallet: %), new picks cost %.',
      v_points + v_wallet, v_points, v_wallet, v_new_total;
  END IF;

  v_from_points := LEAST(v_points, v_new_total);
  v_from_wallet := v_new_total - v_from_points;

  UPDATE profiles
  SET points = points - v_from_points,
      wallet = wallet - v_from_wallet
  WHERE id = v_uid;

  INSERT INTO selections (
    user_id, game, bet_type, round_date, selections, total_points, updated_at
  )
  VALUES (
    v_uid, p_game, p_bet_type, v_round, v_existing || v_new,
    v_existing_total + v_new_total, now()
  )
  ON CONFLICT (user_id, game, bet_type, round_date)
  DO UPDATE SET
    selections = EXCLUDED.selections,
    total_points = EXCLUDED.total_points,
    updated_at = now();

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (
    v_uid,
    -v_new_total,
    'selection_submit',
    jsonb_build_object(
      'game', p_game,
      'bet_type', p_bet_type,
      'round_date', v_round,
      'new_numbers', v_new_count,
      'from_points', v_from_points,
      'from_wallet', v_from_wallet
    )
  );

  RETURN jsonb_build_object(
    'points', v_points - v_from_points,
    'wallet', v_wallet - v_from_wallet,
    'new_points', v_new_total,
    'new_count', v_new_count,
    'total_numbers', jsonb_array_length(v_existing) + v_new_count,
    'round_date', v_round
  );
END
$$;

REVOKE EXECUTE ON FUNCTION submit_selection(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_selection(text, jsonb, text) TO authenticated;
