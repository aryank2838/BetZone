-- Run against a disposable local Supabase database after `supabase db reset`.
-- Checks the sports pool engine: bets, payouts, fee, refunds, closing at the
-- start time, and the automatic sync. Rolls everything back.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES
  ('00000000-0000-4000-8000-000000000301', 'authenticated', 'authenticated', 'sp-admin@example.invalid', '', now(), '{}', '{"display_name":"SP admin","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000302', 'authenticated', 'authenticated', 'sp-u1@example.invalid', '', now(), '{}', '{"display_name":"SP u1","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000303', 'authenticated', 'authenticated', 'sp-u2@example.invalid', '', now(), '{}', '{"display_name":"SP u2","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000304', 'authenticated', 'authenticated', 'sp-u3@example.invalid', '', now(), '{}', '{"display_name":"SP u3","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000305', 'authenticated', 'authenticated', 'sp-u4@example.invalid', '', now(), '{}', '{"display_name":"SP u4","accepted_terms":true,"terms_version":"test"}');

UPDATE public.profiles SET is_admin = (id = '00000000-0000-4000-8000-000000000301'),
  points = 0, wallet = 0, is_banned = false
WHERE id::text LIKE '00000000-0000-4000-8000-0000000003%';
-- u1 has 100 play + 1000 wallet so its bet is split across both balances.
UPDATE public.profiles SET points = 100, wallet = 1000 WHERE id = '00000000-0000-4000-8000-000000000302';
UPDATE public.profiles SET points = 1000 WHERE id IN (
  '00000000-0000-4000-8000-000000000303',
  '00000000-0000-4000-8000-000000000304',
  '00000000-0000-4000-8000-000000000305');
-- House money off for the first part; the house money section turns it on.
UPDATE public.sport_settings SET football_enabled = true, fee_percent = 10, min_bet = 10, max_bet = 500,
  house_seed = 0 WHERE id = 1;

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000301';
  v_u1 uuid := '00000000-0000-4000-8000-000000000302';
  v_u2 uuid := '00000000-0000-4000-8000-000000000303';
  v_u3 uuid := '00000000-0000-4000-8000-000000000304';
  v_u4 uuid := '00000000-0000-4000-8000-000000000305';
  v_ev1 uuid;
  v_ev2 uuid;
  v_ev3 uuid;
  v_h1 uuid;
  v_h2 uuid;
  v_h3 uuid;
  v_u2_wallet integer;
  v_u3_wallet integer;
  v_result jsonb;
  v_error text;
  v_points integer;
  v_wallet integer;
  v_state text;
