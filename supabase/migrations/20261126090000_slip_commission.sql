/*
# Slip commission on Matka games (not sports)

Like offline Matka: for every full ₹100 a player pays on one slip, they get ₹5
extra to play on a number of their choice in that same slip. The extra stake
is free. Only the paid amount leaves their balance.

| paid on slip | commission | total played |
|--------------|------------|--------------|
| ₹99          | ₹0         | ₹99          |
| ₹100         | ₹5         | ₹105         |
| ₹150         | ₹5         | ₹155         |
| ₹200         | ₹10        | ₹210         |

1. submit_selection() gets a 4th argument, p_commission_number. The server
   works out the commission itself (floor(paid / 100) * 5); the client only
   says which number to put it on. It can be a number already on the slip or a
   different valid number for that bet type. When the slip earns commission
   and no number is given, it goes on the slip's first number, so it is never
   lost.
   - The per-bet maximum, the per-submit maximum and the daily loss limit look
     only at the paid amount.
   - The round stake limit and the number liability limit include the
     commission, because the house can lose on it.
   - The selection_submit ledger row is still -paid; its metadata records
     'commission' and 'commission_number'.
   - selections.commission_points keeps a running total of the free stake in
     each slip; total_points still means everything on the numbers.
   Settlement is unchanged: the commission is part of the number's stake and
   wins at the normal rate.

2. get_public_rules() returns 'commission_per_100' (always 5) so the slip
   screen can show it. The rate is fixed; there is no admin switch.
*/

-- 1. Free stake per slip ------------------------------------------------------------
ALTER TABLE public.selections
  ADD COLUMN IF NOT EXISTS commission_points integer NOT NULL DEFAULT 0
  CHECK (commission_points >= 0);

-- ₹5 free for every full ₹100 paid on one slip.
CREATE OR REPLACE FUNCTION public.game_commission_per_100()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT 5;
$$;
REVOKE EXECUTE ON FUNCTION public.game_commission_per_100() FROM PUBLIC, anon, authenticated;

-- 2. submit_selection with commission -------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_selection(text, jsonb, text);

