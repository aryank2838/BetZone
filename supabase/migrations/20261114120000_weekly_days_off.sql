/*
# Weekly days off per game

Games now have fixed weekly days off, stored as ISO weekdays
(1 = Monday ... 7 = Sunday) in game_schedule.closed_weekdays:

- Main Bazaar (test2): closed Saturday and Sunday (runs Monday to Friday)
- Kalyan (test), Milan Day (test3), Milan Night (test4): closed Sunday

On a day off a game takes no bets for that day's round. This is separate from
the admin holiday switch (holiday_reopens_on), which still works as before.

Results are not blocked on a day off. Main Bazaar's Friday close result is
posted at 12:10 AM on Saturday and still belongs to Friday's round.

## Changes
- game_schedule.closed_weekdays smallint[] (default: no days off)
- game_closed_on(game, date): true when that date is one of the game's days off
- bet_round(): returns NULL (betting closed) on a day off, so submit_selection
  and get_game_status both enforce it on the server
- get_game_status(): adds closed_weekdays, day_off and day_off_reopens_on
*/

ALTER TABLE public.game_schedule
  ADD COLUMN IF NOT EXISTS closed_weekdays smallint[] NOT NULL DEFAULT '{}';

ALTER TABLE public.game_schedule
  DROP CONSTRAINT IF EXISTS game_schedule_closed_weekdays_valid;
ALTER TABLE public.game_schedule
  ADD CONSTRAINT game_schedule_closed_weekdays_valid
  CHECK (closed_weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
         AND cardinality(closed_weekdays) < 7);

UPDATE public.game_schedule SET closed_weekdays = '{6,7}' WHERE game = 'test2';
UPDATE public.game_schedule SET closed_weekdays = '{7}' WHERE game IN ('test', 'test3', 'test4');

CREATE OR REPLACE FUNCTION public.game_closed_on(p_game text, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.game_schedule g
    WHERE g.game = p_game
      AND extract(isodow FROM p_date)::smallint = ANY (g.closed_weekdays)
  );
$$;
REVOKE EXECUTE ON FUNCTION public.game_closed_on(text, date) FROM PUBLIC, anon, authenticated;

-- bet_round is the single gate used by submit_selection and get_game_status.
CREATE OR REPLACE FUNCTION public.bet_round(p_game text, p_bet_type text)
RETURNS date
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamp without time zone;
  v_round date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF public.game_on_holiday(p_game) THEN
    RETURN NULL;
  END IF;

  v_now := clock_timestamp() AT TIME ZONE 'Asia/Kolkata';

  IF public.game_closed_on(p_game, v_now::date) THEN
    RETURN NULL;
  END IF;

  SELECT v_now::date
  INTO v_round
  FROM public.game_schedule g
  WHERE g.game = p_game
    AND v_now::time >= g.bets_open
    AND v_now::time <
      CASE
        WHEN p_bet_type IN ('single_close', 'patti_close')
          THEN g.close_bets_close
        ELSE g.open_bets_close
      END;

  RETURN v_round;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.bet_round(text, text) FROM PUBLIC, anon, authenticated;

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
        'on_holiday', g.holiday_reopens_on IS NOT NULL AND v_server_ist_date < g.holiday_reopens_on,
        'holiday_reopens_on',
          CASE WHEN g.holiday_reopens_on IS NOT NULL AND v_server_ist_date < g.holiday_reopens_on
            THEN g.holiday_reopens_on END,
        'holiday_note',
          CASE WHEN g.holiday_reopens_on IS NOT NULL AND v_server_ist_date < g.holiday_reopens_on
            THEN g.holiday_note END,
        'closed_weekdays', to_jsonb(g.closed_weekdays),
        'day_off', extract(isodow FROM v_server_ist_date)::smallint = ANY (g.closed_weekdays),
        'day_off_reopens_on',
          CASE WHEN extract(isodow FROM v_server_ist_date)::smallint = ANY (g.closed_weekdays) THEN (
            SELECT v_server_ist_date + n
            FROM generate_series(1, 7) AS n
            WHERE NOT (extract(isodow FROM v_server_ist_date + n)::smallint = ANY (g.closed_weekdays))
            ORDER BY n
            LIMIT 1
          ) END,
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
