CREATE OR REPLACE FUNCTION get_game_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'game', g.game,
        'label', g.label,
        'round_date', (now() AT TIME ZONE 'Asia/Kolkata')::date,
        'open_bets_open', bet_round(g.game, 'jodi') IS NOT NULL,
        'close_bets_open', bet_round(g.game, 'single_close') IS NOT NULL,
        'bets_open_at', to_char(g.bets_open, 'HH24:MI'),
        'open_bets_close_at', to_char(g.open_bets_close, 'HH24:MI'),
        'close_bets_close_at', to_char(g.close_bets_close, 'HH24:MI'),
        'open_result_at', to_char(g.open_result_at, 'HH24:MI'),
        'close_result_at', to_char(g.close_result_at, 'HH24:MI')
      )
      ORDER BY g.game
    )
    FROM game_schedule g
  ), '[]'::jsonb);
END
$$;

REVOKE EXECUTE ON FUNCTION get_game_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_game_status() TO authenticated;
