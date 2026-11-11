CREATE OR REPLACE FUNCTION settle_bets(
  p_game text,
  p_round date,
  p_bet_type text,
  p_winning text,
  p_multiplier integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec record;
  v_item jsonb;
  v_bet integer;
  v_payout integer;
  v_winners integer := 0;
  v_paid integer := 0;
BEGIN
  FOR v_rec IN
    SELECT user_id, selections
    FROM selections
    WHERE game = p_game
      AND bet_type = p_bet_type
      AND round_date = p_round
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_rec.selections) LOOP
      IF v_item->>'number' = p_winning THEN
        v_bet := (v_item->>'points')::int;
        v_payout := v_bet * p_multiplier;
        UPDATE profiles
        SET wallet = wallet + v_payout
        WHERE id = v_rec.user_id;
        INSERT INTO point_ledger (user_id, delta, reason, metadata)
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
END
$$;

REVOKE EXECUTE ON FUNCTION settle_bets(text, date, text, text, integer)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION process_open_payouts(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_digit text;
  v_patti text;
  v_done timestamptz;
  v_a jsonb;
  v_b jsonb;
BEGIN
  SELECT open_digit, open_patti, open_processed_at
  INTO v_digit, v_patti, v_done
  FROM winning_results
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_digit IS NULL OR v_patti IS NULL THEN
    RAISE EXCEPTION 'No open result posted for this round';
  END IF;
  IF v_done IS NOT NULL THEN
    RAISE EXCEPTION 'Open result for this round was already paid';
  END IF;

  v_a := settle_bets(p_game, p_round_date, 'single_open', v_digit, 9);
  v_b := settle_bets(p_game, p_round_date, 'patti_open', v_patti || '-' || v_digit, 120);

  UPDATE winning_results
  SET open_processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'phase', 'open',
    'winners', (v_a->>'winners')::int + (v_b->>'winners')::int,
    'total_paid', (v_a->>'paid')::int + (v_b->>'paid')::int
  );
END
$$;

CREATE OR REPLACE FUNCTION process_close_payouts(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  SELECT open_digit, open_processed_at, close_digit, close_patti, close_processed_at
  INTO v_open_digit, v_open_done, v_digit, v_patti, v_done
  FROM winning_results
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

  v_a := settle_bets(p_game, p_round_date, 'single_close', v_digit, 9);
  v_b := settle_bets(p_game, p_round_date, 'patti_close', v_patti || '-' || v_digit, 120);
  v_c := settle_bets(p_game, p_round_date, 'jodi', v_open_digit || v_digit, 90);

  UPDATE winning_results
  SET close_processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'phase', 'close',
    'winners', (v_a->>'winners')::int + (v_b->>'winners')::int + (v_c->>'winners')::int,
    'total_paid', (v_a->>'paid')::int + (v_b->>'paid')::int + (v_c->>'paid')::int
  );
END
$$;

REVOKE EXECUTE ON FUNCTION process_open_payouts(text, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION process_close_payouts(text, date) FROM PUBLIC, anon, authenticated;
