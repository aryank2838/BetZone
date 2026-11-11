CREATE OR REPLACE FUNCTION admin_post_open_result(
  p_game text,
  p_round_date date,
  p_patti text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sched game_schedule%ROWTYPE;
  v_done timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF p_round_date IS NULL THEN
    RAISE EXCEPTION 'Round date is required';
  END IF;

  SELECT * INTO v_sched
  FROM game_schedule
  WHERE game = p_game;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF NOT is_valid_patti(p_patti) THEN
    RAISE EXCEPTION 'Invalid patti';
  END IF;
  IF now() < (
    (p_round_date + v_sched.open_bets_close)::timestamp AT TIME ZONE 'Asia/Kolkata'
  ) THEN
    RAISE EXCEPTION 'Open betting for this round has not closed yet';
  END IF;

  INSERT INTO winning_results (game, round_date)
  VALUES (p_game, p_round_date)
  ON CONFLICT (game, round_date) DO NOTHING;

  SELECT open_processed_at INTO v_done
  FROM winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Open result for this round was already posted and paid';
  END IF;

  UPDATE winning_results
  SET open_patti = p_patti,
      open_digit = patti_digit(p_patti)::text,
      open_posted_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN process_open_payouts(p_game, p_round_date);
END
$$;

CREATE OR REPLACE FUNCTION admin_post_close_result(
  p_game text,
  p_round_date date,
  p_patti text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sched game_schedule%ROWTYPE;
  v_open_done timestamptz;
  v_done timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF p_round_date IS NULL THEN
    RAISE EXCEPTION 'Round date is required';
  END IF;

  SELECT * INTO v_sched
  FROM game_schedule
  WHERE game = p_game;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF NOT is_valid_patti(p_patti) THEN
    RAISE EXCEPTION 'Invalid patti';
  END IF;
  IF now() < (
    (p_round_date + v_sched.close_bets_close)::timestamp AT TIME ZONE 'Asia/Kolkata'
  ) THEN
    RAISE EXCEPTION 'Close betting for this round has not closed yet';
  END IF;

  SELECT open_processed_at, close_processed_at
  INTO v_open_done, v_done
  FROM winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;
  IF NOT FOUND OR v_open_done IS NULL THEN
    RAISE EXCEPTION 'Post the open result first';
  END IF;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Close result for this round was already posted and paid';
  END IF;

  UPDATE winning_results
  SET close_patti = p_patti,
      close_digit = patti_digit(p_patti)::text,
      close_posted_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN process_close_payouts(p_game, p_round_date);
END
$$;

REVOKE EXECUTE ON FUNCTION admin_post_open_result(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_post_open_result(text, date, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION admin_post_close_result(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_post_close_result(text, date, text) TO authenticated;
