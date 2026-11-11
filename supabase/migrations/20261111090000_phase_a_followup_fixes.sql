-- Follow-up fixes found while running the regression suite against a fresh database.
--
-- 1. get_my_bets: the game-validation guard used an unqualified `game` column,
--    which is ambiguous with the function's RETURNS TABLE(game ...) output column
--    and raised "column reference \"game\" is ambiguous" whenever p_game was given.
-- 2. apply_pending_user_limits is an internal helper (called only from other
--    SECURITY DEFINER functions); clients no longer need EXECUTE on it.

REVOKE EXECUTE ON FUNCTION public.apply_pending_user_limits(uuid) FROM PUBLIC, anon, authenticated;

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

-- 3. UPI validation used the repetition bound {2,256}. PostgreSQL's regex engine
--    rejects bounds above 255 ("invalid repetition count(s)"), so every
--    withdrawal request and every merchant UPI change raised an error. Use {2,255}.

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
  IF p_upi_id IS NULL OR trim(p_upi_id) !~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$' THEN
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
  IF p_key = 'merchant_upi_id' AND v_value !~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$' THEN
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

-- 4. A6 follow-up. Per-schema default-privilege REVOKEs cannot remove the
--    built-in *global* default that grants EXECUTE on new functions to PUBLIC
--    (PostgreSQL docs, ALTER DEFAULT PRIVILEGES: per-schema REVOKE only undoes a
--    per-schema GRANT). Without this, anon could still execute a newly created
--    public function through PUBLIC. Revoke the global default for the roles
--    that create functions. Assumption (recorded in CHANGELOG): functions those
--    roles create in any schema now need an explicit GRANT to be callable.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Skipping supabase_admin global default privileges: insufficient privilege';
    END;
  END IF;
END;
$$;
