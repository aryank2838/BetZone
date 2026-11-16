-- Run against a disposable local Supabase database after `supabase db reset`.
-- Checks admin_bets_board(): per-number won/lost/pending and payouts, using
-- the open result for open bets while jodi and close bets wait. Rolls back.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES
  ('00000000-0000-4000-8000-000000000401', 'authenticated', 'authenticated', 'bb-admin@example.invalid', '', now(), '{}', '{"display_name":"BB admin","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000402', 'authenticated', 'authenticated', 'bb-user@example.invalid', '', now(), '{}', '{"display_name":"BB player","accepted_terms":true,"terms_version":"test"}');
UPDATE public.profiles SET is_admin = true WHERE id = '00000000-0000-4000-8000-000000000401';

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000401';
  v_user uuid := '00000000-0000-4000-8000-000000000402';
  v_round date := date '2000-01-05';
  v_board jsonb;
  v_slip jsonb;
  v_error text;
BEGIN
  INSERT INTO public.selections (user_id, game, bet_type, round_date, selections, total_points)
  VALUES
    (v_user, 'test', 'single_open', v_round, '[{"number":"1","points":10},{"number":"2","points":5}]', 15),
    (v_user, 'test', 'patti_open', v_round, '[{"number":"128-1","points":2}]', 2),
    (v_user, 'test', 'jodi', v_round, '[{"number":"14","points":3}]', 3);
  INSERT INTO public.winning_results (game, round_date, open_patti, open_digit, open_posted_at, open_processed_at)
  VALUES ('test', v_round, '128', '1', now(), now());

  -- Players cannot call it.
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_bets_board('test', v_round);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT; END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Only the admin%' THEN
    RAISE EXCEPTION 'a player could read the bets board: %', v_error;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_board := public.admin_bets_board('test', v_round);
  IF (v_board->'result'->>'open_paid')::boolean IS NOT TRUE
     OR (v_board->'result'->>'close_paid')::boolean IS NOT FALSE
     OR jsonb_array_length(v_board->'slips') <> 3 THEN
    RAISE EXCEPTION 'board result or slip count is wrong: %', v_board;
  END IF;

  SELECT s INTO v_slip FROM jsonb_array_elements(v_board->'slips') s WHERE s->>'bet_type' = 'single_open';
  IF v_slip->'picks'->0->>'status' <> 'won' OR (v_slip->'picks'->0->>'payout')::integer <> 90
     OR v_slip->'picks'->1->>'status' <> 'lost' OR (v_slip->'picks'->1->>'payout')::integer <> 0
     OR v_slip->>'user_name' <> 'BB player' THEN
    RAISE EXCEPTION 'single open picks are wrong: %', v_slip;
  END IF;

  SELECT s INTO v_slip FROM jsonb_array_elements(v_board->'slips') s WHERE s->>'bet_type' = 'patti_open';
  IF v_slip->'picks'->0->>'status' <> 'won' OR (v_slip->'picks'->0->>'payout')::integer <> 240 THEN
    RAISE EXCEPTION 'open patti pick is wrong: %', v_slip;
  END IF;

  SELECT s INTO v_slip FROM jsonb_array_elements(v_board->'slips') s WHERE s->>'bet_type' = 'jodi';
  IF v_slip->'picks'->0->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'jodi should wait for the close result: %', v_slip;
  END IF;

  RAISE NOTICE 'admin bets board assertions passed';
END
$test$;

ROLLBACK;
