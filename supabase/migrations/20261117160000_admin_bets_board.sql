/*
Admin Bets tab: every slip of a game and round with each number's status.

admin_bets_board(game, round_date) returns the round's result and each slip
with its picks marked 'pending', 'won' or 'lost' and the payout, using the
same rules as get_my_bets() (open bets and open patti settle with the open
result; jodi, close bets and close patti with the close result).
*/
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
            WHEN NOT sl.paid THEN 'pending'
            WHEN entry.item->>'number' = sl.winning THEN 'won'
            ELSE 'lost' END,
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
