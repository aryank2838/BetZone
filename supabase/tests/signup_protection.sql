-- Run against a disposable local Supabase database after `supabase db reset`.
-- This transaction creates Auth fixtures and rolls all changes back.
BEGIN;

DO $test$
DECLARE
  v_unconfirmed uuid := '00000000-0000-4000-8000-000000000101';
  v_confirmed uuid := '00000000-0000-4000-8000-000000000102';
  v_error text;
  v_bonus_count integer;
  v_points integer;
BEGIN
  IF public.normalize_email('A.B+x@Gmail.com') <> 'ab@gmail.com'
     OR public.normalize_email('ab@googlemail.com') <> 'ab@gmail.com'
     OR public.normalize_email('a.b@example.com') <> 'a.b@example.com'
     OR public.normalize_email('Person+tag@Example.com') <> 'person@example.com'
     OR public.normalize_email(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'email normalization did not match required behavior';
  END IF;

  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data
  )
  VALUES (
    v_unconfirmed, 'authenticated', 'authenticated',
    'A.B+first@gmail.com', '', NULL, '{}', '{"display_name":"Unconfirmed","accepted_terms":true,"terms_version":"test"}'
  );

  SELECT points INTO v_points
  FROM public.profiles WHERE id = v_unconfirmed;
  SELECT count(*) INTO v_bonus_count
  FROM public.point_ledger
  WHERE user_id = v_unconfirmed AND reason = 'signup_bonus';
  IF v_points <> 0 OR v_bonus_count <> 0 THEN
    RAISE EXCEPTION 'unconfirmed signup received a bonus: balance %, rows %', v_points, v_bonus_count;
  END IF;

  v_error := NULL;
  BEGIN
    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data
    )
    VALUES (
      '00000000-0000-4000-8000-000000000103',
      'authenticated', 'authenticated',
      'ab@googlemail.com', '', NULL, '{}', '{}'
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%EMAIL_ALREADY_USED%' THEN
    RAISE EXCEPTION 'Gmail dot/plus duplicate was not blocked: %', v_error;
  END IF;

  UPDATE auth.users
  SET email_confirmed_at = clock_timestamp()
  WHERE id = v_unconfirmed;
  UPDATE auth.users
  SET email_confirmed_at = NULL
  WHERE id = v_unconfirmed;
  UPDATE auth.users
  SET email_confirmed_at = clock_timestamp()
  WHERE id = v_unconfirmed;

  SELECT points INTO v_points
  FROM public.profiles WHERE id = v_unconfirmed;
  SELECT count(*) INTO v_bonus_count
  FROM public.point_ledger
  WHERE user_id = v_unconfirmed AND reason = 'signup_bonus';
  IF v_points <> 10 OR v_bonus_count <> 1 THEN
    RAISE EXCEPTION 'email confirmation did not grant exactly one bonus: balance %, rows %', v_points, v_bonus_count;
  END IF;

  INSERT INTO auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data
  )
  VALUES (
    v_confirmed, 'authenticated', 'authenticated',
    'confirmed@example.com', '', clock_timestamp(), '{}', '{"display_name":"Confirmed","accepted_terms":true,"terms_version":"test"}'
  );

  SELECT points INTO v_points
  FROM public.profiles WHERE id = v_confirmed;
  SELECT count(*) INTO v_bonus_count
  FROM public.point_ledger
  WHERE user_id = v_confirmed AND reason = 'signup_bonus';
  IF v_points <> 10 OR v_bonus_count <> 1 THEN
    RAISE EXCEPTION 'confirmed-at-insert signup did not receive exactly one bonus: balance %, rows %', v_points, v_bonus_count;
  END IF;

  v_error := NULL;
  BEGIN
    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data
    )
    VALUES (
      '00000000-0000-4000-8000-000000000106',
      'authenticated', 'authenticated',
      'without-terms@example.org', '', NULL, '{}', '{"display_name":"No terms"}'
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%TERMS_NOT_ACCEPTED%' THEN
    RAISE EXCEPTION 'signup without terms acceptance was not rejected: %', v_error;
  END IF;

  v_error := NULL;
  BEGIN
    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data
    )
    VALUES (
      '00000000-0000-4000-8000-000000000104',
      'authenticated', 'authenticated',
      'user@mailinator.com', '', NULL, '{}', '{}'
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%EMAIL_DOMAIN_BLOCKED%' THEN
    RAISE EXCEPTION 'blocked email domain was not rejected: %', v_error;
  END IF;

  v_error := NULL;
  BEGIN
    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data
    )
    VALUES (
      '00000000-0000-4000-8000-000000000105',
      'authenticated', 'authenticated',
      'user@sub.mailinator.com', '', NULL, '{}', '{}'
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%EMAIL_DOMAIN_BLOCKED%' THEN
    RAISE EXCEPTION 'blocked parent email domain was not rejected: %', v_error;
  END IF;

  IF has_table_privilege('anon', 'public.blocked_email_domains', 'SELECT')
     OR has_table_privilege('anon', 'public.blocked_email_domains', 'INSERT')
     OR has_table_privilege('anon', 'public.blocked_email_domains', 'UPDATE')
     OR has_table_privilege('anon', 'public.blocked_email_domains', 'DELETE')
     OR has_table_privilege('authenticated', 'public.blocked_email_domains', 'SELECT')
     OR has_table_privilege('authenticated', 'public.blocked_email_domains', 'INSERT')
     OR has_table_privilege('authenticated', 'public.blocked_email_domains', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.blocked_email_domains', 'DELETE') THEN
    RAISE EXCEPTION 'anon/authenticated can access the blocked domain table';
  END IF;

  RAISE NOTICE 'signup protection assertions passed';
END
$test$;

ROLLBACK;