CREATE OR REPLACE FUNCTION public.submit_selection(
  p_game text,
  p_selections jsonb,
  p_bet_type text DEFAULT 'jodi',
  p_commission_number text DEFAULT NULL
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
  v_merged jsonb;
  v_seen text[] := '{}';
  v_new_total integer := 0;
  v_new_count integer := 0;
  v_commission integer := 0;
  v_commission_number text;
  v_stake_total integer;
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
    -- The same number twice in one submit is combined into one entry.
    IF v_num = ANY(v_seen) THEN
      SELECT COALESCE(jsonb_agg(
               CASE WHEN e->>'number' = v_num
                    THEN jsonb_build_object('number', v_num, 'points', (e->>'points')::int + v_pts::int)
                    ELSE e END ORDER BY o), '[]'::jsonb)
      INTO v_new
      FROM jsonb_array_elements(v_new) WITH ORDINALITY AS x(e, o);
    ELSE
      v_seen := array_append(v_seen, v_num);
      v_new := v_new || jsonb_build_array(jsonb_build_object('number', v_num, 'points', v_pts::int));
      v_new_count := v_new_count + 1;
    END IF;
    v_new_total := v_new_total + v_pts::int;
  END LOOP;
  IF v_new_count = 0 THEN RAISE EXCEPTION 'Add at least one number.'; END IF;
  IF v_new_total > v_max_submit THEN
    RAISE EXCEPTION 'A single submit can total at most % points', v_max_submit;
  END IF;

  -- Commission: a free stake for every full 100 paid on this slip.
  v_commission := (v_new_total / 100) * public.game_commission_per_100();
  IF v_commission > 0 THEN
    v_commission_number := NULLIF(btrim(COALESCE(p_commission_number, '')), '');
    IF v_commission_number IS NULL THEN
      v_commission_number := v_new->0->>'number';
    ELSIF p_bet_type IN ('single_open', 'single_close') THEN
      IF v_commission_number !~ '^[0-9]$' THEN RAISE EXCEPTION 'Commission number must be one digit (0-9)'; END IF;
    ELSIF p_bet_type = 'jodi' THEN
      IF v_commission_number !~ '^[0-9]{2}$' THEN RAISE EXCEPTION 'Commission number must be two digits (00-99)'; END IF;
    ELSIF NOT public.is_valid_patti_combo(v_commission_number) THEN
      RAISE EXCEPTION 'Invalid patti-digit combination for commission: %', v_commission_number;
    END IF;
    IF v_commission_number = ANY(v_seen) THEN
      SELECT COALESCE(jsonb_agg(
               CASE WHEN e->>'number' = v_commission_number
                    THEN jsonb_build_object('number', v_commission_number, 'points', (e->>'points')::int + v_commission)
                    ELSE e END ORDER BY o), '[]'::jsonb)
      INTO v_new
      FROM jsonb_array_elements(v_new) WITH ORDINALITY AS x(e, o);
    ELSE
      v_seen := array_append(v_seen, v_commission_number);
      v_new := v_new || jsonb_build_array(jsonb_build_object('number', v_commission_number, 'points', v_commission));
      v_new_count := v_new_count + 1;
    END IF;
  ELSE
    v_commission_number := NULL;
  END IF;
  v_stake_total := v_new_total + v_commission;

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
  IF v_user_round_total + v_stake_total > v_max_user_round_points THEN
    RAISE EXCEPTION 'Round stake limit exceeded: existing % + new % points would exceed limit %',
      v_user_round_total, v_stake_total, v_max_user_round_points;
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
  -- Only the paid amount leaves the balance; the commission is free.
  v_from_points := LEAST(v_points, v_new_total);
  v_from_wallet := v_new_total - v_from_points;
  UPDATE public.profiles SET points = points - v_from_points, wallet = wallet - v_from_wallet WHERE id = v_uid;
  -- Add repeat stakes onto existing entries, then append numbers not yet played.
  SELECT COALESCE(jsonb_agg(
           CASE WHEN n.item IS NULL THEN e
                ELSE jsonb_build_object('number', e->>'number',
                       'points', (e->>'points')::int + (n.item->>'points')::int) END
           ORDER BY o), '[]'::jsonb)
  INTO v_merged
  FROM jsonb_array_elements(v_existing) WITH ORDINALITY AS x(e, o)
  LEFT JOIN LATERAL (
    SELECT item FROM jsonb_array_elements(v_new) AS nw(item)
    WHERE nw.item->>'number' = x.e->>'number' LIMIT 1
  ) n ON true;
  SELECT v_merged || COALESCE(jsonb_agg(item ORDER BY o), '[]'::jsonb)
  INTO v_merged
  FROM jsonb_array_elements(v_new) WITH ORDINALITY AS nw(item, o)
  WHERE NOT (nw.item->>'number' = ANY(v_existing_nums));
  INSERT INTO public.selections (user_id, game, bet_type, round_date, selections, total_points, commission_points, updated_at)
  VALUES (v_uid, p_game, p_bet_type, v_round, v_merged, v_existing_total + v_stake_total, v_commission, now())
  ON CONFLICT (user_id, game, bet_type, round_date)
  DO UPDATE SET selections = EXCLUDED.selections, total_points = EXCLUDED.total_points,
                commission_points = public.selections.commission_points + EXCLUDED.commission_points,
                updated_at = now();
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -v_new_total, 'selection_submit',
    jsonb_build_object('game', p_game, 'bet_type', p_bet_type, 'round_date', v_round,
                       'new_numbers', v_new_count, 'from_points', v_from_points, 'from_wallet', v_from_wallet,
                       'commission', v_commission, 'commission_number', v_commission_number));
  RETURN jsonb_build_object('points', v_points - v_from_points, 'wallet', v_wallet - v_from_wallet,
    'new_points', v_new_total, 'new_count', v_new_count,
    'commission', v_commission, 'commission_number', v_commission_number,
    'total_numbers', jsonb_array_length(v_merged), 'round_date', v_round);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text, text) TO authenticated;

-- 3. Tell the slip screen the rate ------------------------------------------------------
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
    'self_exclusion_days', jsonb_build_array(7, 30, 90, 180),
    'commission_per_100', public.game_commission_per_100()
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_public_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_rules() TO authenticated;

