INSERT INTO public.app_settings (key, value)
VALUES
  ('max_user_round_points', '50000'),
  ('max_number_liability', '1000000')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_setting_int(p_key text, p_default integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_value text;
  v_numeric numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_key IS NULL OR p_key NOT IN ('max_user_round_points', 'max_number_liability') THEN
    RAISE EXCEPTION 'Unknown integer setting';
  END IF;

  SELECT value INTO v_value
  FROM public.app_settings
  WHERE key = p_key;

  IF NOT FOUND THEN
    RETURN p_default;
  END IF;
  IF v_value !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Invalid integer setting: %', p_key;
  END IF;

  v_numeric := v_value::numeric;
  IF v_numeric > 2147483647 THEN
    RAISE EXCEPTION 'Integer setting is out of range: %', p_key;
  END IF;

  RETURN v_numeric::integer;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_setting_int(text, integer)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_app_setting(p_key text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_numeric numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can update settings';
  END IF;

  IF p_key IS NULL OR p_key NOT IN (
    'merchant_upi_id', 'merchant_name',
    'max_user_round_points', 'max_number_liability'
  ) THEN
    RAISE EXCEPTION 'Unknown setting';
  END IF;
  IF p_value IS NULL OR length(trim(p_value)) = 0 THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;

  IF p_key IN ('max_user_round_points', 'max_number_liability') THEN
    IF trim(p_value) !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'Exposure limits must be positive whole numbers';
    END IF;
    v_numeric := trim(p_value)::numeric;
    IF v_numeric > 2147483647 THEN
      RAISE EXCEPTION 'Exposure limit is too large';
    END IF;
  END IF;

  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES (p_key, trim(p_value), v_uid)
  ON CONFLICT (key)
  DO UPDATE SET
    value = EXCLUDED.value,
    updated_by = v_uid,
    updated_at = now();

  RETURN jsonb_build_object('key', p_key, 'value', trim(p_value));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_set_app_setting(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_app_setting(text, text)
  TO authenticated;

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
  v_points integer;
  v_wallet integer;
  v_banned boolean;
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

  SELECT points, wallet, is_banned
  INTO v_points, v_wallet, v_banned
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  IF COALESCE(v_banned, false) THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  v_round := public.bet_round(p_game, p_bet_type);
  IF v_round IS NULL THEN
    RAISE EXCEPTION 'Betting is closed for this bet type right now.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_game || ':' || v_round::text, 0)
  );

  SELECT selections INTO v_existing
  FROM public.selections
  WHERE user_id = v_uid
    AND game = p_game
    AND bet_type = p_bet_type
    AND round_date = v_round;
  v_existing := COALESCE(v_existing, '[]'::jsonb);

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_existing) LOOP
    v_existing_nums := array_append(v_existing_nums, v_row->>'number');
    v_existing_total := v_existing_total + (v_row->>'points')::int;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_selections) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::numeric;
    IF v_num IS NULL OR v_pts IS NULL THEN
      RAISE EXCEPTION 'Each selection needs a number and points';
    END IF;
    IF p_bet_type IN ('single_open', 'single_close') THEN
      IF v_num !~ '^[0-9]$' THEN
        RAISE EXCEPTION 'Single bets must be one digit (0-9)';
      END IF;
    ELSIF p_bet_type = 'jodi' THEN
      IF v_num !~ '^[0-9]{2}$' THEN
        RAISE EXCEPTION 'Jodi must be two digits (00-99)';
      END IF;
    ELSIF NOT public.is_valid_patti_combo(v_num) THEN
      RAISE EXCEPTION 'Invalid patti-digit combination: %', v_num;
    END IF;
    IF v_pts <> floor(v_pts) OR v_pts < 1 OR v_pts > v_max_bet THEN
      RAISE EXCEPTION 'Each bet must be a whole number from 1 to %', v_max_bet;
    END IF;
    IF v_num = ANY(v_existing_nums) OR v_num = ANY(v_seen) THEN
      CONTINUE;
    END IF;
    v_seen := array_append(v_seen, v_num);
    v_new := v_new || jsonb_build_array(
      jsonb_build_object('number', v_num, 'points', v_pts::int)
    );
    v_new_total := v_new_total + v_pts::int;
    v_new_count := v_new_count + 1;
  END LOOP;

  IF v_new_count = 0 THEN
    RAISE EXCEPTION 'No new numbers to add. Existing picks for this round are locked.';
  END IF;
  IF v_new_total > v_max_submit THEN
    RAISE EXCEPTION 'A single submit can total at most % points', v_max_submit;
  END IF;

  v_max_user_round_points := public.get_setting_int('max_user_round_points', 50000);
  SELECT COALESCE(SUM((item->>'points')::bigint), 0)
  INTO v_user_round_total
  FROM public.selections s
  CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
  WHERE s.user_id = v_uid
    AND s.game = p_game
    AND s.round_date = v_round;
  IF v_user_round_total + v_new_total > v_max_user_round_points THEN
    RAISE EXCEPTION
      'Round stake limit exceeded: existing % + new % points would exceed limit %',
      v_user_round_total, v_new_total, v_max_user_round_points;
  END IF;

  v_max_number_liability := public.get_setting_int('max_number_liability', 1000000);
  v_multiplier := CASE p_bet_type
    WHEN 'single_open' THEN 9
    WHEN 'single_close' THEN 9
    WHEN 'jodi' THEN 90
    ELSE 120
  END;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::bigint;
    SELECT COALESCE(SUM((entry.item->>'points')::bigint * v_multiplier), 0)
    INTO v_number_liability
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game
      AND s.bet_type = p_bet_type
      AND s.round_date = v_round
      AND entry.item->>'number' = v_num;

    IF v_number_liability + (v_pts::bigint * v_multiplier) > v_max_number_liability THEN
      RAISE EXCEPTION
        'Number liability limit exceeded for % (%): existing payout %, new payout %, limit %',
        p_bet_type, v_num, v_number_liability,
        v_pts::bigint * v_multiplier, v_max_number_liability;
    END IF;
  END LOOP;

  IF v_points + v_wallet < v_new_total THEN
    RAISE EXCEPTION
      'Insufficient balance. You have % (play: %, wallet: %), new picks cost %.',
      v_points + v_wallet, v_points, v_wallet, v_new_total;
  END IF;

  v_from_points := LEAST(v_points, v_new_total);
  v_from_wallet := v_new_total - v_from_points;

  UPDATE public.profiles
  SET points = points - v_from_points,
      wallet = wallet - v_from_wallet
  WHERE id = v_uid;

  INSERT INTO public.selections (
    user_id, game, bet_type, round_date, selections, total_points, updated_at
  )
  VALUES (
    v_uid, p_game, p_bet_type, v_round, v_existing || v_new,
    v_existing_total + v_new_total, now()
  )
  ON CONFLICT (user_id, game, bet_type, round_date)
  DO UPDATE SET
    selections = EXCLUDED.selections,
    total_points = EXCLUDED.total_points,
    updated_at = now();

  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (
    v_uid,
    -v_new_total,
    'selection_submit',
    jsonb_build_object(
      'game', p_game,
      'bet_type', p_bet_type,
      'round_date', v_round,
      'new_numbers', v_new_count,
      'from_points', v_from_points,
      'from_wallet', v_from_wallet
    )
  );

  RETURN jsonb_build_object(
    'points', v_points - v_from_points,
    'wallet', v_wallet - v_from_wallet,
    'new_points', v_new_total,
    'new_count', v_new_count,
    'total_numbers', jsonb_array_length(v_existing) + v_new_count,
    'round_date', v_round
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_exposure(
  p_game text,
  p_round_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exposure jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin only';
  END IF;
  IF p_game IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.game_schedule WHERE game = p_game
  ) THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;
  IF p_round_date IS NULL THEN
    RAISE EXCEPTION 'Round date is required';
  END IF;

  WITH number_stakes AS (
    SELECT
      s.bet_type,
      entry.item->>'number' AS number,
      SUM((entry.item->>'points')::bigint) AS total_stake
    FROM public.selections s
    CROSS JOIN LATERAL jsonb_array_elements(s.selections) AS entry(item)
    WHERE s.game = p_game
      AND s.round_date = p_round_date
    GROUP BY s.bet_type, entry.item->>'number'
  ),
  ranked AS (
    SELECT
      bet_type,
      number,
      total_stake,
      total_stake * CASE bet_type
        WHEN 'single_open' THEN 9
        WHEN 'single_close' THEN 9
        WHEN 'jodi' THEN 90
        WHEN 'patti_open' THEN 120
        WHEN 'patti_close' THEN 120
      END AS potential_payout,
      row_number() OVER (
        PARTITION BY bet_type
        ORDER BY
          total_stake * CASE bet_type
            WHEN 'single_open' THEN 9
            WHEN 'single_close' THEN 9
            WHEN 'jodi' THEN 90
            WHEN 'patti_open' THEN 120
            WHEN 'patti_close' THEN 120
          END DESC,
          number
      ) AS position
    FROM number_stakes
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'bet_type', bet_type,
        'number', number,
        'total_stake', total_stake,
        'potential_payout', potential_payout
      )
      ORDER BY bet_type, potential_payout DESC, number
    ),
    '[]'::jsonb
  )
  INTO v_exposure
  FROM ranked
  WHERE position <= 10;

  RETURN jsonb_build_object(
    'max_user_round_points', public.get_setting_int('max_user_round_points', 50000),
    'max_number_liability', public.get_setting_int('max_number_liability', 1000000),
    'exposure', v_exposure
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_get_exposure(text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_exposure(text, date)
  TO authenticated;
