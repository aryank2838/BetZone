CREATE OR REPLACE FUNCTION public.get_game_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_server_ist timestamp without time zone := v_now AT TIME ZONE 'Asia/Kolkata';
  v_server_ist_date date := v_server_ist::date;
  v_server_ist_time time := v_server_ist::time;
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
        'server_now', v_now,
        'server_ist_date', v_server_ist_date,
        'server_ist_time', to_char(v_server_ist_time, 'HH24:MI:SS'),
        'close_result_next_day', g.close_result_next_day,
        'open_bets_open', public.bet_round(g.game, 'jodi') IS NOT NULL,
        'close_bets_open', public.bet_round(g.game, 'single_close') IS NOT NULL,
        'bets_open_at', to_char(g.bets_open, 'HH24:MI'),
        'open_bets_close_at', to_char(g.open_bets_close, 'HH24:MI'),
        'close_bets_close_at', to_char(g.close_bets_close, 'HH24:MI'),
        'open_bets_close_ts',
          (CASE
            WHEN (v_server_ist_date + g.open_bets_close) > v_server_ist
              THEN v_server_ist_date
            ELSE v_server_ist_date + 1
          END + g.open_bets_close) AT TIME ZONE 'Asia/Kolkata',
        'close_bets_close_ts',
          (CASE
            WHEN (v_server_ist_date + g.close_bets_close) > v_server_ist
              THEN v_server_ist_date
            ELSE v_server_ist_date + 1
          END + g.close_bets_close) AT TIME ZONE 'Asia/Kolkata',
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

CREATE OR REPLACE FUNCTION public.bet_multiplier(p_bet_type text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN CASE p_bet_type
    WHEN 'single_open' THEN 9
    WHEN 'single_close' THEN 9
    WHEN 'jodi' THEN 90
    WHEN 'patti_open' THEN 120
    WHEN 'patti_close' THEN 120
    ELSE NULL
  END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bet_multiplier(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_bets(
  p_game text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(game text, round_date date, bet_type text, picks jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  IF p_game IS NOT NULL AND p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  RETURN QUERY
  WITH selected_rounds AS (
    SELECT
      s.game,
      s.round_date,
      s.bet_type,
      s.selections,
      wr.open_digit,
      wr.close_digit,
      wr.open_patti,
      wr.close_patti,
      wr.open_processed_at IS NOT NULL AS open_paid,
      wr.close_processed_at IS NOT NULL AS close_paid
    FROM public.selections s
    LEFT JOIN public.winning_results wr
      ON wr.game = s.game AND wr.round_date = s.round_date
    WHERE s.user_id = v_uid
      AND (p_game IS NULL OR s.game = p_game)
      AND (p_from IS NULL OR s.round_date >= p_from)
      AND (p_to IS NULL OR s.round_date <= p_to)
    ORDER BY s.round_date DESC, s.game, s.bet_type
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    r.game,
    r.round_date,
    r.bet_type,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'number', entry.item->>'number',
          'stake', (entry.item->>'points')::integer,
          'status', CASE
            WHEN NOT CASE
              WHEN r.bet_type IN ('single_open', 'patti_open') THEN r.open_paid
              ELSE r.close_paid
            END THEN 'pending'
            WHEN entry.item->>'number' = CASE r.bet_type
              WHEN 'single_open' THEN r.open_digit
              WHEN 'single_close' THEN r.close_digit
              WHEN 'jodi' THEN r.open_digit || r.close_digit
              WHEN 'patti_open' THEN r.open_patti || '-' || r.open_digit
              WHEN 'patti_close' THEN r.close_patti || '-' || r.close_digit
            END THEN 'won'
            ELSE 'lost'
          END,
          'payout', CASE
            WHEN CASE
              WHEN r.bet_type IN ('single_open', 'patti_open') THEN r.open_paid
              ELSE r.close_paid
            END
              AND entry.item->>'number' = CASE r.bet_type
                WHEN 'single_open' THEN r.open_digit
                WHEN 'single_close' THEN r.close_digit
                WHEN 'jodi' THEN r.open_digit || r.close_digit
                WHEN 'patti_open' THEN r.open_patti || '-' || r.open_digit
                WHEN 'patti_close' THEN r.close_patti || '-' || r.close_digit
              END
            THEN (entry.item->>'points')::integer * public.bet_multiplier(r.bet_type)
            ELSE 0
          END
        )
        ORDER BY entry.ordinality
      )
      FROM jsonb_array_elements(r.selections) WITH ORDINALITY AS entry(item, ordinality)
    ), '[]'::jsonb)
  FROM selected_rounds r
  ORDER BY r.round_date DESC, r.game, r.bet_type;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_bets(text, date, date, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_bets(text, date, date, integer, integer)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_result_history(
  p_game text,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  round_date date,
  open_patti text,
  open_digit text,
  close_patti text,
  close_digit text,
  jodi text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  RETURN QUERY
  SELECT
    wr.round_date,
    wr.open_patti,
    wr.open_digit,
    wr.close_patti,
    wr.close_digit,
    CASE WHEN wr.open_digit IS NOT NULL AND wr.close_digit IS NOT NULL
      THEN wr.open_digit || wr.close_digit
      ELSE NULL
    END
  FROM public.winning_results wr
  WHERE wr.game = p_game
  ORDER BY wr.round_date DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_result_history(text, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_result_history(text, integer, integer)
  TO authenticated;
