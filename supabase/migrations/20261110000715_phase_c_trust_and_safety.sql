ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS age_confirmed boolean NOT NULL DEFAULT false;

CREATE TABLE public.user_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_deposit_limit integer,
  daily_loss_limit integer,
  cooldown_until timestamptz,
  self_excluded_until timestamptz,
  pending_deposit_limit integer,
  pending_loss_limit integer,
  pending_effective_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_limits_daily_deposit_positive CHECK (daily_deposit_limit IS NULL OR daily_deposit_limit > 0),
  CONSTRAINT user_limits_daily_loss_positive CHECK (daily_loss_limit IS NULL OR daily_loss_limit > 0),
  CONSTRAINT user_limits_pending_deposit_positive CHECK (pending_deposit_limit IS NULL OR pending_deposit_limit > 0),
  CONSTRAINT user_limits_pending_loss_positive CHECK (pending_loss_limit IS NULL OR pending_loss_limit > 0)
);
ALTER TABLE public.user_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_limits TO authenticated;
CREATE POLICY user_limits_select_own ON public.user_limits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('deposit', 'withdrawal', 'bet', 'account', 'other')),
  request_ref uuid,
  message text NOT NULL CHECK (char_length(message) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_tickets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_tickets TO authenticated;
CREATE POLICY support_tickets_select_own ON public.support_tickets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX support_tickets_status_created_idx
  ON public.support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_user_created_idx
  ON public.support_tickets (user_id, created_at DESC);

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
    'close_support_ticket'
  ));

