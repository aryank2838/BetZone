/*
A jodi is the open digit followed by the close digit. Once the open result is
posted and paid, a jodi whose first digit is not the open digit can no longer
win, so it now shows as lost straight away instead of "waiting" until the close
result.

Only how bets are shown changes; no money moves. Lost bets pay nothing, so
payouts stay exactly as before: winning jodis are still paid with the close
result by process_close_payouts().

Updated:
  - get_my_bets()        player's My Bets: the pick is 'lost' and its stake
                         no longer counts as waiting for a result.
  - admin_bets_board()   admin Bets tab: same rule.
  - admin_get_exposure() a jodi that can no longer win is left out of the
                         payout risk and the close worst case.
*/

-- A jodi pick that the posted open result has already ruled out.
CREATE OR REPLACE FUNCTION public.jodi_ruled_out(p_bet_type text, p_number text, p_open_digit text, p_open_paid boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_bet_type = 'jodi'
    AND COALESCE(p_open_paid, false)
    AND p_open_digit IS NOT NULL
    AND left(COALESCE(p_number, ''), 1) <> p_open_digit
$$;
REVOKE EXECUTE ON FUNCTION public.jodi_ruled_out(text, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_my_bets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_bets(
  p_game text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  game text,
  round_date date,
  bet_types jsonb,
  staked bigint,
  won bigint,
  pending_stake bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_game IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.game_schedule gs WHERE gs.game = p_game
  ) THEN RAISE EXCEPTION 'Invalid game'; END IF;

  RETURN QUERY
  WITH selected_rounds AS (
    SELECT DISTINCT s.game, s.round_date
    FROM public.selections s
    WHERE s.user_id = v_uid
      AND (p_game IS NULL OR s.game = p_game)
      AND (p_from IS NULL OR s.round_date >= p_from)
      AND (p_to IS NULL OR s.round_date <= p_to)
    ORDER BY s.round_date DESC, s.game
    LIMIT v_limit OFFSET v_offset
  ), raw_picks AS (
    SELECT s.game, s.round_date, s.bet_type, wr.open_digit, wr.close_digit,
      wr.open_patti, wr.close_patti,
      CASE WHEN s.bet_type IN ('single_open', 'patti_open')
        THEN wr.open_processed_at IS NOT NULL
        ELSE wr.close_processed_at IS NOT NULL END AS phase_paid,
      public.jodi_ruled_out(s.bet_type, entry.item->>'number', wr.open_digit, wr.open_processed_at IS NOT NULL) AS ruled_out,
      entry.item->>'number' AS number,
      (entry.item->>'points')::integer AS stake,
      entry.ordinality AS pick_order,
      CASE s.bet_type
        WHEN 'single_open' THEN wr.open_digit
        WHEN 'single_close' THEN wr.close_digit
        WHEN 'jodi' THEN wr.open_digit || wr.close_digit
        WHEN 'patti_open' THEN wr.open_patti || '-' || wr.open_digit
        WHEN 'patti_close' THEN wr.close_patti || '-' || wr.close_digit
      END AS winning_number
    FROM selected_rounds r
    JOIN public.selections s
      ON s.user_id = v_uid AND s.game = r.game AND s.round_date = r.round_date
    LEFT JOIN public.winning_results wr ON wr.game = s.game AND wr.round_date = s.round_date
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) WITH ORDINALITY AS entry(item, ordinality)
  ), priced_picks AS (
    SELECT rp.*,
      -- A ruled-out jodi is decided: lost, and no longer waiting.
      (COALESCE(rp.phase_paid, false) OR rp.ruled_out) AS decided,
      CASE WHEN phase_paid AND number = winning_number THEN 'won'
           WHEN phase_paid OR ruled_out THEN 'lost' ELSE 'pending' END AS status,
      CASE WHEN phase_paid AND number = winning_number
        THEN stake * public.bet_multiplier(bet_type) ELSE 0 END AS payout
    FROM raw_picks rp
  ), round_totals AS (
    SELECT priced.game, priced.round_date,
      SUM(priced.stake)::bigint AS round_staked,
      SUM(priced.payout)::bigint AS round_won,
      COALESCE(SUM(priced.stake) FILTER (WHERE NOT priced.decided), 0)::bigint AS round_pending_stake
    FROM priced_picks priced
    GROUP BY priced.game, priced.round_date
  ), round_bet_types AS (
    SELECT by_type.game, by_type.round_date,
      jsonb_agg(jsonb_build_object(
        'bet_type', by_type.bet_type,
        'picks', by_type.picks
      ) ORDER BY by_type.bet_type) AS bet_types
    FROM (
      SELECT priced.game, priced.round_date, priced.bet_type,
        jsonb_agg(jsonb_build_object(
          'number', priced.number, 'stake', priced.stake,
          'status', priced.status, 'payout', priced.payout
        ) ORDER BY priced.pick_order) AS picks
      FROM priced_picks priced
      GROUP BY priced.game, priced.round_date, priced.bet_type
    ) by_type
    GROUP BY by_type.game, by_type.round_date
  )
  SELECT selected.game, selected.round_date, bet_types.bet_types,
    totals.round_staked, totals.round_won, totals.round_pending_stake
  FROM selected_rounds selected
  JOIN round_totals totals
    ON totals.game = selected.game AND totals.round_date = selected.round_date
  JOIN round_bet_types bet_types
    ON bet_types.game = selected.game AND bet_types.round_date = selected.round_date
  ORDER BY selected.round_date DESC, selected.game;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_bets(text, date, date, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_bets(text, date, date, integer, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- admin_bets_board
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_bets_board(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_slips jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list bets'; END IF;
  IF p_round_date IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.game_schedule WHERE game = p_game
  ) THEN RAISE EXCEPTION 'A valid game and round date are required'; END IF;

  SELECT jsonb_build_object(
    'open_patti', wr.open_patti, 'open_digit', wr.open_digit,
    'close_patti', wr.close_patti, 'close_digit', wr.close_digit,
    'open_paid', wr.open_processed_at IS NOT NULL,
    'close_paid', wr.close_processed_at IS NOT NULL
  )
  INTO v_result
  FROM public.winning_results wr
  WHERE wr.game = p_game AND wr.round_date = p_round_date;

  WITH slips AS (
    SELECT s.id, s.user_id, p.display_name, s.bet_type, s.total_points, s.updated_at, s.selections,
      CASE WHEN s.bet_type IN ('single_open', 'patti_open')
        THEN COALESCE((v_result->>'open_paid')::boolean, false)
        ELSE COALESCE((v_result->>'close_paid')::boolean, false) END AS paid,
      CASE s.bet_type
        WHEN 'single_open' THEN v_result->>'open_digit'
        WHEN 'single_close' THEN v_result->>'close_digit'
        WHEN 'jodi' THEN (v_result->>'open_digit') || (v_result->>'close_digit')
        WHEN 'patti_open' THEN (v_result->>'open_patti') || '-' || (v_result->>'open_digit')
        WHEN 'patti_close' THEN (v_result->>'close_patti') || '-' || (v_result->>'close_digit')
      END AS winning
    FROM public.selections s
    JOIN public.profiles p ON p.id = s.user_id
    WHERE s.game = p_game AND s.round_date = p_round_date
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', sl.id, 'user_id', sl.user_id, 'user_name', sl.display_name,
      'bet_type', sl.bet_type, 'total_points', sl.total_points, 'updated_at', sl.updated_at,
      'picks', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'number', entry.item->>'number',
          'stake', (entry.item->>'points')::integer,
          'status', CASE
            WHEN sl.paid AND entry.item->>'number' = sl.winning THEN 'won'
            WHEN sl.paid THEN 'lost'
            WHEN public.jodi_ruled_out(sl.bet_type, entry.item->>'number',
              v_result->>'open_digit', COALESCE((v_result->>'open_paid')::boolean, false)) THEN 'lost'
            ELSE 'pending' END,
          'payout', CASE
            WHEN sl.paid AND entry.item->>'number' = sl.winning
              THEN (entry.item->>'points')::integer * public.bet_multiplier(sl.bet_type)
            ELSE 0 END
        ) ORDER BY entry.ordinality)
        FROM jsonb_array_elements(sl.selections) WITH ORDINALITY AS entry(item, ordinality)
      ), '[]'::jsonb)
    ) ORDER BY sl.updated_at DESC), '[]'::jsonb)
  INTO v_slips
  FROM slips sl;

  RETURN jsonb_build_object('result', v_result, 'slips', v_slips);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_bets_board(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_bets_board(text, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- admin_get_exposure
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_exposure(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposure jsonb;
  v_stake_totals jsonb;
  v_phase_exposure jsonb;
  v_open_digit text;
  v_open_paid boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_game IS NULL OR NOT EXISTS (SELECT 1 FROM public.game_schedule WHERE game = p_game) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_round_date IS NULL THEN RAISE EXCEPTION 'Round date is required'; END IF;

  SELECT wr.open_digit, wr.open_processed_at IS NOT NULL
  INTO v_open_digit, v_open_paid
  FROM public.winning_results wr
  WHERE wr.game = p_game AND wr.round_date = p_round_date;
  v_open_paid := COALESCE(v_open_paid, false);

  -- Picks that can still win (jodis ruled out by the open result are left out).
  WITH number_stakes AS (
    SELECT s.bet_type, entry.item->>'number' AS number,
      SUM((entry.item->>'points')::bigint) AS total_stake
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game AND s.round_date = p_round_date
      AND NOT public.jodi_ruled_out(s.bet_type, entry.item->>'number', v_open_digit, v_open_paid)
    GROUP BY s.bet_type, entry.item->>'number'
  ), ranked AS (
    SELECT bet_type, number, total_stake,
      total_stake * public.bet_multiplier(bet_type) AS potential_payout,
      row_number() OVER (PARTITION BY bet_type ORDER BY
        total_stake * public.bet_multiplier(bet_type) DESC, number) AS position
    FROM number_stakes
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bet_type', bet_type, 'number', number, 'total_stake', total_stake,
    'potential_payout', potential_payout
  ) ORDER BY bet_type, potential_payout DESC, number), '[]'::jsonb)
  INTO v_exposure FROM ranked WHERE position <= 10;

  -- Total staked per bet type: every bet, decided or not.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bet_type', bet_type, 'total_stake', total_stake)
    ORDER BY bet_type), '[]'::jsonb)
  INTO v_stake_totals
  FROM (
    SELECT s.bet_type, SUM((entry.item->>'points')::bigint) AS total_stake
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game AND s.round_date = p_round_date
    GROUP BY s.bet_type
  ) totals;

  WITH number_stakes AS (
    SELECT s.bet_type, entry.item->>'number' AS number,
      SUM((entry.item->>'points')::bigint) AS total_stake
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game AND s.round_date = p_round_date
      AND NOT public.jodi_ruled_out(s.bet_type, entry.item->>'number', v_open_digit, v_open_paid)
    GROUP BY s.bet_type, entry.item->>'number'
  ), type_max AS (
    SELECT bet_type, MAX(total_stake * public.bet_multiplier(bet_type)) AS potential_payout
    FROM number_stakes
    GROUP BY bet_type
  )
  SELECT jsonb_build_object(
    'open_worst_case', COALESCE(SUM(potential_payout)
      FILTER (WHERE bet_type IN ('single_open', 'patti_open')), 0),
    'close_worst_case', COALESCE(SUM(potential_payout)
      FILTER (WHERE bet_type IN ('single_close', 'patti_close', 'jodi')), 0)
  )
  INTO v_phase_exposure
  FROM type_max;

  RETURN jsonb_build_object(
    'max_user_round_points', public.get_setting_int('max_user_round_points', 50000),
    'max_number_liability', public.get_setting_int('max_number_liability', 1000000),
    'exposure', v_exposure,
    'stake_totals', v_stake_totals,
    'phase_exposure', v_phase_exposure
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_exposure(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_exposure(text, date) TO authenticated;
