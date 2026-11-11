CREATE OR REPLACE FUNCTION public.get_game_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_server_ist_date date := (v_now AT TIME ZONE 'Asia/Kolkata')::date;
  v_server_ist_time time := (v_now AT TIME ZONE 'Asia/Kolkata')::time;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'game', g.game,
        'label', g.label,
        'round_date', v_server_ist_date,
        'server_ist_date', v_server_ist_date,
        'server_ist_time', to_char(v_server_ist_time, 'HH24:MI:SS'),
        'close_result_next_day', g.close_result_next_day,
        'open_bets_open', public.bet_round(g.game, 'jodi') IS NOT NULL,
        'close_bets_open', public.bet_round(g.game, 'single_close') IS NOT NULL,
        'bets_open_at', to_char(g.bets_open, 'HH24:MI'),
        'open_bets_close_at', to_char(g.open_bets_close, 'HH24:MI'),
        'close_bets_close_at', to_char(g.close_bets_close, 'HH24:MI'),
        'open_result_at', to_char(g.open_result_at, 'HH24:MI'),
        'close_result_at', to_char(g.close_result_at, 'HH24:MI')
      )
      ORDER BY g.game
    )
    FROM public.game_schedule g
  ), '[]'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_game_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_game_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_all_latest_results()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'game', latest.game,
      'round_date', latest.round_date,
      'open_digit', latest.open_digit,
      'close_digit', latest.close_digit,
      'open_patti', latest.open_patti,
      'close_patti', latest.close_patti,
      'open_posted_at', latest.open_posted_at,
      'close_posted_at', latest.close_posted_at,
      'open_processed', latest.open_processed_at IS NOT NULL,
      'close_processed', latest.close_processed_at IS NOT NULL
    ) ORDER BY latest.game
  ), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT DISTINCT ON (wr.game)
      wr.game,
      wr.round_date,
      wr.open_digit,
      wr.close_digit,
      wr.open_patti,
      wr.close_patti,
      wr.open_posted_at,
      wr.close_posted_at,
      wr.open_processed_at,
      wr.close_processed_at
    FROM public.winning_results wr
    ORDER BY wr.game, wr.round_date DESC, wr.open_posted_at DESC NULLS LAST
  ) latest;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_all_latest_results() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_all_latest_results() TO authenticated;

DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, pg_temp',
      v_function.nspname,
      v_function.proname,
      v_function.identity_args
    );
  END LOOP;
END;
$$;
