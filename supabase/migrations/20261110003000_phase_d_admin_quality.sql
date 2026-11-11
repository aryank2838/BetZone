CREATE TABLE public.user_ledger_opening_balances (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  opening_balance bigint NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_ledger_opening_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_ledger_opening_balances FROM PUBLIC, anon, authenticated;

INSERT INTO public.user_ledger_opening_balances (user_id, opening_balance)
SELECT p.id, p.points::bigint + p.wallet::bigint - COALESCE(SUM(l.delta::bigint), 0)
FROM public.profiles p
LEFT JOIN public.point_ledger l ON l.user_id = p.id
GROUP BY p.id, p.points, p.wallet
HAVING p.points::bigint + p.wallet::bigint <> COALESCE(SUM(l.delta::bigint), 0);

DROP FUNCTION IF EXISTS public.admin_list_withdrawals(integer, integer);
CREATE FUNCTION public.admin_list_withdrawals(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_status text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_search text := lower(trim(COALESCE(p_search, '')));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list withdrawals'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid withdrawal status';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;
  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', w.id, 'user_id', w.user_id, 'amount', w.amount, 'status', w.status,
      'upi_id', w.upi_id, 'created_at', w.created_at, 'processed_at', w.processed_at,
      'reject_reason', w.reject_reason, 'user_name', p.display_name
    ) AS request_row, w.created_at, w.id AS request_id
    FROM public.withdrawals w
    JOIN public.profiles p ON p.id = w.user_id
    WHERE (p_status IS NULL OR w.status = p_status)
      AND (p_from IS NULL OR (w.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (w.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
      AND (v_search = '' OR lower(p.display_name) LIKE '%' || v_search || '%')
    ORDER BY w.created_at DESC, w.id DESC
    LIMIT p_limit OFFSET p_offset
  ) page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer, text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer, text, date, date, text) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_list_add_funds(integer, integer);
CREATE FUNCTION public.admin_list_add_funds(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_status text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_search text := lower(trim(COALESCE(p_search, '')));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list add-funds requests'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid add-funds status';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;
  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', a.id, 'user_id', a.user_id, 'amount', a.amount, 'status', a.status,
      'payment_ref', a.payment_ref, 'screenshot_path', a.screenshot_path,
      'created_at', a.created_at, 'processed_at', a.processed_at,
      'reject_reason', a.reject_reason, 'user_name', p.display_name
    ) AS request_row, a.created_at, a.id AS request_id
    FROM public.add_funds_requests a
    JOIN public.profiles p ON p.id = a.user_id
    WHERE (p_status IS NULL OR a.status = p_status)
      AND (p_from IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
      AND (v_search = '' OR lower(p.display_name) LIKE '%' || v_search || '%'
           OR lower(a.payment_ref) LIKE '%' || v_search || '%')
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT p_limit OFFSET p_offset
  ) page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer, text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer, text, date, date, text) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_list_users(text);
CREATE FUNCTION public.admin_list_users(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_search text := lower(trim(COALESCE(p_search, '')));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list users'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'banned', 'admin', 'non_admin') THEN
    RAISE EXCEPTION 'Invalid user status';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;
  SELECT COALESCE(jsonb_agg(user_row ORDER BY created_at DESC, user_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'email', u.email,
      'points', p.points, 'wallet', p.wallet, 'is_admin', p.is_admin,
      'is_banned', p.is_banned, 'created_at', p.created_at
    ) AS user_row, p.created_at, p.id AS user_id
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE (v_search = '' OR lower(p.display_name) LIKE '%' || v_search || '%'
           OR lower(u.email) LIKE '%' || v_search || '%')
      AND (p_status IS NULL
           OR (p_status = 'active' AND NOT p.is_banned)
           OR (p_status = 'banned' AND p.is_banned)
           OR (p_status = 'admin' AND p.is_admin)
           OR (p_status = 'non_admin' AND NOT p.is_admin))
      AND (p_from IS NULL OR (p.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (p.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT p_limit OFFSET p_offset
  ) page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_users(text, text, date, date, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, text, date, date, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_exposure(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposure jsonb;
  v_stake_totals jsonb;
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
  RETURN jsonb_build_object(
    'max_user_round_points', public.get_setting_int('max_user_round_points', 50000),
    'max_number_liability', public.get_setting_int('max_number_liability', 1000000),
    'exposure', v_exposure, 'stake_totals', v_stake_totals
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_exposure(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_exposure(text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_preview_result(
  p_game text,
  p_round_date date,
  p_phase text,
  p_patti text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_schedule public.game_schedule%ROWTYPE;
  v_open_digit text;
  v_processed_at timestamptz;
  v_patti_valid boolean;
  v_digit text;
  v_jodi text;
  v_deadline timestamptz;
  v_warnings jsonb := '[]'::jsonb;
  v_bet_types text[];
  v_type text;
  v_winning_number text;
  v_winners bigint;
  v_payout bigint;
  v_summary jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_game IS NULL OR p_round_date IS NULL OR p_phase IS NULL
     OR p_phase NOT IN ('open', 'close') THEN
    RAISE EXCEPTION 'Game, round date, and phase are required';
  END IF;
  SELECT * INTO v_schedule FROM public.game_schedule WHERE game = p_game;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid game'; END IF;
  v_patti_valid := public.is_valid_patti(p_patti);
  IF NOT COALESCE(v_patti_valid, false) THEN
    v_warnings := v_warnings || jsonb_build_array('Invalid patti');
  ELSE
    v_digit := public.patti_digit(p_patti)::text;
  END IF;
  IF p_phase = 'open' THEN
    v_deadline := (p_round_date + v_schedule.open_bets_close)::timestamp AT TIME ZONE 'Asia/Kolkata';
    SELECT open_processed_at INTO v_processed_at FROM public.winning_results
    WHERE game = p_game AND round_date = p_round_date;
    v_bet_types := ARRAY['single_open', 'patti_open'];
  ELSE
    v_deadline := (p_round_date + v_schedule.close_bets_close)::timestamp AT TIME ZONE 'Asia/Kolkata';
    SELECT open_digit, close_processed_at INTO v_open_digit, v_processed_at
    FROM public.winning_results WHERE game = p_game AND round_date = p_round_date;
    IF v_open_digit IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.winning_results
      WHERE game = p_game AND round_date = p_round_date AND open_processed_at IS NOT NULL
    ) THEN
      v_warnings := v_warnings || jsonb_build_array('Open result is not paid yet');
    END IF;
    v_bet_types := ARRAY['single_close', 'patti_close', 'jodi'];
  END IF;
  IF now() < v_deadline THEN
    v_warnings := v_warnings || jsonb_build_array('Betting window has not closed');
  END IF;
  IF v_processed_at IS NOT NULL THEN
    v_warnings := v_warnings || jsonb_build_array('Result has already been paid');
  END IF;
  IF p_phase = 'close' AND v_open_digit IS NOT NULL AND v_digit IS NOT NULL THEN
    v_jodi := v_open_digit || v_digit;
  END IF;
  FOREACH v_type IN ARRAY v_bet_types LOOP
    v_winning_number := CASE
      WHEN v_type = 'single_open' OR v_type = 'single_close' THEN v_digit
      WHEN v_type = 'patti_open' OR v_type = 'patti_close' THEN p_patti || '-' || v_digit
      WHEN v_type = 'jodi' THEN v_jodi
    END;
    IF v_winning_number IS NULL THEN
      v_winners := 0;
      v_payout := 0;
    ELSE
      SELECT COUNT(*), COALESCE(SUM((entry.item->>'points')::bigint *
        CASE v_type WHEN 'single_open' THEN 9 WHEN 'single_close' THEN 9
          WHEN 'jodi' THEN 90 ELSE 120 END), 0)
      INTO v_winners, v_payout
      FROM public.selections s
      CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
      WHERE s.game = p_game AND s.round_date = p_round_date AND s.bet_type = v_type
        AND entry.item->>'number' = v_winning_number;
    END IF;
    v_summary := v_summary || jsonb_build_array(jsonb_build_object(
      'bet_type', v_type, 'winning_number', v_winning_number,
      'winning_picks', v_winners, 'total_payout', v_payout
    ));
  END LOOP;
  RETURN jsonb_build_object(
    'game', p_game, 'round_date', p_round_date, 'phase', p_phase,
    'digit', v_digit, 'jodi', v_jodi,
    'winning_by_bet_type', v_summary, 'warnings', v_warnings
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_preview_result(text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_result(text, date, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_user_detail(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile jsonb;
  v_limits jsonb;
  v_ledger jsonb;
  v_bets jsonb;
  v_deposits jsonb;
  v_withdrawals jsonb;
  v_tickets jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
  SELECT jsonb_build_object(
    'id', id, 'display_name', display_name, 'points', points, 'wallet', wallet,
    'is_admin', is_admin, 'is_banned', is_banned, 'created_at', created_at,
    'age_confirmed', age_confirmed, 'terms_accepted_at', terms_accepted_at,
    'terms_version', terms_version
  ) INTO v_profile FROM public.profiles WHERE id = p_user_id;
  IF v_profile IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT to_jsonb(l) INTO v_limits FROM public.user_limits l WHERE l.user_id = p_user_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_ledger FROM (
    SELECT id, delta, reason, metadata, created_at FROM public.point_ledger
    WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 100
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_bets FROM (
    SELECT id, game, round_date, bet_type, selections, total_points, created_at, updated_at
    FROM public.selections WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_deposits FROM (
    SELECT id, amount, status, payment_ref, created_at, processed_at, reject_reason
    FROM public.add_funds_requests WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_withdrawals FROM (
    SELECT id, amount, status, upi_id, created_at, processed_at, reject_reason
    FROM public.withdrawals WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_tickets FROM (
    SELECT id, category, request_ref, message, status, admin_note, created_at, closed_at
    FROM public.support_tickets WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  RETURN jsonb_build_object(
    'profile', v_profile, 'limits', v_limits, 'ledger', v_ledger, 'bets', v_bets,
    'deposits', v_deposits, 'withdrawals', v_withdrawals, 'tickets', v_tickets
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO authenticated;

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
      COALESCE(a.paid, 0) AS total_paid_out, 0::bigint AS approved_deposits,
      0::bigint AS approved_withdrawals,
      COALESCE(a.staked, 0) - COALESCE(a.paid, 0) AS net
    FROM games g LEFT JOIN activity a ON a.game = g.game
  ), overall AS (
    SELECT 'ALL'::text AS game, SUM(total_staked)::bigint AS total_staked,
      SUM(total_paid_out)::bigint AS total_paid_out, f.deposits AS approved_deposits,
      f.withdrawals AS approved_withdrawals,
      SUM(total_staked)::bigint - SUM(total_paid_out)::bigint + f.deposits - f.withdrawals AS net
    FROM per_game CROSS JOIN flows f GROUP BY f.deposits, f.withdrawals
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'game', game, 'total_staked', total_staked, 'total_paid_out', total_paid_out,
    'approved_deposits', approved_deposits, 'approved_withdrawals', approved_withdrawals,
    'net', net
  ) ORDER BY CASE WHEN game = 'ALL' THEN 1 ELSE 0 END, game), '[]'::jsonb)
  INTO v_result FROM (SELECT * FROM per_game UNION ALL SELECT * FROM overall) report_rows;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_daily_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_daily_report(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_ledger_reconciliation()
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
    'user_id', p.id, 'display_name', p.display_name, 'points', p.points,
    'wallet', p.wallet, 'ledger_total', COALESCE(l.ledger_total, 0),
    'opening_balance', COALESCE(o.opening_balance, 0),
    'expected_balance', COALESCE(l.ledger_total, 0) + COALESCE(o.opening_balance, 0),
    'difference', p.points::bigint + p.wallet::bigint
      - COALESCE(l.ledger_total, 0) - COALESCE(o.opening_balance, 0)
  ) ORDER BY p.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.profiles p
  LEFT JOIN (
    SELECT user_id, SUM(delta::bigint) AS ledger_total
    FROM public.point_ledger GROUP BY user_id
  ) l ON l.user_id = p.id
  LEFT JOIN public.user_ledger_opening_balances o ON o.user_id = p.id
  WHERE p.points::bigint + p.wallet::bigint
    <> COALESCE(l.ledger_total, 0) + COALESCE(o.opening_balance, 0);
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_ledger_reconciliation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ledger_reconciliation() TO authenticated;
