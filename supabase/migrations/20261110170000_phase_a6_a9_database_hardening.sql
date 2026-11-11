ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    -- Hosted Supabase does not let postgres alter supabase_admin's defaults.
    -- (Edited before this migration was ever applied: it failed on hosted projects.)
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping supabase_admin default privileges: insufficient privilege';
    END;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.internal_rule_constants()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN jsonb_build_object(
    'minimum_withdrawal', 100,
    'maximum_withdrawal', 100000,
    'approved_deposit_minimum', 100,
    'maximum_add_funds', 100000,
    'turnover_multiplier', 1,
    'maximum_bet', 5000,
    'maximum_submit', 20000
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.internal_rule_constants() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_rules()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rules jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_rules := public.internal_rule_constants();
  RETURN v_rules || jsonb_build_object(
    'cooldown_hours', jsonb_build_array(1, 6, 24, 72),
    'self_exclusion_days', jsonb_build_array(7, 30, 90, 180)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_public_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_rules() TO authenticated;

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
  v_rules jsonb;
  v_max_bet integer;
  v_max_submit integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT EXISTS (SELECT 1 FROM public.game_schedule WHERE game = p_game) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_bet_type IS NULL OR p_bet_type NOT IN (
    'single_open', 'single_close', 'jodi', 'patti_open', 'patti_close'
  ) THEN RAISE EXCEPTION 'Invalid bet type'; END IF;
  IF COALESCE(jsonb_typeof(p_selections), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;
  v_rules := public.internal_rule_constants();
  v_max_bet := (v_rules->>'maximum_bet')::integer;
  v_max_submit := (v_rules->>'maximum_submit')::integer;

  v_lock_date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  PERFORM pg_advisory_xact_lock_shared(public.round_lock_key(p_game, v_lock_date));
  PERFORM pg_advisory_xact_lock(public.bet_type_lock_key(p_game, v_lock_date, p_bet_type));
  v_round := public.bet_round(p_game, p_bet_type);
  IF v_round IS NOT NULL AND v_round <> v_lock_date THEN RAISE EXCEPTION 'Please try again.'; END IF;
  IF v_round IS NULL THEN RAISE EXCEPTION 'Betting is closed for this bet type right now.'; END IF;

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
  IF v_new_total > v_max_submit THEN
    RAISE EXCEPTION 'A single submit can total at most % points', v_max_submit;
  END IF;
  v_daily_loss_limit := v_limits.daily_loss_limit;
  IF v_daily_loss_limit IS NOT NULL THEN
    SELECT COALESCE(SUM(CASE WHEN reason = 'selection_submit' THEN -delta::bigint
                             WHEN reason = 'winning_payout' THEN -delta::bigint ELSE 0 END), 0)
    INTO v_today_net_loss
    FROM public.point_ledger
    WHERE user_id = v_uid AND reason IN ('selection_submit', 'winning_payout')
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
  v_multiplier := CASE p_bet_type WHEN 'single_open' THEN 9 WHEN 'single_close' THEN 9
    WHEN 'jodi' THEN 90 ELSE 120 END;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::bigint;
    SELECT COALESCE(SUM((entry.item->>'points')::bigint * v_multiplier), 0)
    INTO v_number_liability
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game AND s.bet_type = p_bet_type AND s.round_date = v_round
      AND entry.item->>'number' = v_num;
    IF v_number_liability + v_pts::bigint * v_multiplier > v_max_number_liability THEN
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

CREATE OR REPLACE FUNCTION public.request_add_funds(
  p_amount integer,
  p_payment_ref text,
  p_screenshot_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_banned boolean;
  v_terms_accepted_at timestamptz;
  v_existing_pending integer;
  v_limits public.user_limits%ROWTYPE;
  v_today_deposits bigint;
  v_day_start timestamptz;
  v_max_add_funds integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  v_max_add_funds := (public.internal_rule_constants()->>'maximum_add_funds')::integer;
  PERFORM 1 FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  SELECT is_banned, terms_accepted_at INTO v_banned, v_terms_accepted_at
  FROM public.profiles WHERE id = v_uid;
  IF v_terms_accepted_at IS NULL THEN RAISE EXCEPTION 'Please accept the Terms and Privacy Policy first.'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be a positive whole number'; END IF;
  IF p_amount > v_max_add_funds THEN
    RAISE EXCEPTION 'Maximum add-funds amount is %', v_max_add_funds;
  END IF;
  IF p_payment_ref IS NULL OR trim(p_payment_ref) !~ '^[0-9A-Za-z]{8,30}$' THEN
    RAISE EXCEPTION 'Payment reference must be 8 to 30 letters or numbers';
  END IF;
  IF p_screenshot_path IS NOT NULL AND (
       p_screenshot_path NOT LIKE v_uid::text || '/%'
       OR (storage.foldername(p_screenshot_path))[1] IS DISTINCT FROM v_uid::text
     ) THEN RAISE EXCEPTION 'Invalid screenshot path'; END IF;
  PERFORM public.apply_pending_user_limits(v_uid);
  SELECT * INTO v_limits FROM public.user_limits WHERE user_id = v_uid;
  IF v_limits.self_excluded_until > now() THEN
    RAISE EXCEPTION 'Deposits are unavailable until your self-exclusion ends on %.', v_limits.self_excluded_until;
  END IF;
  IF v_limits.daily_deposit_limit IS NOT NULL THEN
    v_day_start := ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
    SELECT COALESCE(SUM(amount), 0) INTO v_today_deposits
    FROM public.add_funds_requests
    WHERE user_id = v_uid AND status IN ('approved', 'pending') AND created_at >= v_day_start;
    IF v_today_deposits + p_amount > v_limits.daily_deposit_limit THEN
      RAISE EXCEPTION 'Daily deposit limit reached. Limit: % points; today: % points.',
        v_limits.daily_deposit_limit, v_today_deposits;
    END IF;
  END IF;
  SELECT count(*) INTO v_existing_pending FROM public.add_funds_requests
  WHERE user_id = v_uid AND status = 'pending';
  IF v_existing_pending > 0 THEN
    RAISE EXCEPTION 'You already have a pending add-funds request. Wait for it to be processed.';
  END IF;
  IF p_screenshot_path IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.add_funds_requests WHERE screenshot_path = p_screenshot_path
  ) THEN RAISE EXCEPTION 'This screenshot has already been used for another request.'; END IF;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref, screenshot_path)
  VALUES (v_uid, p_amount, 'pending', trim(p_payment_ref), p_screenshot_path);
  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.request_add_funds(integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_add_funds(integer, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_withdrawal(p_amount integer, p_upi_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_wallet integer;
  v_banned boolean;
  v_pending_count integer;
  v_approved_deposits bigint;
  v_wagered_turnover bigint;
  v_remaining_turnover bigint;
  v_rules jsonb;
  v_min_withdrawal integer;
  v_max_withdrawal integer;
  v_approved_deposit_minimum integer;
  v_turnover_multiplier integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  v_rules := public.internal_rule_constants();
  v_min_withdrawal := (v_rules->>'minimum_withdrawal')::integer;
  v_max_withdrawal := (v_rules->>'maximum_withdrawal')::integer;
  v_approved_deposit_minimum := (v_rules->>'approved_deposit_minimum')::integer;
  v_turnover_multiplier := (v_rules->>'turnover_multiplier')::integer;
  SELECT wallet, is_banned INTO v_wallet, v_banned
  FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be a positive whole number'; END IF;
  IF p_amount < v_min_withdrawal THEN RAISE EXCEPTION 'Minimum withdrawal is % points.', v_min_withdrawal; END IF;
  IF p_amount > v_max_withdrawal THEN RAISE EXCEPTION 'Maximum withdrawal is % points.', v_max_withdrawal; END IF;
  IF p_upi_id IS NULL OR trim(p_upi_id) !~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'Enter a valid UPI ID in the format username@provider.';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_approved_deposits
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'approved';
  IF v_approved_deposits < v_approved_deposit_minimum THEN
    RAISE EXCEPTION 'Add at least % approved deposit points before requesting a withdrawal.', v_approved_deposit_minimum;
  END IF;
  SELECT COALESCE(SUM(ABS(delta::bigint)), 0) INTO v_wagered_turnover
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'selection_submit';
  v_remaining_turnover := GREATEST(
    v_approved_deposits * v_turnover_multiplier - v_wagered_turnover, 0
  );
  IF v_remaining_turnover > 0 THEN
    RAISE EXCEPTION 'Wager % more points before withdrawing. Required turnover: % points; completed: % points.',
      v_remaining_turnover, v_approved_deposits * v_turnover_multiplier, v_wagered_turnover;
  END IF;
  SELECT count(*) INTO v_pending_count FROM public.withdrawals
  WHERE user_id = v_uid AND status = 'pending';
  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'You already have a withdrawal awaiting admin approval. Wait for it to be processed before requesting another.';
  END IF;
  IF v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. You have %, requested %.', v_wallet, p_amount;
  END IF;
  UPDATE public.profiles SET wallet = wallet - p_amount WHERE id = v_uid;
  INSERT INTO public.withdrawals (user_id, amount, status, upi_id)
  VALUES (v_uid, p_amount, 'pending', trim(p_upi_id));
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -p_amount, 'withdrawal_request', jsonb_build_object('upi_id', trim(p_upi_id)));
  SELECT wallet INTO v_wallet FROM public.profiles WHERE id = v_uid;
  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount, 'remaining_wallet', v_wallet);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.request_withdrawal(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_withdrawal(integer, text) TO authenticated;

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
  v_rules jsonb;
  v_min_withdrawal integer;
  v_max_withdrawal integer;
  v_approved_deposit_minimum integer;
  v_turnover_multiplier integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  v_rules := public.internal_rule_constants();
  v_min_withdrawal := (v_rules->>'minimum_withdrawal')::integer;
  v_max_withdrawal := (v_rules->>'maximum_withdrawal')::integer;
  v_approved_deposit_minimum := (v_rules->>'approved_deposit_minimum')::integer;
  v_turnover_multiplier := (v_rules->>'turnover_multiplier')::integer;
  SELECT points, wallet, is_banned INTO v_points, v_wallet, v_is_banned
  FROM public.profiles WHERE id = v_uid;
  SELECT COALESCE(SUM(amount), 0)::integer INTO v_pending_withdrawals
  FROM public.withdrawals WHERE user_id = v_uid AND status = 'pending';
  SELECT COALESCE(SUM(amount), 0) INTO v_approved_deposits
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'approved';
  SELECT COALESCE(SUM(ABS(delta::bigint)), 0) INTO v_wagered_turnover
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'selection_submit';
  v_turnover_remaining := GREATEST(
    v_approved_deposits * v_turnover_multiplier - v_wagered_turnover, 0
  );
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
    'withdrawal_eligible', NOT v_is_banned
      AND v_wallet >= v_min_withdrawal
      AND v_pending_withdrawals = 0
      AND v_approved_deposits >= v_approved_deposit_minimum
      AND v_turnover_remaining = 0
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_wallet_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_wallet_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_stats(p_round_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
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
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can view stats'; END IF;
  SELECT count(*), count(*) FILTER (WHERE is_banned), count(*) FILTER (WHERE is_admin),
         COALESCE(SUM(points), 0), COALESCE(SUM(wallet), 0)
  INTO v_total_users, v_banned, v_admin_count, v_total_points, v_total_wallet
  FROM public.profiles;
  SELECT count(*), COALESCE(SUM(amount), 0) INTO v_pending_wd_count, v_pending_wd_amount
  FROM public.withdrawals WHERE status = 'pending';
  SELECT count(*), COALESCE(SUM(amount), 0) INTO v_pending_af_count, v_pending_af_amount
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
    FROM public.game_schedule g
    LEFT JOIN public.selections s ON s.game = g.game AND s.round_date = v_round_date
    GROUP BY g.game
  ) game_counts;
  RETURN jsonb_build_object(
    'total_users', v_total_users, 'banned_users', v_banned, 'admin_count', v_admin_count,
    'total_points', v_total_points, 'total_wallet', v_total_wallet,
    'pending_withdrawals_count', v_pending_wd_count, 'pending_withdrawals_amount', v_pending_wd_amount,
    'pending_addfunds_count', v_pending_af_count, 'pending_addfunds_amount', v_pending_af_amount,
    'round_date', v_round_date, 'selection_counts', v_selection_counts
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_stats(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_stats(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_selections(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list selections'; END IF;
  IF p_round_date IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.game_schedule WHERE game = p_game
  ) THEN RAISE EXCEPTION 'A valid game and round date are required'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id, 'user_id', s.user_id, 'user_name', p.display_name,
    'bet_type', s.bet_type, 'round_date', s.round_date, 'selections', s.selections,
    'total_points', s.total_points, 'updated_at', s.updated_at
  ) ORDER BY s.updated_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.selections s
  JOIN public.profiles p ON p.id = s.user_id
  WHERE s.game = p_game AND s.round_date = p_round_date;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_selections(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_selections(text, date) TO authenticated;

DROP FUNCTION public.get_my_bets(text, date, date, integer, integer);
CREATE FUNCTION public.get_my_bets(
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
    SELECT 1 FROM public.game_schedule WHERE game = p_game
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
      CASE WHEN phase_paid AND number = winning_number THEN 'won'
           WHEN phase_paid THEN 'lost' ELSE 'pending' END AS status,
      CASE WHEN phase_paid AND number = winning_number
        THEN stake * public.bet_multiplier(bet_type) ELSE 0 END AS payout
    FROM raw_picks rp
  ), round_totals AS (
    SELECT priced.game, priced.round_date,
      SUM(priced.stake)::bigint AS round_staked,
      SUM(priced.payout)::bigint AS round_won,
      COALESCE(SUM(priced.stake) FILTER (WHERE NOT COALESCE(priced.phase_paid, false)), 0)::bigint AS round_pending_stake
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
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_game IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.game_schedule WHERE game = p_game
  ) THEN RAISE EXCEPTION 'Invalid game'; END IF;
  RETURN QUERY
  SELECT wr.round_date, wr.open_patti, wr.open_digit, wr.close_patti, wr.close_digit,
    CASE WHEN wr.open_digit IS NOT NULL AND wr.close_digit IS NOT NULL
      THEN wr.open_digit || wr.close_digit ELSE NULL END
  FROM public.winning_results wr
  WHERE wr.game = p_game
  ORDER BY wr.round_date DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_result_history(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_result_history(text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_add_blocked_domain(p_domain text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_domain text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  v_domain := lower(btrim(p_domain));
  IF v_domain IS NULL OR v_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$' THEN
    RAISE EXCEPTION 'Invalid email domain';
  END IF;
  INSERT INTO public.blocked_email_domains (domain)
  VALUES (v_domain)
  ON CONFLICT (domain) DO NOTHING;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'add_blocked_domain', jsonb_build_object('domain', v_domain));
  RETURN jsonb_build_object('domain', v_domain);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_add_blocked_domain(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_blocked_domain(text) TO authenticated;

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
    'close_support_ticket', 'add_blocked_domain'
  ));

CREATE FUNCTION public.admin_get_settings()
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
    'key', settings.setting_key,
    'value', app.value,
    'updated_at', app.updated_at,
    'updated_by', app.updated_by,
    'updated_by_display_name', profile.display_name
  ) ORDER BY settings.setting_key), '[]'::jsonb)
  INTO v_result
  FROM (VALUES
    ('approval_time_note'),
    ('max_number_liability'),
    ('max_user_round_points'),
    ('merchant_name'),
    ('merchant_upi_id'),
    ('support_email'),
    ('support_whatsapp')
  ) AS settings(setting_key)
  LEFT JOIN public.app_settings app ON app.key = settings.setting_key
  LEFT JOIN public.profiles profile ON profile.id = app.updated_by;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_settings() TO authenticated;
