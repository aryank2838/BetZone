-- Round 3 fixes (external review).
-- Lock order after this migration:
--   settlement lock (global, exclusive) -> round lock (exclusive) -> profiles
-- Bets take only the round lock (shared) -> bet-type lock -> their own profile,
-- so they never wait on the settlement lock and the A2 bet/settlement order holds.

-- ---------------------------------------------------------------------------
-- R2. Global settlement lock and ordered payouts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settlement_lock_key()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- SETTLEMENT_LOCK_KEY: one advisory key shared by every payout run, so two
  -- settlements never update winners' profiles at the same time.
  c_settlement_lock_key constant bigint := 724102000003;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN c_settlement_lock_key;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.settlement_lock_key() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_bets(
  p_game text,
  p_round date,
  p_bet_type text,
  p_winning text,
  p_multiplier integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec record;
  v_item jsonb;
  v_bet integer;
  v_payout integer;
  v_winners integer := 0;
  v_paid integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  -- R6: the multiplier always comes from bet_multiplier(); a caller passing a
  -- different value is a bug, not a pricing decision.
  IF p_multiplier IS DISTINCT FROM public.bet_multiplier(p_bet_type) THEN
    RAISE EXCEPTION 'Multiplier % does not match bet_multiplier(%) = %',
      p_multiplier, p_bet_type, public.bet_multiplier(p_bet_type);
  END IF;

  -- ORDER BY user_id: profiles are always locked in the same order.
  FOR v_rec IN
    SELECT user_id, selections
    FROM public.selections
    WHERE game = p_game
      AND bet_type = p_bet_type
      AND round_date = p_round
    ORDER BY user_id
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_rec.selections) LOOP
      IF v_item->>'number' = p_winning THEN
        v_bet := (v_item->>'points')::int;
        v_payout := v_bet * p_multiplier;
        UPDATE public.profiles
        SET wallet = wallet + v_payout
        WHERE id = v_rec.user_id;
        INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
        VALUES (
          v_rec.user_id,
          v_payout,
          'winning_payout',
          jsonb_build_object(
            'game', p_game,
            'bet_type', p_bet_type,
            'number', p_winning,
            'bet', v_bet,
            'multiplier', p_multiplier,
            'round_date', p_round
          )
        );
        v_winners := v_winners + 1;
        v_paid := v_paid + v_payout;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('winners', v_winners, 'paid', v_paid);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.settle_bets(text, date, text, text, integer)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_open_payouts(
  p_game text,
  p_round_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_digit text;
  v_patti text;
  v_done timestamptz;
  v_a jsonb;
  v_b jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  PERFORM pg_advisory_xact_lock(public.settlement_lock_key());
  PERFORM pg_advisory_xact_lock(
    public.round_lock_key(p_game, p_round_date)
  );

  SELECT open_digit, open_patti, open_processed_at
  INTO v_digit, v_patti, v_done
  FROM public.winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_digit IS NULL OR v_patti IS NULL THEN
    RAISE EXCEPTION 'No open result posted for this round';
  END IF;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Open result for this round was already paid';
  END IF;

  v_a := public.settle_bets(
    p_game, p_round_date, 'single_open', v_digit, public.bet_multiplier('single_open')
  );
  v_b := public.settle_bets(
    p_game, p_round_date, 'patti_open', v_patti || '-' || v_digit,
    public.bet_multiplier('patti_open')
  );

  UPDATE public.winning_results
  SET open_processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'phase', 'open',
    'winners', (v_a->>'winners')::int + (v_b->>'winners')::int,
    'total_paid', (v_a->>'paid')::int + (v_b->>'paid')::int
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.process_open_payouts(text, date)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_close_payouts(
  p_game text,
  p_round_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_open_digit text;
  v_open_done timestamptz;
  v_digit text;
  v_patti text;
  v_done timestamptz;
  v_a jsonb;
  v_b jsonb;
  v_c jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  PERFORM pg_advisory_xact_lock(public.settlement_lock_key());
  PERFORM pg_advisory_xact_lock(
    public.round_lock_key(p_game, p_round_date)
  );

  SELECT open_digit, open_processed_at, close_digit, close_patti, close_processed_at
  INTO v_open_digit, v_open_done, v_digit, v_patti, v_done
  FROM public.winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_open_digit IS NULL OR v_open_done IS NULL THEN
    RAISE EXCEPTION 'Post the open result first';
  END IF;
  IF v_digit IS NULL OR v_patti IS NULL THEN
    RAISE EXCEPTION 'No close result posted for this round';
  END IF;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Close result for this round was already paid';
  END IF;

  v_a := public.settle_bets(
    p_game, p_round_date, 'single_close', v_digit, public.bet_multiplier('single_close')
  );
  v_b := public.settle_bets(
    p_game, p_round_date, 'patti_close', v_patti || '-' || v_digit,
    public.bet_multiplier('patti_close')
  );
  v_c := public.settle_bets(
    p_game, p_round_date, 'jodi', v_open_digit || v_digit, public.bet_multiplier('jodi')
  );

  UPDATE public.winning_results
  SET close_processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'phase', 'close',
    'winners',
      (v_a->>'winners')::int + (v_b->>'winners')::int + (v_c->>'winners')::int,
    'total_paid',
      (v_a->>'paid')::int + (v_b->>'paid')::int + (v_c->>'paid')::int
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.process_close_payouts(text, date)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- R3. Balance, amount, status and reason constraints.
-- Added NOT VALID, then checked: if existing rows violate a rule the migration
-- stops and lists them (nothing is changed or "fixed" silently). Then VALIDATE.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_points_nonnegative CHECK (points >= 0) NOT VALID,
  ADD CONSTRAINT profiles_wallet_nonnegative CHECK (wallet >= 0) NOT VALID;
ALTER TABLE public.withdrawals
  ADD CONSTRAINT withdrawals_amount_positive CHECK (amount > 0) NOT VALID,
  ADD CONSTRAINT withdrawals_status_valid
    CHECK (status IN ('pending', 'approved', 'rejected')) NOT VALID;
ALTER TABLE public.add_funds_requests
  ADD CONSTRAINT add_funds_requests_amount_positive CHECK (amount > 0) NOT VALID,
  ADD CONSTRAINT add_funds_requests_status_valid
    CHECK (status IN ('pending', 'approved', 'rejected')) NOT VALID;
-- Reasons: every literal inserted by a migration, plus 'ad_reward' (legacy rows
-- from the removed ad-reward feature).
ALTER TABLE public.point_ledger
  ADD CONSTRAINT point_ledger_delta_nonzero CHECK (delta <> 0) NOT VALID,
  ADD CONSTRAINT point_ledger_reason_valid CHECK (reason IN (
    'signup_bonus', 'selection_submit', 'winning_payout',
    'withdrawal_request', 'withdrawal_refund', 'add_funds',
    'admin_adjust_points', 'admin_adjust_wallet', 'ad_reward'
  )) NOT VALID;

DO $r3_check$
DECLARE
  v_report text := '';
  v_rows text;
BEGIN
  SELECT string_agg(format('profiles %s (points=%s, wallet=%s)', id, points, wallet), '; ')
  INTO v_rows
  FROM (SELECT id, points, wallet FROM public.profiles
        WHERE points < 0 OR wallet < 0 ORDER BY id LIMIT 20) bad;
  IF v_rows IS NOT NULL THEN v_report := v_report || v_rows || '; '; END IF;

  SELECT string_agg(format('withdrawals %s (amount=%s, status=%s)', id, amount, status), '; ')
  INTO v_rows
  FROM (SELECT id, amount, status FROM public.withdrawals
        WHERE amount <= 0 OR status IS NULL OR status NOT IN ('pending', 'approved', 'rejected')
        ORDER BY id LIMIT 20) bad;
  IF v_rows IS NOT NULL THEN v_report := v_report || v_rows || '; '; END IF;

  SELECT string_agg(format('add_funds_requests %s (amount=%s, status=%s)', id, amount, status), '; ')
  INTO v_rows
  FROM (SELECT id, amount, status FROM public.add_funds_requests
        WHERE amount <= 0 OR status IS NULL OR status NOT IN ('pending', 'approved', 'rejected')
        ORDER BY id LIMIT 20) bad;
  IF v_rows IS NOT NULL THEN v_report := v_report || v_rows || '; '; END IF;

  SELECT string_agg(format('point_ledger %s (delta=%s, reason=%s)', id, delta, reason), '; ')
  INTO v_rows
  FROM (SELECT id, delta, reason FROM public.point_ledger
        WHERE delta = 0 OR reason NOT IN (
          'signup_bonus', 'selection_submit', 'winning_payout',
          'withdrawal_request', 'withdrawal_refund', 'add_funds',
          'admin_adjust_points', 'admin_adjust_wallet', 'ad_reward')
        ORDER BY id LIMIT 20) bad;
  IF v_rows IS NOT NULL THEN v_report := v_report || v_rows || '; '; END IF;

  IF v_report <> '' THEN
    RAISE EXCEPTION 'R3: existing rows violate the new constraints (first 20 per table): %', v_report
      USING HINT = 'Review and correct these rows by hand, then re-run the migration.';
  END IF;
END
$r3_check$;

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_points_nonnegative;
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_wallet_nonnegative;
ALTER TABLE public.withdrawals VALIDATE CONSTRAINT withdrawals_amount_positive;
ALTER TABLE public.withdrawals VALIDATE CONSTRAINT withdrawals_status_valid;
ALTER TABLE public.add_funds_requests VALIDATE CONSTRAINT add_funds_requests_amount_positive;
ALTER TABLE public.add_funds_requests VALIDATE CONSTRAINT add_funds_requests_status_valid;
ALTER TABLE public.point_ledger VALIDATE CONSTRAINT point_ledger_delta_nonzero;
ALTER TABLE public.point_ledger VALIDATE CONSTRAINT point_ledger_reason_valid;

-- ---------------------------------------------------------------------------
-- R4 (DECISION). Keep financial history when an Auth user is deleted.
-- The user_id foreign keys of these four tables become ON DELETE RESTRICT, so
-- deleting a user with money or bet history fails; admins ban instead.
-- profiles, user_limits, support_tickets and user_ledger_opening_balances keep
-- ON DELETE CASCADE.
-- ---------------------------------------------------------------------------
DO $r4_fks$
DECLARE
  v_table text;
  v_constraint text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['point_ledger', 'withdrawals', 'add_funds_requests', 'selections'] LOOP
    SELECT c.conname INTO v_constraint
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f'
      AND c.conrelid = format('public.%I', v_table)::regclass
      AND c.confrelid = 'auth.users'::regclass
      AND a.attname = 'user_id'
      AND array_length(c.conkey, 1) = 1;
    IF v_constraint IS NULL THEN
      RAISE EXCEPTION 'R4: no user_id -> auth.users foreign key found on public.%', v_table;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_constraint);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT',
      v_table, v_constraint
    );
  END LOOP;
END
$r4_fks$;

-- ---------------------------------------------------------------------------
-- R6. One source of truth for payout multipliers: bet_multiplier().
-- (settle_bets and process_*_payouts above already use it.)
-- ---------------------------------------------------------------------------
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
  v_multiplier := public.bet_multiplier(p_bet_type);
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

-- ---------------------------------------------------------------------------
-- R7. Current terms version. The frontend re-asks for terms when
-- profiles.terms_version differs; the server still accepts any non-null
-- terms_accepted_at for betting and deposits, so a deploy locks nobody out.
-- get_public_rules() returns internal_rule_constants() merged with its own
-- lists, so current_terms_version is exposed there without other changes.
-- Keep in sync with TERMS_VERSION in src/lib/terms.ts.
-- ---------------------------------------------------------------------------
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
    'maximum_submit', 20000,
    'current_terms_version', '2026-11-10'
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.internal_rule_constants() FROM PUBLIC, anon, authenticated;