BEGIN
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('football', 'test', 'ev1', 'PL', 'Premier League', 'Home FC', 'Away FC', now() + interval '1 day', 10)
  RETURNING id INTO v_ev1;
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('football', 'test', 'ev2', 'PL', 'Premier League', 'Lonely FC', 'Nobody FC', now() + interval '1 day', 10)
  RETURNING id INTO v_ev2;

  -- Admins cannot bet.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.place_sport_bet(v_ev1, 'yes', 100);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT; END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Admin accounts cannot%' THEN
    RAISE EXCEPTION 'admin was allowed to bet: %', v_error;
  END IF;

  -- Bet limits.
  PERFORM set_config('request.jwt.claim.sub', v_u2::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.place_sport_bet(v_ev1, 'yes', 5);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT; END;
  IF v_error IS NULL OR v_error NOT ILIKE '%from 10 to 500%' THEN
    RAISE EXCEPTION 'bet under the minimum was accepted: %', v_error;
  END IF;

  -- Pools: Yes 300 (u1) + 400 (u2) = 700, No 100 (u3) + 200 (u4) = 300.
  PERFORM set_config('request.jwt.claim.sub', v_u1::text, true);
  PERFORM public.place_sport_bet(v_ev1, 'yes', 300);
  SELECT points, wallet INTO v_points, v_wallet FROM public.profiles WHERE id = v_u1;
  IF v_points <> 0 OR v_wallet <> 800 THEN
    RAISE EXCEPTION 'bet was not taken from play balance first: points %, wallet %', v_points, v_wallet;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_u2::text, true);
  PERFORM public.place_sport_bet(v_ev1, 'yes', 400);
  v_error := NULL;
  BEGIN
    PERFORM public.place_sport_bet(v_ev1, 'no', 200);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT; END;
  IF v_error IS NULL OR v_error NOT ILIKE '%at most 500 on one match%' THEN
    RAISE EXCEPTION 'per-match maximum was not enforced: %', v_error;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_u3::text, true);
  PERFORM public.place_sport_bet(v_ev1, 'no', 100);
  PERFORM set_config('request.jwt.claim.sub', v_u4::text, true);
  PERFORM public.place_sport_bet(v_ev1, 'no', 200);
  -- Only u4 bets on match 2, so it must be refunded.
  PERFORM public.place_sport_bet(v_ev2, 'yes', 50);

  IF (SELECT yes_total FROM public.sport_events WHERE id = v_ev1) <> 700
     OR (SELECT no_total FROM public.sport_events WHERE id = v_ev1) <> 300 THEN
    RAISE EXCEPTION 'pool totals are wrong';
  END IF;

  -- Betting closes at the start time.
  UPDATE public.sport_events SET starts_at = now() - interval '2 hours' WHERE id IN (v_ev1, v_ev2);
  v_error := NULL;
  BEGIN
    PERFORM public.place_sport_bet(v_ev1, 'no', 50);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT; END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Betting is closed%' THEN
    RAISE EXCEPTION 'bet after the start time was accepted: %', v_error;
  END IF;

  -- Yes wins. Fee 10% of 300 = 30, 270 shared: u1 300 + 115 = 415, u2 400 + 154 = 554.
  v_result := public.sport_settle_internal(v_ev1, 'yes');
  IF (SELECT wallet FROM public.profiles WHERE id = v_u1) <> 800 + 415
     OR (SELECT wallet FROM public.profiles WHERE id = v_u2) <> 554
     OR (SELECT wallet FROM public.profiles WHERE id = v_u3) <> 0
     OR (SELECT fee_taken FROM public.sport_events WHERE id = v_ev1) <> 31
     OR (SELECT state FROM public.sport_events WHERE id = v_ev1) <> 'settled' THEN
    RAISE EXCEPTION 'payouts or fee are wrong: %', v_result;
  END IF;
  IF (SELECT count(*) FROM public.sport_bets WHERE event_id = v_ev1 AND status = 'won') <> 2
     OR (SELECT count(*) FROM public.sport_bets WHERE event_id = v_ev1 AND status = 'lost') <> 2 THEN
    RAISE EXCEPTION 'bet statuses are wrong after settlement';
  END IF;
  -- Settling twice does nothing.
  v_result := public.sport_settle_internal(v_ev1, 'no');
  IF (SELECT wallet FROM public.profiles WHERE id = v_u3) <> 0 THEN
    RAISE EXCEPTION 'a settled match was paid out again';
  END IF;

  -- One-sided pool: refunded to the play balance it came from, not the wallet.
  SELECT points, wallet INTO v_points, v_wallet FROM public.profiles WHERE id = v_u4;
  v_result := public.sport_settle_internal(v_ev2, 'yes');
  IF v_result->>'state' <> 'void' OR v_result->>'reason' <> 'one_sided'
     OR (SELECT points FROM public.profiles WHERE id = v_u4) <> v_points + 50
     OR (SELECT wallet FROM public.profiles WHERE id = v_u4) <> v_wallet THEN
    RAISE EXCEPTION 'one-sided pool was not refunded to the original balance: %', v_result;
  END IF;

  -- Refunds are not counted as spent.
  PERFORM set_config('request.jwt.claim.sub', v_u4::text, true);
  IF (public.get_balance_breakdown()->>'selections_spent')::integer <> 200 THEN
    RAISE EXCEPTION 'refunded stake counted as spent: %', public.get_balance_breakdown();
  END IF;

  -- Daily report shows football with the fee as revenue.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.admin_daily_report((now() AT TIME ZONE 'Asia/Kolkata')::date);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) r
    WHERE r->>'game' = 'football'
      AND (r->>'total_staked')::integer = 1000
      AND (r->>'gaming_revenue')::integer = 31
  ) THEN
    RAISE EXCEPTION 'daily report does not show football correctly: %', v_result;
  END IF;

  -- Sync: new match imported, result waits 30 minutes, then pays out.
  v_result := public.sports_sync_upsert(jsonb_build_array(jsonb_build_object(
    'provider', 'test', 'provider_event_id', 'ev3', 'sport', 'football',
    'competition', 'PL', 'competition_name', 'Premier League',
    'home_team', 'Sync Home', 'away_team', 'Sync Away', 'subject_side', 'home',
    'starts_at', now() + interval '1 day', 'status', 'scheduled',
    'home_score', NULL, 'away_score', NULL, 'winner', NULL)));
  SELECT id INTO v_ev3 FROM public.sport_events WHERE provider = 'test' AND provider_event_id = 'ev3';
  IF v_ev3 IS NULL OR (v_result->>'inserted')::integer <> 1 THEN
    RAISE EXCEPTION 'sync did not import the match: %', v_result;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_u2::text, true);
  PERFORM public.place_sport_bet(v_ev3, 'no', 100);
  PERFORM set_config('request.jwt.claim.sub', v_u3::text, true);
  PERFORM public.place_sport_bet(v_ev3, 'yes', 100);
  UPDATE public.sport_events SET starts_at = now() - interval '3 hours' WHERE id = v_ev3;

  v_result := public.sports_sync_upsert(jsonb_build_array(jsonb_build_object(
    'provider', 'test', 'provider_event_id', 'ev3', 'sport', 'football',
    'competition', 'PL', 'competition_name', 'Premier League',
    'home_team', 'Sync Home', 'away_team', 'Sync Away', 'subject_side', 'home',
    'starts_at', now() - interval '3 hours', 'status', 'finished',
    'home_score', '0', 'away_score', '1', 'winner', 'away')));
  IF (SELECT state FROM public.sport_events WHERE id = v_ev3) <> 'closed' THEN
    RAISE EXCEPTION 'first sight of a result paid out immediately';
  END IF;
  UPDATE public.sport_events SET result_seen_at = now() - interval '31 minutes' WHERE id = v_ev3;
  v_result := public.sports_sync_upsert(jsonb_build_array(jsonb_build_object(
    'provider', 'test', 'provider_event_id', 'ev3', 'sport', 'football',
    'competition', 'PL', 'competition_name', 'Premier League',
    'home_team', 'Sync Home', 'away_team', 'Sync Away', 'subject_side', 'home',
    'starts_at', now() - interval '3 hours', 'status', 'finished',
    'home_score', '0', 'away_score', '1', 'winner', 'away')));
  SELECT state INTO v_state FROM public.sport_events WHERE id = v_ev3;
  IF v_state <> 'settled' OR (SELECT outcome FROM public.sport_events WHERE id = v_ev3) <> 'no' THEN
    RAISE EXCEPTION 'stable result was not paid out (state %): %', v_state, v_result;
  END IF;

  -- Sync: a cancelled match is refunded.
  PERFORM public.sports_sync_upsert(jsonb_build_array(jsonb_build_object(
    'provider', 'test', 'provider_event_id', 'ev4', 'sport', 'football',
    'competition', 'PL', 'competition_name', 'Premier League',
    'home_team', 'Rain FC', 'away_team', 'Storm FC', 'subject_side', 'home',
    'starts_at', now() + interval '1 day', 'status', 'scheduled',
    'home_score', NULL, 'away_score', NULL, 'winner', NULL)));
  PERFORM public.place_sport_bet(
    (SELECT id FROM public.sport_events WHERE provider = 'test' AND provider_event_id = 'ev4'), 'yes', 60);
  PERFORM public.sports_sync_upsert(jsonb_build_array(jsonb_build_object(
    'provider', 'test', 'provider_event_id', 'ev4', 'sport', 'football',
    'competition', 'PL', 'competition_name', 'Premier League',
    'home_team', 'Rain FC', 'away_team', 'Storm FC', 'subject_side', 'home',
    'starts_at', now() + interval '1 day', 'status', 'cancelled',
    'home_score', NULL, 'away_score', NULL, 'winner', NULL)));
  IF (SELECT state FROM public.sport_events WHERE provider = 'test' AND provider_event_id = 'ev4') <> 'void'
     OR NOT EXISTS (SELECT 1 FROM public.point_ledger WHERE user_id = v_u3 AND reason = 'bet_refund' AND delta = 60) THEN
    RAISE EXCEPTION 'cancelled match was not refunded';
  END IF;

  -- House money: 50 on each side, at most 2 matches a day.
  UPDATE public.sport_settings SET house_seed = 50, house_seed_daily_matches = 2 WHERE id = 1;
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('football', 'test', 'h1', 'PL', 'Premier League', 'Fav FC', 'Under FC', now() + interval '1 day', 10)
  RETURNING id INTO v_h1;
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('football', 'test', 'h2', 'PL', 'Premier League', 'Crowd FC', 'Upset FC', now() + interval '1 day', 10)
  RETURNING id INTO v_h2;
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('football', 'test', 'h3', 'PL', 'Premier League', 'Late FC', 'Budget FC', now() + interval '1 day', 10)
  RETURNING id INTO v_h3;

  -- Before any bet the player list says the next match gets 50.
  PERFORM set_config('request.jwt.claim.sub', v_u2::text, true);
  IF (public.get_sport_events('football')->>'house_seed')::integer <> 50 THEN
    RAISE EXCEPTION 'player list does not show the coming house money';
  END IF;

  -- First bet on h1 brings in the house money; the second does not add more.
  PERFORM public.place_sport_bet(v_h1, 'yes', 100);
  PERFORM set_config('request.jwt.claim.sub', v_u3::text, true);
  PERFORM public.place_sport_bet(v_h1, 'yes', 100);
  IF (SELECT yes_total FROM public.sport_events WHERE id = v_h1) <> 250
     OR (SELECT no_total FROM public.sport_events WHERE id = v_h1) <> 50
     OR (SELECT house_yes FROM public.sport_events WHERE id = v_h1) <> 50
     OR (SELECT house_no FROM public.sport_events WHERE id = v_h1) <> 50
     OR (SELECT house_seeded_at FROM public.sport_events WHERE id = v_h1) IS NULL THEN
    RAISE EXCEPTION 'house money was not added once to both sides: %',
      (SELECT to_jsonb(e) FROM public.sport_events e WHERE id = v_h1);
  END IF;

  -- h2 is the second match today and gets house money; h3 is over the budget.
  PERFORM set_config('request.jwt.claim.sub', v_u2::text, true);
  PERFORM public.place_sport_bet(v_h2, 'yes', 100);
  PERFORM set_config('request.jwt.claim.sub', v_u3::text, true);
  PERFORM public.place_sport_bet(v_h3, 'yes', 100);
  IF (SELECT house_yes FROM public.sport_events WHERE id = v_h2) <> 50
     OR (SELECT house_yes + house_no FROM public.sport_events WHERE id = v_h3) <> 0
     OR (SELECT house_seeded_at FROM public.sport_events WHERE id = v_h3) IS NOT NULL THEN
    RAISE EXCEPTION 'daily house money limit was not applied';
  END IF;
  IF (public.get_sport_events('football')->>'house_seed')::integer <> 0 THEN
    RAISE EXCEPTION 'player list still offers house money after the daily limit';
  END IF;

  -- h1: Yes wins and only the house was on No. Fee 5 of 50, 45 shared over Yes 250:
  -- each player gets 100 + 18 = 118, so the house loses 36.
  SELECT wallet INTO v_u2_wallet FROM public.profiles WHERE id = v_u2;
  SELECT wallet INTO v_u3_wallet FROM public.profiles WHERE id = v_u3;
  v_result := public.sport_settle_internal(v_h1, 'yes');
  IF v_result->>'state' <> 'settled'
     OR (SELECT wallet FROM public.profiles WHERE id = v_u2) <> v_u2_wallet + 118
     OR (SELECT wallet FROM public.profiles WHERE id = v_u3) <> v_u3_wallet + 118
     OR (SELECT house_net FROM public.sport_events WHERE id = v_h1) <> -36 THEN
    RAISE EXCEPTION 'house money match paid out wrongly: %', v_result;
  END IF;

  -- h2: No wins, only the house was on No. The player loses 100 and nobody is paid.
  SELECT wallet INTO v_u2_wallet FROM public.profiles WHERE id = v_u2;
  v_result := public.sport_settle_internal(v_h2, 'no');
  IF v_result->>'state' <> 'settled'
     OR (SELECT wallet FROM public.profiles WHERE id = v_u2) <> v_u2_wallet
     OR (SELECT house_net FROM public.sport_events WHERE id = v_h2) <> 100
     OR EXISTS (SELECT 1 FROM public.sport_bets WHERE event_id = v_h2 AND status <> 'lost') THEN
    RAISE EXCEPTION 'house winning match is wrong: %', v_result;
  END IF;

  -- h3 had no house money, so it is still refunded as one-sided.
  v_result := public.sport_settle_internal(v_h3, 'yes');
  IF v_result->>'reason' <> 'one_sided'
     OR (SELECT house_net FROM public.sport_events WHERE id = v_h3) <> 0 THEN
    RAISE EXCEPTION 'match without house money was not refunded: %', v_result;
  END IF;

  -- Admin summary covers only matches with house money: -36 + 100 = 64.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.admin_get_sports()->'house';
  IF (v_result->>'net')::integer <> 64
     OR (v_result->>'matches_won')::integer <> 1
     OR (v_result->>'matches_lost')::integer <> 1
     OR (v_result->>'seeded_today')::integer <> 2 THEN
    RAISE EXCEPTION 'admin house money summary is wrong: %', v_result;
  END IF;

  -- The daily report agrees: 31 (ev1) + 10 (ev3) - 36 (h1) + 100 (h2) = 105.
  v_result := public.admin_daily_report((now() AT TIME ZONE 'Asia/Kolkata')::date);
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) r
    WHERE r->>'game' = 'football' AND (r->>'gaming_revenue')::integer = 105
  ) THEN
    RAISE EXCEPTION 'daily report does not include the house money result: %', v_result;
  END IF;

  -- Settings are validated.
  v_error := NULL;
  BEGIN
    PERFORM public.admin_set_sport_settings('{"house_seed": -1}'::jsonb);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT; END;
  IF v_error IS NULL OR v_error NOT ILIKE '%House money per side%' THEN
    RAISE EXCEPTION 'negative house money was accepted: %', v_error;
  END IF;

  -- Clients cannot call the automation or the internal settlement.
  IF has_function_privilege('authenticated', 'public.sports_sync_upsert(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sport_settle_internal(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sport_house_seeded_today()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.sport_bets', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sport_events', 'UPDATE') THEN
    RAISE EXCEPTION 'clients can reach sports internals';
  END IF;

  RAISE NOTICE 'sports pool assertions passed';
END
$test$;

ROLLBACK;
