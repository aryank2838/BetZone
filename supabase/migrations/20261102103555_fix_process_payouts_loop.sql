/*
# Fix payout processing loop

## Purpose
Corrects the internal loop used when processing winning numbers. The previous
version attempted to assign two selected columns into one JSON value, which can
fail when the admin posts a result.

## Changes
- Replaces the payout scan loop with separate `user_id` and `selections`
  variables.
- No table, column, balance, or policy changes.
- Payout behavior remains 90 times the matching bet and remains idempotent.
*/

CREATE OR REPLACE FUNCTION process_payouts(p_game text, p_round_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winning_number text;
  v_winners_count integer := 0;
  v_total_paid integer := 0;
  v_user_id uuid;
  v_selections jsonb;
  v_sel_row jsonb;
  v_bet integer;
  v_payout integer;
  v_processed timestamptz;
BEGIN
  SELECT number, processed_at INTO v_winning_number, v_processed
  FROM winning_numbers
  WHERE game = p_game AND round_date = p_round_date
  FOR UPDATE;

  IF v_winning_number IS NULL THEN
    RAISE EXCEPTION 'No winning number posted for this game/date';
  END IF;

  IF v_processed IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_processed', 'winners', 0, 'total_paid', 0);
  END IF;

  FOR v_user_id, v_selections IN
    SELECT user_id, selections
    FROM selections
    WHERE game = p_game
  LOOP
    FOR v_sel_row IN SELECT * FROM jsonb_array_elements(v_selections) LOOP
      IF v_sel_row->>'number' = v_winning_number THEN
        v_bet := (v_sel_row->>'points')::int;
        v_payout := v_bet * 90;

        UPDATE profiles
        SET wallet = wallet + v_payout
        WHERE id = v_user_id;

        INSERT INTO point_ledger (user_id, delta, reason, metadata)
        VALUES (
          v_user_id, v_payout, 'winning_payout',
          jsonb_build_object('game', p_game, 'number', v_winning_number, 'bet', v_bet, 'multiplier', 90, 'round_date', p_round_date)
        );

        v_winners_count := v_winners_count + 1;
        v_total_paid := v_total_paid + v_payout;
      END IF;
    END LOOP;
  END LOOP;

  UPDATE winning_numbers
  SET processed_at = now()
  WHERE game = p_game AND round_date = p_round_date;

  RETURN jsonb_build_object(
    'status', 'processed',
    'winners', v_winners_count,
    'total_paid', v_total_paid,
    'winning_number', v_winning_number
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION process_payouts(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION process_payouts(text, date) TO authenticated;
