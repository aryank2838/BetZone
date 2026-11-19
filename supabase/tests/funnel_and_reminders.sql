-- Run against a disposable local Supabase database after `supabase db reset`.
-- Checks admin_signup_funnel() and the "your match starts soon" reminders.
-- This transaction creates fixtures and rolls all changes back.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES
  ('00000000-0000-4000-8000-000000000401', 'authenticated', 'authenticated', 'fr-admin@example.invalid', '', now(), '{}', '{"display_name":"FR admin","accepted_terms":true,"terms_version":"test"}');
UPDATE public.profiles SET is_admin = true WHERE id = '00000000-0000-4000-8000-000000000401';

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000401';
  v_a uuid := '00000000-0000-4000-8000-000000000402';  -- deposits, bets, verifies, withdraws
  v_b uuid := '00000000-0000-4000-8000-000000000403';  -- asks to add money only
  v_c uuid := '00000000-0000-4000-8000-000000000404';  -- signs up only
  v_old uuid := '00000000-0000-4000-8000-000000000405'; -- signed up 40 days ago
  v_before jsonb;
  v_after jsonb;
  v_soon uuid;
  v_later uuid;
  v_started uuid;
  v_queued integer;
  v_rows integer;
  v_row record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Funnel ------------------------------------------------------------------
  v_before := public.admin_signup_funnel(7);

  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_a, 'authenticated', 'authenticated', 'fr-a@example.invalid', '', now(), '{}', '{"display_name":"FR A","accepted_terms":true,"terms_version":"test"}'),
    (v_b, 'authenticated', 'authenticated', 'fr-b@example.invalid', '', now(), '{}', '{"display_name":"FR B","accepted_terms":true,"terms_version":"test"}'),
    (v_c, 'authenticated', 'authenticated', 'fr-c@example.invalid', '', now(), '{}', '{"display_name":"FR C","accepted_terms":true,"terms_version":"test"}'),
    (v_old, 'authenticated', 'authenticated', 'fr-old@example.invalid', '', now(), '{}', '{"display_name":"FR old","accepted_terms":true,"terms_version":"test"}');
  UPDATE public.profiles SET created_at = now() - interval '40 days' WHERE id = v_old;

  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_a, 500, 'approved', 'FRFUNNEL00001'), (v_b, 200, 'pending', 'FRFUNNEL00002'),
         (v_old, 300, 'approved', 'FRFUNNEL00003');
  UPDATE public.profiles SET email_verified_at = now() WHERE id IN (v_a, v_old);
  INSERT INTO public.withdrawals (user_id, amount, status, upi_id) VALUES (v_a, 100, 'pending', 'fr-a@bank');

  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('football', 'test', 'fr-soon', 'PL', 'Premier League', 'Arsenal', 'Chelsea', now() + interval '20 minutes', 10)
  RETURNING id INTO v_soon;
  INSERT INTO public.sport_bets (event_id, user_id, side, amount, from_points, from_wallet)
  VALUES (v_soon, v_a, 'yes', 150, 150, 0), (v_soon, v_a, 'no', 50, 50, 0);

  v_after := public.admin_signup_funnel(7);
  IF (v_after->>'signed_up')::int - (v_before->>'signed_up')::int <> 3
     OR (v_after->>'requested_deposit')::int - (v_before->>'requested_deposit')::int <> 2
     OR (v_after->>'deposit_approved')::int - (v_before->>'deposit_approved')::int <> 1
     OR (v_after->>'placed_bet')::int - (v_before->>'placed_bet')::int <> 1
     OR (v_after->>'verified_email')::int - (v_before->>'verified_email')::int <> 1
     OR (v_after->>'requested_withdrawal')::int - (v_before->>'requested_withdrawal')::int <> 1 THEN
    RAISE EXCEPTION 'unexpected 7-day funnel: before %, after %', v_before, v_after;
  END IF;
  -- The 40-day-old player counts in "all time" but not in 7 days; the admin never counts.
  IF (public.admin_signup_funnel(NULL)->>'signed_up')::int < (v_after->>'signed_up')::int + 1 THEN
    RAISE EXCEPTION 'all-time funnel left out the older player';
  END IF;

  -- Only admins.
  PERFORM set_config('request.jwt.claim.sub', v_c::text, true);
  BEGIN
    PERFORM public.admin_signup_funnel(7);
    RAISE EXCEPTION 'a player could read the funnel';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Admin only' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Match reminders -----------------------------------------------------------
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent)
  VALUES ('cricket', 'test', 'fr-later', 'IPL', 'IPL', 'Mumbai', 'Chennai', now() + interval '2 hours', 10)
  RETURNING id INTO v_later;
  INSERT INTO public.sport_events (sport, provider, provider_event_id, competition, competition_name,
    home_team, away_team, starts_at, fee_percent, reminder_sent_at)
  VALUES ('football', 'test', 'fr-started', 'PL', 'Premier League', 'Leeds', 'Spurs', now() - interval '10 minutes', 10, NULL)
  RETURNING id INTO v_started;
  INSERT INTO public.sport_bets (event_id, user_id, side, amount, from_points, from_wallet)
  VALUES (v_later, v_a, 'yes', 70, 70, 0),
         (v_soon, v_b, 'yes', 90, 90, 0),      -- v_b has notifications off
         (v_started, v_a, 'yes', 40, 40, 0);

  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
  VALUES (v_a, 'https://push.example.invalid/fr-a', repeat('A', 87), repeat('B', 22));

  v_queued := public.push_enqueue_match_reminders();

  SELECT count(*) INTO v_rows FROM public.push_outbox WHERE kind = 'match_starting' AND user_id IN (v_a, v_b);
  SELECT * INTO v_row FROM public.push_outbox WHERE kind = 'match_starting' AND user_id = v_a;
  IF v_rows <> 1 OR v_row.amount <> 200 OR v_row.reason <> 'Arsenal vs Chelsea' THEN
    RAISE EXCEPTION 'unexpected reminders: % rows, amount %, reason %', v_rows, v_row.amount, v_row.reason;
  END IF;
  IF (SELECT reminder_sent_at FROM public.sport_events WHERE id = v_soon) IS NULL
     OR (SELECT reminder_sent_at FROM public.sport_events WHERE id = v_later) IS NOT NULL
     OR (SELECT reminder_sent_at FROM public.sport_events WHERE id = v_started) IS NOT NULL THEN
    RAISE EXCEPTION 'reminder_sent_at marked the wrong matches';
  END IF;

  -- Each match is reminded once.
  PERFORM public.push_enqueue_match_reminders();
  SELECT count(*) INTO v_rows FROM public.push_outbox WHERE kind = 'match_starting' AND user_id = v_a;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'a match was reminded twice';
  END IF;

  RAISE NOTICE 'funnel and match reminder tests passed (% queued)', v_queued;
END;
$test$;

ROLLBACK;
