-- Run against a disposable local Supabase database after `supabase db reset`.
-- Checks "sign up now, verify the email once before the first withdrawal".
-- This transaction creates Auth fixtures and rolls all changes back.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, last_sign_in_at
)
VALUES
  ('00000000-0000-4000-8000-000000000301', 'authenticated', 'authenticated', 'ev-admin@example.invalid', '', now(), '{}', '{"display_name":"EV admin","accepted_terms":true,"terms_version":"test"}', now(), now()),
  ('00000000-0000-4000-8000-000000000302', 'authenticated', 'authenticated', 'ev-player@example.invalid', '', now(), '{}', '{"display_name":"EV player","accepted_terms":true,"terms_version":"test"}', now(), now()),
  ('00000000-0000-4000-8000-000000000303', 'authenticated', 'authenticated', 'ev-other@example.invalid', '', now(), '{}', '{"display_name":"EV other","accepted_terms":true,"terms_version":"test"}', now(), now()),
  -- Clean-up fixtures: old and idle, old but verified, old but recently active.
  ('00000000-0000-4000-8000-000000000304', 'authenticated', 'authenticated', 'ev-stale@example.invalid', '', now(), '{}', '{"display_name":"EV stale","accepted_terms":true,"terms_version":"test"}', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-4000-8000-000000000305', 'authenticated', 'authenticated', 'ev-old-verified@example.invalid', '', now(), '{}', '{"display_name":"EV old verified","accepted_terms":true,"terms_version":"test"}', now() - interval '40 days', now() - interval '40 days'),
  ('00000000-0000-4000-8000-000000000306', 'authenticated', 'authenticated', 'ev-old-active@example.invalid', '', now(), '{}', '{"display_name":"EV old active","accepted_terms":true,"terms_version":"test"}', now() - interval '40 days', now() - interval '2 days');

UPDATE public.profiles SET is_admin = true
WHERE id = '00000000-0000-4000-8000-000000000301';
UPDATE public.profiles SET email_verified_at = now() - interval '35 days'
WHERE id = '00000000-0000-4000-8000-000000000305';

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000301';
  v_player uuid := '00000000-0000-4000-8000-000000000302';
  v_other uuid := '00000000-0000-4000-8000-000000000303';
  v_error text;
  v_result jsonb;
  v_count integer;
BEGIN
  -- A new sign-up (email auto-confirmed by Supabase) starts unverified.
  IF (SELECT email_verified_at FROM public.profiles WHERE id = v_player) IS NOT NULL THEN
    RAISE EXCEPTION 'a new sign-up started with a verified email';
  END IF;

  -- Withdrawals are refused until the email is verified.
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_player, 'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', 1))
  )::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_player::text, true);
  UPDATE public.profiles SET wallet = 500 WHERE id = v_player;
  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(100, 'player@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS DISTINCT FROM 'EMAIL_NOT_VERIFIED' THEN
    RAISE EXCEPTION 'unverified withdrawal was not refused with EMAIL_NOT_VERIFIED: %', v_error;
  END IF;

  -- A password session cannot mark itself verified.
  v_error := NULL;
  BEGIN
    PERFORM public.mark_email_verified();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS DISTINCT FROM 'EMAIL_CODE_REQUIRED' THEN
    RAISE EXCEPTION 'password session marked the email verified: %', v_error;
  END IF;

  -- Nor can a session without any amr claim.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_player, 'role', 'authenticated')::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.mark_email_verified();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS DISTINCT FROM 'EMAIL_CODE_REQUIRED' THEN
    RAISE EXCEPTION 'session without amr marked the email verified: %', v_error;
  END IF;

  -- A session started with the emailed code can.
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_player, 'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', 2))
  )::text, true);
  v_result := public.mark_email_verified();
  IF v_result->>'email_verified_at' IS NULL
     OR (SELECT email_verified_at FROM public.profiles WHERE id = v_player) IS NULL THEN
    RAISE EXCEPTION 'otp session did not mark the email verified: %', v_result;
  END IF;

  -- Players cannot set the flag themselves through the table.
  IF has_column_privilege('authenticated', 'public.profiles', 'email_verified_at', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can update profiles.email_verified_at directly';
  END IF;

  -- Changing the email clears the verification.
  UPDATE auth.users SET email = 'ev-player-new@example.invalid' WHERE id = v_player;
  IF (SELECT email_verified_at FROM public.profiles WHERE id = v_player) IS NOT NULL THEN
    RAISE EXCEPTION 'changing the email did not clear the verification';
  END IF;
  -- Only a change of case is not a new email.
  UPDATE public.profiles SET email_verified_at = now() WHERE id = v_player;
  UPDATE auth.users SET email = 'EV-Player-New@example.invalid' WHERE id = v_player;
  IF (SELECT email_verified_at FROM public.profiles WHERE id = v_player) IS NULL THEN
    RAISE EXCEPTION 'a change of letter case cleared the verification';
  END IF;

  -- Only the admin can verify someone by hand.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_player, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_player::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_mark_email_verified(v_other);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS DISTINCT FROM 'Admin only' THEN
    RAISE EXCEPTION 'a player verified another account: %', v_error;
  END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM public.admin_mark_email_verified(v_other);
  PERFORM public.admin_mark_email_verified(v_other);
  SELECT count(*) INTO v_count FROM public.admin_action_log
  WHERE actor_id = v_admin AND target_user_id = v_other AND action = 'verify_email';
  IF (SELECT email_verified_at FROM public.profiles WHERE id = v_other) IS NULL OR v_count <> 1 THEN
    RAISE EXCEPTION 'admin verification failed or was logged % times', v_count;
  END IF;

  -- The admin user page shows the email and the verification.
  v_result := public.admin_get_user_detail(v_other);
  IF v_result->'profile'->>'email' <> 'ev-other@example.invalid'
     OR v_result->'profile'->>'email_verified_at' IS NULL THEN
    RAISE EXCEPTION 'admin_get_user_detail is missing email fields: %', v_result->'profile';
  END IF;

  -- Clean-up removes only old, idle, never-verified accounts.
  PERFORM public.delete_stale_unconfirmed_users(5000);
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000304') THEN
    RAISE EXCEPTION 'stale unverified account was not deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000305')
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000306')
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_player) THEN
    RAISE EXCEPTION 'clean-up deleted a verified, recently active or new account';
  END IF;

  RAISE NOTICE 'email verification tests passed';
END;
$test$;

ROLLBACK;