CREATE OR REPLACE FUNCTION public.apply_pending_user_limits(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cannot apply limits for another user';
  END IF;
  UPDATE public.user_limits
  SET daily_deposit_limit = pending_deposit_limit,
      daily_loss_limit = pending_loss_limit,
      pending_deposit_limit = NULL,
      pending_loss_limit = NULL,
      pending_effective_at = NULL,
      updated_at = now()
  WHERE user_id = p_user_id
    AND pending_effective_at IS NOT NULL
    AND pending_effective_at <= now();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.apply_pending_user_limits(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_pending_user_limits(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_limits()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_limits public.user_limits%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  PERFORM public.apply_pending_user_limits(v_uid);
  INSERT INTO public.user_limits (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_limits FROM public.user_limits WHERE user_id = v_uid;
  RETURN jsonb_build_object(
    'daily_deposit_limit', v_limits.daily_deposit_limit,
    'daily_loss_limit', v_limits.daily_loss_limit,
    'cooldown_until', v_limits.cooldown_until,
    'self_excluded_until', v_limits.self_excluded_until,
    'pending_deposit_limit', v_limits.pending_deposit_limit,
    'pending_loss_limit', v_limits.pending_loss_limit,
    'pending_effective_at', v_limits.pending_effective_at
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_limits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_limits() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_my_limits(
  p_daily_deposit integer,
  p_daily_loss integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_current public.user_limits%ROWTYPE;
  v_deposit integer;
  v_loss integer;
  v_pending_deposit integer;
  v_pending_loss integer;
  v_effective_at timestamptz;
  v_deposit_delayed boolean;
  v_loss_delayed boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF p_daily_deposit IS NOT NULL AND p_daily_deposit < 1 THEN
    RAISE EXCEPTION 'Daily deposit limit must be a positive whole number or empty';
  END IF;
  IF p_daily_loss IS NOT NULL AND p_daily_loss < 1 THEN
    RAISE EXCEPTION 'Daily loss limit must be a positive whole number or empty';
  END IF;

  PERFORM public.apply_pending_user_limits(v_uid);
  INSERT INTO public.user_limits (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_current FROM public.user_limits WHERE user_id = v_uid FOR UPDATE;

  v_deposit_delayed := v_current.daily_deposit_limit IS NOT NULL
    AND (p_daily_deposit IS NULL OR p_daily_deposit > v_current.daily_deposit_limit);
  v_loss_delayed := v_current.daily_loss_limit IS NOT NULL
    AND (p_daily_loss IS NULL OR p_daily_loss > v_current.daily_loss_limit);

  v_deposit := CASE WHEN v_deposit_delayed THEN v_current.daily_deposit_limit ELSE p_daily_deposit END;
  v_loss := CASE WHEN v_loss_delayed THEN v_current.daily_loss_limit ELSE p_daily_loss END;
  v_pending_deposit := p_daily_deposit;
  v_pending_loss := p_daily_loss;
  v_effective_at := CASE WHEN v_deposit_delayed OR v_loss_delayed THEN now() + interval '24 hours' ELSE NULL END;

  UPDATE public.user_limits
  SET daily_deposit_limit = v_deposit,
      daily_loss_limit = v_loss,
      pending_deposit_limit = CASE WHEN v_effective_at IS NULL THEN NULL ELSE v_pending_deposit END,
      pending_loss_limit = CASE WHEN v_effective_at IS NULL THEN NULL ELSE v_pending_loss END,
      pending_effective_at = v_effective_at,
      updated_at = now()
  WHERE user_id = v_uid;
  RETURN public.get_my_limits();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_my_limits(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_limits(integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_cooldown(p_hours integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_until timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF p_hours IS NULL OR p_hours NOT IN (1, 6, 24, 72) THEN
    RAISE EXCEPTION 'Cooldown must be 1, 6, 24, or 72 hours';
  END IF;
  INSERT INTO public.user_limits (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.user_limits
  SET cooldown_until = GREATEST(COALESCE(cooldown_until, now()), now() + make_interval(hours => p_hours)),
      updated_at = now()
  WHERE user_id = v_uid
  RETURNING cooldown_until INTO v_until;
  RETURN v_until;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.start_cooldown(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_cooldown(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.self_exclude(p_days integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_until timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF p_days IS NULL OR p_days NOT IN (7, 30, 90, 180) THEN
    RAISE EXCEPTION 'Self-exclusion must be 7, 30, 90, or 180 days';
  END IF;
  INSERT INTO public.user_limits (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.user_limits
  SET self_excluded_until = GREATEST(COALESCE(self_excluded_until, now()), now() + make_interval(days => p_days)),
      updated_at = now()
  WHERE user_id = v_uid
  RETURNING self_excluded_until INTO v_until;
  RETURN v_until;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.self_exclude(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_exclude(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_terms(p_version text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();
  IF p_version IS NULL OR length(trim(p_version)) < 1 OR length(trim(p_version)) > 40 THEN
    RAISE EXCEPTION 'Terms version is required';
  END IF;
  UPDATE public.profiles
  SET age_confirmed = true,
      terms_accepted_at = now(),
      terms_version = trim(p_version)
  WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  RETURN jsonb_build_object('accepted', true, 'terms_version', trim(p_version));
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_terms(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_terms(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_terms_version text;
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'accepted_terms', '') <> 'true'
     OR NULLIF(trim(NEW.raw_user_meta_data->>'terms_version'), '') IS NULL THEN
    RAISE EXCEPTION 'TERMS_NOT_ACCEPTED';
  END IF;
  v_terms_version := left(trim(NEW.raw_user_meta_data->>'terms_version'), 40);
  INSERT INTO public.profiles (
    id, display_name, points, email_normalized, age_confirmed,
    terms_accepted_at, terms_version
  )
  VALUES (
    NEW.id,
    left(COALESCE(NEW.raw_user_meta_data->>'display_name', ''), 50),
    0,
    public.normalize_email(NEW.email),
    true,
    now(),
    v_terms_version
  );

  IF NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.profiles SET points = points + 10 WHERE id = NEW.id;
    INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
    VALUES (NEW.id, 10, 'signup_bonus', jsonb_build_object('source', 'signup'));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

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

  v_lock_date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date;
  PERFORM pg_advisory_xact_lock_shared(public.round_lock_key(p_game, v_lock_date));
  v_round := public.bet_round(p_game, p_bet_type);
  IF v_round IS NOT NULL AND v_round <> v_lock_date THEN
    PERFORM pg_advisory_xact_lock_shared(public.round_lock_key(p_game, v_round));
    v_round := public.bet_round(p_game, p_bet_type);
  END IF;
  IF v_round IS NULL THEN RAISE EXCEPTION 'Betting is closed for this bet type right now.'; END IF;

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
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  PERFORM 1 FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  SELECT is_banned, terms_accepted_at INTO v_banned, v_terms_accepted_at
  FROM public.profiles WHERE id = v_uid;
  IF v_terms_accepted_at IS NULL THEN RAISE EXCEPTION 'Please accept the Terms and Privacy Policy first.'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be a positive whole number'; END IF;
  IF p_amount > 100000 THEN RAISE EXCEPTION 'Maximum add-funds amount is 100000'; END IF;
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
  v_terms_accepted_at timestamptz;
  v_pending_count integer;
  v_approved_deposits bigint;
  v_wagered_turnover bigint;
  v_remaining_turnover bigint;
  v_min_withdrawal CONSTANT integer := 100;
  v_max_withdrawal CONSTANT integer := 100000;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  SELECT wallet, is_banned, terms_accepted_at
  INTO v_wallet, v_banned, v_terms_accepted_at
  FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF v_terms_accepted_at IS NULL THEN RAISE EXCEPTION 'Please accept the Terms and Privacy Policy first.'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be a positive whole number'; END IF;
  IF p_amount < v_min_withdrawal THEN RAISE EXCEPTION 'Minimum withdrawal is % points.', v_min_withdrawal; END IF;
  IF p_amount > v_max_withdrawal THEN RAISE EXCEPTION 'Maximum withdrawal is % points.', v_max_withdrawal; END IF;
  IF p_upi_id IS NULL OR trim(p_upi_id) !~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'Enter a valid UPI ID in the format username@provider.';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_approved_deposits
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'approved';
  IF v_approved_deposits < v_min_withdrawal THEN
    RAISE EXCEPTION 'Add at least 100 approved deposit points before requesting a withdrawal.';
  END IF;
  SELECT COALESCE(SUM(ABS(delta::bigint)), 0) INTO v_wagered_turnover
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'selection_submit';
  v_remaining_turnover := GREATEST(v_approved_deposits - v_wagered_turnover, 0);
  IF v_remaining_turnover > 0 THEN
    RAISE EXCEPTION 'Wager % more points before withdrawing. Required turnover: % points; completed: % points.',
      v_remaining_turnover, v_approved_deposits, v_wagered_turnover;
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

CREATE OR REPLACE FUNCTION public.get_app_setting(p_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_value text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_key IS NULL OR p_key NOT IN (
    'merchant_upi_id', 'merchant_name', 'approval_time_note',
    'support_whatsapp', 'support_email'
  ) THEN RAISE EXCEPTION 'Unknown setting'; END IF;
  SELECT value INTO v_value FROM public.app_settings WHERE key = p_key;
  RETURN v_value;
END
$$;
REVOKE EXECUTE ON FUNCTION public.get_app_setting(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_app_setting(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_public_rules()
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
    'turnover_multiplier', 1,
    'maximum_bet', 5000,
    'maximum_submit', 20000,
    'cooldown_hours', jsonb_build_array(1, 6, 24, 72),
    'self_exclusion_days', jsonb_build_array(7, 30, 90, 180)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_public_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_rules() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_app_setting(p_key text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_numeric numeric;
  v_value text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can update settings'; END IF;
  IF p_key IS NULL OR p_key NOT IN (
    'merchant_upi_id', 'merchant_name', 'approval_time_note',
    'support_whatsapp', 'support_email',
    'max_user_round_points', 'max_number_liability'
  ) THEN RAISE EXCEPTION 'Unknown setting'; END IF;
  IF p_value IS NULL THEN RAISE EXCEPTION 'Setting value is required'; END IF;
  v_value := trim(p_value);
  IF p_key NOT IN ('approval_time_note', 'support_whatsapp', 'support_email') AND length(v_value) = 0 THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;
  IF p_key = 'approval_time_note' AND char_length(v_value) > 120 THEN
    RAISE EXCEPTION 'Approval time note cannot exceed 120 characters';
  END IF;
  IF p_key = 'merchant_upi_id' AND v_value !~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'UPI ID must use the format username@provider';
  END IF;
  IF p_key = 'support_whatsapp' AND length(v_value) > 32 THEN
    RAISE EXCEPTION 'Support WhatsApp number is invalid';
  END IF;
  IF p_key = 'support_whatsapp' AND length(v_value) > 0
     AND v_value !~ '^\+?[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Support WhatsApp must be an international phone number';
  END IF;
  IF p_key = 'support_email' AND length(v_value) > 254 THEN
    RAISE EXCEPTION 'Support email is invalid';
  END IF;
  IF p_key = 'support_email' AND length(v_value) > 0
     AND v_value !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
    RAISE EXCEPTION 'Support email is invalid';
  END IF;
  IF p_key IN ('max_user_round_points', 'max_number_liability') THEN
    IF v_value !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'Exposure limits must be positive whole numbers'; END IF;
    v_numeric := v_value::numeric;
    IF v_numeric > 2147483647 THEN RAISE EXCEPTION 'Exposure limit is too large'; END IF;
  END IF;
  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES (p_key, v_value, v_uid)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = v_uid, updated_at = now();
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'set_setting', jsonb_build_object('key', p_key, 'value', v_value));
  RETURN jsonb_build_object('key', p_key, 'value', v_value);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_set_app_setting(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_app_setting(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_support_ticket(
  p_category text,
  p_request_ref uuid,
  p_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_ticket public.support_tickets%ROWTYPE;
  v_day_start timestamptz;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_category IS NULL OR p_category NOT IN ('deposit', 'withdrawal', 'bet', 'account', 'other') THEN
    RAISE EXCEPTION 'Invalid support category';
  END IF;
  IF p_message IS NULL OR char_length(trim(p_message)) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'Message must be between 5 and 1000 characters';
  END IF;
  IF p_request_ref IS NOT NULL AND NOT (
    EXISTS (SELECT 1 FROM public.add_funds_requests WHERE id = p_request_ref AND user_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.withdrawals WHERE id = p_request_ref AND user_id = v_uid)
  ) THEN RAISE EXCEPTION 'Referenced request was not found'; END IF;
  v_day_start := ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text || ':support-ticket:' || v_day_start::date::text, 0));
  SELECT count(*) INTO v_count FROM public.support_tickets
  WHERE user_id = v_uid AND created_at >= v_day_start;
  IF v_count >= 5 THEN RAISE EXCEPTION 'Daily support ticket limit reached'; END IF;
  INSERT INTO public.support_tickets (user_id, category, request_ref, message)
  VALUES (v_uid, p_category, p_request_ref, trim(p_message))
  RETURNING * INTO v_ticket;
  RETURN jsonb_build_object('id', v_ticket.id, 'status', v_ticket.status, 'created_at', v_ticket.created_at);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.submit_support_ticket(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_support_ticket(text, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_support_tickets(
  p_status text DEFAULT 'open',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list support tickets'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'closed') THEN RAISE EXCEPTION 'Invalid ticket status'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;
  SELECT COALESCE(jsonb_agg(ticket_row ORDER BY created_at DESC, ticket_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'user_id', t.user_id, 'user_name', p.display_name,
      'category', t.category, 'request_ref', t.request_ref, 'message', t.message,
      'status', t.status, 'admin_note', t.admin_note, 'created_at', t.created_at, 'closed_at', t.closed_at
    ) AS ticket_row, t.created_at, t.id AS ticket_id
    FROM public.support_tickets t
    JOIN public.profiles p ON p.id = t.user_id
    WHERE p_status IS NULL OR t.status = p_status
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT p_limit OFFSET p_offset
  ) page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_support_tickets(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_support_tickets(text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_close_ticket(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_user_id uuid;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can close support tickets'; END IF;
  IF p_note IS NOT NULL AND char_length(trim(p_note)) > 1000 THEN RAISE EXCEPTION 'Admin note cannot exceed 1000 characters'; END IF;
  SELECT user_id, status INTO v_user_id, v_status
  FROM public.support_tickets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Support ticket not found'; END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'Support ticket is already closed'; END IF;
  UPDATE public.support_tickets
  SET status = 'closed', admin_note = NULLIF(trim(p_note), ''), closed_at = now()
  WHERE id = p_id;
  INSERT INTO public.admin_action_log (actor_id, target_user_id, action, metadata)
  VALUES (v_uid, v_user_id, 'close_support_ticket', jsonb_build_object('ticket_id', p_id));
  RETURN jsonb_build_object('id', p_id, 'status', 'closed');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_close_ticket(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_close_ticket(uuid, text) TO authenticated;
