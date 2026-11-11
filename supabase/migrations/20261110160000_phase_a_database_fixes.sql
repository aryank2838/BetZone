DROP FUNCTION IF EXISTS public.admin_list_users(text, integer, integer);

CREATE OR REPLACE FUNCTION public.bet_type_lock_key(
  p_game text,
  p_round_date date,
  p_bet_type text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_game IS NULL OR p_round_date IS NULL OR p_bet_type IS NULL THEN
    RAISE EXCEPTION 'Game, round date, and bet type are required for the bet-type lock';
  END IF;

  RETURN hashtextextended(p_game || ':' || p_round_date::text || ':' || p_bet_type, 0);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.bet_type_lock_key(text, date, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_selection(
  p_game text,
  p_selections jsonb,
  p_bet_type text DEFAULT 'jodi'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_round date;
  v_lock_date date;
  v_points integer;
  v_wallet integer;
  v_banned boolean;
  v_terms_accepted_at timestamptz;
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
  v_user_round_total bigint;
  v_number_liability bigint;
  v_multiplier integer;
  v_max_user_round_points integer;
  v_max_number_liability integer;
  v_daily_loss_limit integer;
  v_today_net_loss bigint;
  v_limits public.user_limits%ROWTYPE;
  v_max_bet CONSTANT integer := 5000;
  v_max_submit CONSTANT integer := 20000;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT EXISTS (SELECT 1 FROM public.game_schedule WHERE game = p_game) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_bet_type IS NULL OR p_bet_type NOT IN (
    'single_open', 'single_close', 'jodi', 'patti_open', 'patti_close'
  ) THEN
    RAISE EXCEPTION 'Invalid bet type';
  END IF;
  IF COALESCE(jsonb_typeof(p_selections), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  v_lock_date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  PERFORM pg_advisory_xact_lock_shared(public.round_lock_key(p_game, v_lock_date));
  PERFORM pg_advisory_xact_lock(public.bet_type_lock_key(p_game, v_lock_date, p_bet_type));

  v_round := public.bet_round(p_game, p_bet_type);
  IF v_round IS NOT NULL AND v_round <> v_lock_date THEN
    RAISE EXCEPTION 'Please try again.';
  END IF;
  IF v_round IS NULL THEN
    RAISE EXCEPTION 'Betting is closed for this bet type right now.';
  END IF;

  PERFORM public.apply_pending_user_limits(v_uid);
  SELECT points, wallet, is_banned, terms_accepted_at
  INTO v_points, v_wallet, v_banned, v_terms_accepted_at
  FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF v_terms_accepted_at IS NULL THEN RAISE EXCEPTION 'Please accept the Terms and Privacy Policy first.'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;

  SELECT * INTO v_limits FROM public.user_limits WHERE user_id = v_uid;
  IF v_limits.cooldown_until > now() THEN
    RAISE EXCEPTION 'Betting is paused until % due to your cooldown.', v_limits.cooldown_until;
  END IF;
  IF v_limits.self_excluded_until > now() THEN
    RAISE EXCEPTION 'Betting is unavailable until your self-exclusion ends on %.', v_limits.self_excluded_until;
  END IF;

  SELECT selections INTO v_existing
  FROM public.selections
  WHERE user_id = v_uid AND game = p_game AND bet_type = p_bet_type AND round_date = v_round;
  v_existing := COALESCE(v_existing, '[]'::jsonb);
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_existing) LOOP
    v_existing_nums := array_append(v_existing_nums, v_row->>'number');
    v_existing_total := v_existing_total + (v_row->>'points')::int;
  END LOOP;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_selections) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::numeric;
    IF v_num IS NULL OR v_pts IS NULL THEN RAISE EXCEPTION 'Each selection needs a number and points'; END IF;
    IF p_bet_type IN ('single_open', 'single_close') THEN
      IF v_num !~ '^[0-9]$' THEN RAISE EXCEPTION 'Single bets must be one digit (0-9)'; END IF;
    ELSIF p_bet_type = 'jodi' THEN
      IF v_num !~ '^[0-9]{2}$' THEN RAISE EXCEPTION 'Jodi must be two digits (00-99)'; END IF;
    ELSIF NOT public.is_valid_patti_combo(v_num) THEN
      RAISE EXCEPTION 'Invalid patti-digit combination: %', v_num;
    END IF;
    IF v_pts <> floor(v_pts) OR v_pts < 1 OR v_pts > v_max_bet THEN
      RAISE EXCEPTION 'Each bet must be a whole number from 1 to %', v_max_bet;
    END IF;
    IF v_num = ANY(v_existing_nums) OR v_num = ANY(v_seen) THEN CONTINUE; END IF;
    v_seen := array_append(v_seen, v_num);
    v_new := v_new || jsonb_build_array(jsonb_build_object('number', v_num, 'points', v_pts::int));
    v_new_total := v_new_total + v_pts::int;
    v_new_count := v_new_count + 1;
  END LOOP;
  IF v_new_count = 0 THEN RAISE EXCEPTION 'No new numbers to add. Existing picks for this round are locked.'; END IF;
  IF v_new_total > v_max_submit THEN RAISE EXCEPTION 'A single submit can total at most % points', v_max_submit; END IF;

  v_daily_loss_limit := v_limits.daily_loss_limit;
  IF v_daily_loss_limit IS NOT NULL THEN
    SELECT COALESCE(SUM(CASE WHEN reason = 'selection_submit' THEN -delta::bigint
                             WHEN reason = 'winning_payout' THEN -delta::bigint
                             ELSE 0 END), 0)
    INTO v_today_net_loss
    FROM public.point_ledger
    WHERE user_id = v_uid
      AND reason IN ('selection_submit', 'winning_payout')
      AND created_at >= ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
    IF v_today_net_loss + v_new_total > v_daily_loss_limit THEN
      RAISE EXCEPTION 'Daily loss limit reached. Limit: % points; today: % points.',
        v_daily_loss_limit, v_today_net_loss;
    END IF;
  END IF;

  v_max_user_round_points := public.get_setting_int('max_user_round_points', 50000);
  SELECT COALESCE(SUM((entry.item->>'points')::bigint), 0)
  INTO v_user_round_total
  FROM public.selections s
  CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
  WHERE s.user_id = v_uid AND s.game = p_game AND s.round_date = v_round;
  IF v_user_round_total + v_new_total > v_max_user_round_points THEN
    RAISE EXCEPTION 'Round stake limit exceeded: existing % + new % points would exceed limit %',
      v_user_round_total, v_new_total, v_max_user_round_points;
  END IF;

  v_max_number_liability := public.get_setting_int('max_number_liability', 1000000);
  v_multiplier := CASE p_bet_type WHEN 'single_open' THEN 9 WHEN 'single_close' THEN 9 WHEN 'jodi' THEN 90 ELSE 120 END;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::bigint;
    SELECT COALESCE(SUM((entry.item->>'points')::bigint * v_multiplier), 0)
    INTO v_number_liability
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game AND s.bet_type = p_bet_type AND s.round_date = v_round
      AND entry.item->>'number' = v_num;
    IF v_number_liability + (v_pts::bigint * v_multiplier) > v_max_number_liability THEN
      RAISE EXCEPTION 'Number liability limit exceeded for % (%): existing payout %, new payout %, limit %',
        p_bet_type, v_num, v_number_liability, v_pts::bigint * v_multiplier, v_max_number_liability;
    END IF;
  END LOOP;
  IF v_points + v_wallet < v_new_total THEN
    RAISE EXCEPTION 'Insufficient balance. You have % (play: %, wallet: %), new picks cost %.',
      v_points + v_wallet, v_points, v_wallet, v_new_total;
  END IF;
  v_from_points := LEAST(v_points, v_new_total);
  v_from_wallet := v_new_total - v_from_points;
  UPDATE public.profiles SET points = points - v_from_points, wallet = wallet - v_from_wallet WHERE id = v_uid;
  INSERT INTO public.selections (user_id, game, bet_type, round_date, selections, total_points, updated_at)
  VALUES (v_uid, p_game, p_bet_type, v_round, v_existing || v_new, v_existing_total + v_new_total, now())
  ON CONFLICT (user_id, game, bet_type, round_date)
  DO UPDATE SET selections = EXCLUDED.selections, total_points = EXCLUDED.total_points, updated_at = now();
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -v_new_total, 'selection_submit',
    jsonb_build_object('game', p_game, 'bet_type', p_bet_type, 'round_date', v_round,
                       'new_numbers', v_new_count, 'from_points', v_from_points, 'from_wallet', v_from_wallet));
  RETURN jsonb_build_object('points', v_points - v_from_points, 'wallet', v_wallet - v_from_wallet,
    'new_points', v_new_total, 'new_count', v_new_count,
    'total_numbers', jsonb_array_length(v_existing) + v_new_count, 'round_date', v_round);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text) TO authenticated;

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
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_game IS NULL OR NOT EXISTS (SELECT 1 FROM public.game_schedule WHERE game = p_game) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_round_date IS NULL THEN RAISE EXCEPTION 'Round date is required'; END IF;
  WITH number_stakes AS (
    SELECT s.bet_type, entry.item->>'number' AS number,
      SUM((entry.item->>'points')::bigint) AS total_stake
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game AND s.round_date = p_round_date
    GROUP BY s.bet_type, entry.item->>'number'
  ), ranked AS (
    SELECT bet_type, number, total_stake,
      total_stake * CASE bet_type
        WHEN 'single_open' THEN 9 WHEN 'single_close' THEN 9 WHEN 'jodi' THEN 90
        WHEN 'patti_open' THEN 120 WHEN 'patti_close' THEN 120 END AS potential_payout,
      row_number() OVER (PARTITION BY bet_type ORDER BY
        total_stake * CASE bet_type
          WHEN 'single_open' THEN 9 WHEN 'single_close' THEN 9 WHEN 'jodi' THEN 90
          WHEN 'patti_open' THEN 120 WHEN 'patti_close' THEN 120 END DESC, number) AS position
    FROM number_stakes
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bet_type', bet_type, 'number', number, 'total_stake', total_stake,
    'potential_payout', potential_payout
  ) ORDER BY bet_type, potential_payout DESC, number), '[]'::jsonb)
  INTO v_exposure FROM ranked WHERE position <= 10;

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
    GROUP BY s.bet_type, entry.item->>'number'
  ), type_max AS (
    SELECT bet_type, MAX(total_stake * CASE bet_type
      WHEN 'single_open' THEN 9 WHEN 'single_close' THEN 9 WHEN 'jodi' THEN 90
      WHEN 'patti_open' THEN 120 WHEN 'patti_close' THEN 120 END) AS potential_payout
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

CREATE OR REPLACE FUNCTION public.admin_daily_report(p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'Report date is required'; END IF;
  WITH games AS (
    SELECT game FROM public.game_schedule
  ), activity AS (
    SELECT metadata->>'game' AS game,
      SUM(CASE WHEN reason = 'selection_submit' THEN -delta::bigint ELSE 0 END) AS staked,
      SUM(CASE WHEN reason = 'winning_payout' THEN delta::bigint ELSE 0 END) AS paid
    FROM public.point_ledger
    WHERE reason IN ('selection_submit', 'winning_payout')
      AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = p_date
      AND metadata->>'game' IS NOT NULL
    GROUP BY metadata->>'game'
  ), flows AS (
    SELECT
      COALESCE((SELECT SUM(amount::bigint) FROM public.add_funds_requests
        WHERE status = 'approved' AND processed_at IS NOT NULL
          AND (processed_at AT TIME ZONE 'Asia/Kolkata')::date = p_date), 0) AS deposits,
      COALESCE((SELECT SUM(amount::bigint) FROM public.withdrawals
        WHERE status = 'approved' AND processed_at IS NOT NULL
          AND (processed_at AT TIME ZONE 'Asia/Kolkata')::date = p_date), 0) AS withdrawals
  ), per_game AS (
    SELECT g.game, COALESCE(a.staked, 0) AS total_staked,
      COALESCE(a.paid, 0) AS total_paid_out,
      COALESCE(a.staked, 0) - COALESCE(a.paid, 0) AS gaming_revenue,
      NULL::bigint AS approved_deposits, NULL::bigint AS approved_withdrawals,
      NULL::bigint AS net_cash
    FROM games g LEFT JOIN activity a ON a.game = g.game
  ), overall AS (
    SELECT 'ALL'::text AS game, SUM(total_staked)::bigint AS total_staked,
      SUM(total_paid_out)::bigint AS total_paid_out,
      SUM(gaming_revenue)::bigint AS gaming_revenue,
      f.deposits AS approved_deposits,
      f.withdrawals AS approved_withdrawals,
      f.deposits - f.withdrawals AS net_cash
    FROM per_game CROSS JOIN flows f GROUP BY f.deposits, f.withdrawals
  )
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'game', game,
    'total_staked', total_staked,
    'total_paid_out', total_paid_out,
    'gaming_revenue', gaming_revenue,
    'approved_deposits', approved_deposits,
    'approved_withdrawals', approved_withdrawals,
    'net_cash', net_cash
  )) ORDER BY CASE WHEN game = 'ALL' THEN 1 ELSE 0 END, game), '[]'::jsonb)
  INTO v_result FROM (SELECT * FROM per_game UNION ALL SELECT * FROM overall) report_rows;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_daily_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_daily_report(date) TO authenticated;

CREATE FUNCTION public.admin_list_ledger_opening_balances()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', o.user_id,
    'display_name', p.display_name,
    'opening_balance', o.opening_balance,
    'captured_at', o.captured_at
  ) ORDER BY o.captured_at, o.user_id), '[]'::jsonb)
  INTO v_result
  FROM public.user_ledger_opening_balances o
  LEFT JOIN public.profiles p ON p.id = o.user_id;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_ledger_opening_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_ledger_opening_balances() TO authenticated;
