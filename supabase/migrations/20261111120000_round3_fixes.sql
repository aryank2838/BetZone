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
    p_game, p_round_date, 'single_open', v_digit, 9
  );
  v_b := public.settle_bets(
    p_game, p_round_date, 'patti_open', v_patti || '-' || v_digit, 120
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
    p_game, p_round_date, 'single_close', v_digit, 9
  );
  v_b := public.settle_bets(
    p_game, p_round_date, 'patti_close', v_patti || '-' || v_digit, 120
  );
  v_c := public.settle_bets(
    p_game, p_round_date, 'jodi', v_open_digit || v_digit, 90
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
