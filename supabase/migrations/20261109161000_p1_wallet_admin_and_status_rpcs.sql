CREATE OR REPLACE FUNCTION public.get_game_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_round_date date := (v_now AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'game', g.game,
        'label', g.label,
        'round_date', v_round_date,
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

CREATE OR REPLACE FUNCTION public.get_wallet_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_points integer;
  v_wallet integer;
  v_is_banned boolean;
  v_pending_withdrawals integer;
  v_approved_deposits bigint;
  v_wagered_turnover bigint;
  v_turnover_remaining bigint;
  v_min_withdrawal constant integer := 100;
  v_max_withdrawal constant integer := 100000;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  SELECT points, wallet, is_banned INTO v_points, v_wallet, v_is_banned
  FROM public.profiles WHERE id = v_uid;

  SELECT COALESCE(SUM(amount), 0)::integer INTO v_pending_withdrawals
  FROM public.withdrawals
  WHERE user_id = v_uid AND status = 'pending';

  SELECT COALESCE(SUM(amount), 0) INTO v_approved_deposits
  FROM public.add_funds_requests
  WHERE user_id = v_uid AND status = 'approved';

  SELECT COALESCE(SUM(ABS(delta::bigint)), 0) INTO v_wagered_turnover
  FROM public.point_ledger
  WHERE user_id = v_uid AND reason = 'selection_submit';

  v_turnover_remaining := GREATEST(v_approved_deposits - v_wagered_turnover, 0);

  RETURN jsonb_build_object(
    'points', v_points,
    'wallet', v_wallet,
    'is_banned', v_is_banned,
    'pending_withdrawals', v_pending_withdrawals,
    'approved_deposits', v_approved_deposits,
    'wagered_turnover', v_wagered_turnover,
    'turnover_remaining', v_turnover_remaining,
    'min_withdrawal', v_min_withdrawal,
    'max_withdrawal', v_max_withdrawal,
    'withdrawal_eligible',
      NOT v_is_banned
      AND v_wallet >= v_min_withdrawal
      AND v_pending_withdrawals = 0
      AND v_approved_deposits >= v_min_withdrawal
      AND v_turnover_remaining = 0
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_wallet_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_wallet_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_balance_breakdown()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_signup_earned bigint;
  v_selections_spent bigint;
  v_winnings_total bigint;
  v_deposits_total bigint;
  v_withdrawn_total bigint;
  v_play_balance integer;
  v_wallet integer;
  v_pending_withdrawals bigint;
  v_pending_add_funds bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  SELECT COALESCE(SUM(delta), 0) INTO v_signup_earned
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'signup_bonus';

  SELECT COALESCE(SUM(ABS(delta::bigint)), 0) INTO v_selections_spent
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'selection_submit';

  SELECT COALESCE(SUM(delta), 0) INTO v_winnings_total
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'winning_payout';

  SELECT COALESCE(SUM(amount), 0) INTO v_deposits_total
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'approved';

  SELECT COALESCE(SUM(amount), 0) INTO v_withdrawn_total
  FROM public.withdrawals WHERE user_id = v_uid AND status = 'approved';

  SELECT points, wallet INTO v_play_balance, v_wallet
  FROM public.profiles WHERE id = v_uid;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_withdrawals
  FROM public.withdrawals WHERE user_id = v_uid AND status = 'pending';

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_add_funds
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'pending';

  RETURN jsonb_build_object(
    'signup_earned', v_signup_earned,
    'selections_spent', v_selections_spent,
    'winnings_total', v_winnings_total,
    'deposits_total', v_deposits_total,
    'withdrawn_total', v_withdrawn_total,
    'play_balance', v_play_balance,
    'wallet', v_wallet,
    'pending_withdrawals', v_pending_withdrawals,
    'pending_add_funds', v_pending_add_funds,
    'max_add_funds_amount', 100000
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_balance_breakdown() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_balance_breakdown() TO authenticated;

DROP FUNCTION IF EXISTS public.admin_get_stats();
CREATE FUNCTION public.admin_get_stats(p_round_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_round_date date := COALESCE(p_round_date, (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date);
  v_total_users bigint;
  v_banned bigint;
  v_admin_count bigint;
  v_total_points bigint;
  v_total_wallet bigint;
  v_pending_wd_count bigint;
  v_pending_wd_amount bigint;
  v_pending_af_count bigint;
  v_pending_af_amount bigint;
  v_selection_counts jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can view stats';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE is_banned),
         count(*) FILTER (WHERE is_admin),
         COALESCE(SUM(points), 0),
         COALESCE(SUM(wallet), 0)
  INTO v_total_users, v_banned, v_admin_count, v_total_points, v_total_wallet
  FROM public.profiles;

  SELECT count(*), COALESCE(SUM(amount), 0)
  INTO v_pending_wd_count, v_pending_wd_amount
  FROM public.withdrawals WHERE status = 'pending';

  SELECT count(*), COALESCE(SUM(amount), 0)
  INTO v_pending_af_count, v_pending_af_amount
  FROM public.add_funds_requests WHERE status = 'pending';

  SELECT COALESCE(jsonb_object_agg(game, counts), '{}'::jsonb)
  INTO v_selection_counts
  FROM (
    SELECT g.game,
      jsonb_build_object(
        'single_open', count(*) FILTER (WHERE s.bet_type = 'single_open'),
        'single_close', count(*) FILTER (WHERE s.bet_type = 'single_close'),
        'jodi', count(*) FILTER (WHERE s.bet_type = 'jodi'),
        'patti_open', count(*) FILTER (WHERE s.bet_type = 'patti_open'),
        'patti_close', count(*) FILTER (WHERE s.bet_type = 'patti_close')
      ) AS counts
    FROM (VALUES ('test'::text), ('test2'::text)) AS g(game)
    LEFT JOIN public.selections s
      ON s.game = g.game AND s.round_date = v_round_date
    GROUP BY g.game
  ) game_counts;

  RETURN jsonb_build_object(
    'total_users', v_total_users,
    'banned_users', v_banned,
    'admin_count', v_admin_count,
    'total_points', v_total_points,
    'total_wallet', v_total_wallet,
    'pending_withdrawals_count', v_pending_wd_count,
    'pending_withdrawals_amount', v_pending_wd_amount,
    'pending_addfunds_count', v_pending_af_count,
    'pending_addfunds_amount', v_pending_af_amount,
    'round_date', v_round_date,
    'selection_counts', v_selection_counts
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_get_stats(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_stats(date) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_list_selections(text);
CREATE FUNCTION public.admin_list_selections(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list selections';
  END IF;
  IF p_game NOT IN ('test', 'test2') OR p_round_date IS NULL THEN
    RAISE EXCEPTION 'A valid game and round date are required';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'user_name', p.display_name,
      'bet_type', s.bet_type,
      'round_date', s.round_date,
      'selections', s.selections,
      'total_points', s.total_points,
      'updated_at', s.updated_at
    ) ORDER BY s.updated_at DESC
  ), '[]'::jsonb)
  INTO v_result
  FROM public.selections s
  JOIN public.profiles p ON p.id = s.user_id
  WHERE s.game = p_game AND s.round_date = p_round_date;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_selections(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_selections(text, date) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_list_users(text);
CREATE FUNCTION public.admin_list_users(
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_result jsonb;
  v_search text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list users';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;
  v_search := lower(trim(COALESCE(p_search, '')));

  SELECT COALESCE(jsonb_agg(user_row ORDER BY created_at DESC, user_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', p.id,
      'display_name', p.display_name,
      'email', u.email,
      'points', p.points,
      'wallet', p.wallet,
      'is_admin', p.is_admin,
      'is_banned', p.is_banned,
      'created_at', p.created_at
    ) AS user_row, p.created_at, p.id AS user_id
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE v_search = ''
       OR lower(p.display_name) LIKE '%' || v_search || '%'
       OR lower(u.email) LIKE '%' || v_search || '%'
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT p_limit OFFSET p_offset
  ) users_page;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_users(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, integer, integer) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_list_withdrawals();
CREATE FUNCTION public.admin_list_withdrawals(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list withdrawals';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;

  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', w.id, 'user_id', w.user_id, 'amount', w.amount, 'status', w.status,
      'upi_id', w.upi_id, 'created_at', w.created_at, 'user_name', p.display_name
    ) AS request_row, w.created_at, w.id AS request_id
    FROM public.withdrawals w
    JOIN public.profiles p ON p.id = w.user_id
    ORDER BY w.created_at DESC, w.id DESC
    LIMIT p_limit OFFSET p_offset
  ) request_page;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_list_add_funds();
CREATE FUNCTION public.admin_list_add_funds(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list add-funds requests';
  END IF;
  IF p_limit < 1 OR p_limit > 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;

  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', a.id, 'user_id', a.user_id, 'amount', a.amount, 'status', a.status,
      'payment_ref', a.payment_ref, 'screenshot_path', a.screenshot_path,
      'created_at', a.created_at, 'user_name', p.display_name
    ) AS request_row, a.created_at, a.id AS request_id
    FROM public.add_funds_requests a
    JOIN public.profiles p ON p.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT p_limit OFFSET p_offset
  ) request_page;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer) TO authenticated;

CREATE INDEX IF NOT EXISTS withdrawals_status_created_at_idx
  ON public.withdrawals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS add_funds_requests_status_created_at_idx
  ON public.add_funds_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS point_ledger_user_reason_idx
  ON public.point_ledger (user_id, reason);
