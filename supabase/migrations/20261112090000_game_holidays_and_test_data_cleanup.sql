-- 1. Remove test data entered before launch.
--    Only rows dated on or before 2026-11-12 are removed, so real results and
--    bets placed after this migration can never be affected by it.
DELETE FROM public.selections WHERE round_date <= DATE '2026-11-12';
DELETE FROM public.winning_results WHERE round_date <= DATE '2026-11-12';

-- 2. Per-game holiday. While today's IST date is before holiday_reopens_on,
--    the game takes no bets. Betting resumes by itself on that date.
ALTER TABLE public.game_schedule
  ADD COLUMN IF NOT EXISTS holiday_reopens_on date,
  ADD COLUMN IF NOT EXISTS holiday_note text;

ALTER TABLE public.game_schedule
  DROP CONSTRAINT IF EXISTS game_schedule_holiday_note_length;
ALTER TABLE public.game_schedule
  ADD CONSTRAINT game_schedule_holiday_note_length
  CHECK (holiday_note IS NULL OR char_length(holiday_note) <= 160);

CREATE OR REPLACE FUNCTION public.game_on_holiday(p_game text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.game_schedule g
    WHERE g.game = p_game
      AND g.holiday_reopens_on IS NOT NULL
      AND (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date < g.holiday_reopens_on
  );
$$;
REVOKE EXECUTE ON FUNCTION public.game_on_holiday(text) FROM PUBLIC, anon, authenticated;

-- bet_round is the single gate used by submit_selection and get_game_status,
-- so closing it here blocks betting on the server, not just in the app.
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

-- 3. Admin control. p_reopens_on NULL ends the holiday now.
ALTER TABLE public.admin_action_log
  DROP CONSTRAINT IF EXISTS admin_action_log_action_check;
ALTER TABLE public.admin_action_log
  ADD CONSTRAINT admin_action_log_action_check
  CHECK (action IN (
    'ban', 'unban', 'grant_admin', 'revoke_admin',
    'adjust_points', 'adjust_wallet',
    'approve_withdrawal', 'reject_withdrawal',
    'approve_add_funds', 'reject_add_funds',
    'post_open_result', 'post_close_result', 'set_setting',
    'close_support_ticket', 'add_blocked_domain',
    'set_holiday', 'end_holiday'
  ));

CREATE OR REPLACE FUNCTION public.admin_set_game_holiday(
  p_game text,
  p_reopens_on date,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_today date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can set holidays'; END IF;
  IF p_game IS NULL OR NOT EXISTS (SELECT 1 FROM public.game_schedule WHERE game = p_game) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_reopens_on IS NOT NULL AND p_reopens_on <= v_today THEN
    RAISE EXCEPTION 'Reopen date must be after today';
  END IF;
  IF p_reopens_on IS NOT NULL AND p_reopens_on > v_today + 366 THEN
    RAISE EXCEPTION 'Reopen date must be within a year';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 160 THEN
    RAISE EXCEPTION 'Holiday note cannot exceed 160 characters';
  END IF;

  UPDATE public.game_schedule
  SET holiday_reopens_on = p_reopens_on,
      holiday_note = CASE WHEN p_reopens_on IS NULL THEN NULL ELSE v_note END
  WHERE game = p_game;

  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (
    v_uid,
    CASE WHEN p_reopens_on IS NULL THEN 'end_holiday' ELSE 'set_holiday' END,
    jsonb_build_object('game', p_game, 'reopens_on', p_reopens_on, 'note', v_note)
  );

  RETURN jsonb_build_object('game', p_game, 'reopens_on', p_reopens_on, 'note', v_note);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_set_game_holiday(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_game_holiday(text, date, text) TO authenticated;
