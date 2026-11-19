-- Run against a disposable local Supabase database after `supabase db reset`.
-- Checks the refer-a-friend rules. Rolls everything back.
BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('00000000-0000-4000-8000-000000000501', 'authenticated', 'authenticated', 'rf-admin@example.invalid', '', now(), '{}', '{"display_name":"RF admin","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000502', 'authenticated', 'authenticated', 'rf-inviter@example.invalid', '', now(), '{}', '{"display_name":"RF inviter","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000503', 'authenticated', 'authenticated', 'rf-banned@example.invalid', '', now(), '{}', '{"display_name":"RF banned","accepted_terms":true,"terms_version":"test"}');
UPDATE public.profiles SET is_admin = true WHERE id = '00000000-0000-4000-8000-000000000501';
UPDATE public.profiles SET is_banned = true WHERE id = '00000000-0000-4000-8000-000000000503';

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000501';
  v_inviter uuid := '00000000-0000-4000-8000-000000000502';
  v_banned uuid := '00000000-0000-4000-8000-000000000503';
  v_code text;
  v_banned_code text;
  v_friend uuid := '00000000-0000-4000-8000-000000000511';
  v_small uuid := '00000000-0000-4000-8000-000000000512';
  v_big uuid := '00000000-0000-4000-8000-000000000513';
  v_nobody uuid := '00000000-0000-4000-8000-000000000514';
  v_of_banned uuid := '00000000-0000-4000-8000-000000000515';
  v_over uuid := '00000000-0000-4000-8000-000000000516';
  v_request uuid;
  v_points_before integer;
  v_result jsonb;
  v_filler uuid;
  i integer;
BEGIN
  SELECT referral_code INTO v_code FROM public.profiles WHERE id = v_inviter;
  SELECT referral_code INTO v_banned_code FROM public.profiles WHERE id = v_banned;
  IF v_code !~ '^[A-HJ-NP-Z2-9]{6}$' OR v_code = v_banned_code THEN
    RAISE EXCEPTION 'bad or repeated invite codes: %, %', v_code, v_banned_code;
  END IF;

  -- Sign-ups with a code (any letter case), a wrong code, and a banned inviter's code.
  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_friend, 'authenticated', 'authenticated', 'rf-friend@example.invalid', '', now(), '{}',
      jsonb_build_object('display_name', 'Ravi Kumar', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', v_code)),
    (v_small, 'authenticated', 'authenticated', 'rf-small@example.invalid', '', now(), '{}',
      jsonb_build_object('display_name', 'Small', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', lower(v_code))),
    (v_big, 'authenticated', 'authenticated', 'rf-big@example.invalid', '', now(), '{}',
      jsonb_build_object('display_name', 'Big', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', ' ' || v_code || ' ')),
    (v_nobody, 'authenticated', 'authenticated', 'rf-nobody@example.invalid', '', now(), '{}',
      jsonb_build_object('display_name', 'Nobody', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', 'ZZZZZZ')),
    (v_of_banned, 'authenticated', 'authenticated', 'rf-of-banned@example.invalid', '', now(), '{}',
      jsonb_build_object('display_name', 'Of banned', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', v_banned_code));

  IF (SELECT referred_by FROM public.profiles WHERE id = v_friend) IS DISTINCT FROM v_inviter
     OR (SELECT referred_by FROM public.profiles WHERE id = v_small) IS DISTINCT FROM v_inviter
     OR (SELECT referred_by FROM public.profiles WHERE id = v_big) IS DISTINCT FROM v_inviter
     OR (SELECT referred_by FROM public.profiles WHERE id = v_nobody) IS NOT NULL THEN
    RAISE EXCEPTION 'referred_by was not set from the sign-up code';
  END IF;

  IF has_column_privilege('authenticated', 'public.profiles', 'referred_by', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'referral_code', 'UPDATE') THEN
    RAISE EXCEPTION 'players can change referral columns';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- First deposit 1500 -> 10% = 150 to the inviter, as play balance.
  SELECT points INTO v_points_before FROM public.profiles WHERE id = v_inviter;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_friend, 1500, 'pending', 'RFDEPOSIT0001') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  IF (SELECT points FROM public.profiles WHERE id = v_inviter) <> v_points_before + 150
     OR NOT EXISTS (SELECT 1 FROM public.point_ledger WHERE user_id = v_inviter AND reason = 'referral_bonus' AND delta = 150)
     OR (SELECT status FROM public.referral_rewards WHERE friend_id = v_friend) <> 'paid' THEN
    RAISE EXCEPTION 'first deposit did not pay the inviter 150';
  END IF;
  IF (SELECT wallet FROM public.profiles WHERE id = v_inviter) <> 0 THEN
    RAISE EXCEPTION 'referral bonus went to the withdrawable wallet';
  END IF;

  -- A second deposit by the same friend pays nothing more.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_friend, 3000, 'pending', 'RFDEPOSIT0002') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  IF (SELECT count(*) FROM public.point_ledger WHERE user_id = v_inviter AND reason = 'referral_bonus') <> 1 THEN
    RAISE EXCEPTION 'a second deposit paid another referral bonus';
  END IF;

  -- Under 100: recorded, nothing paid. A rejected deposit before does not count.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_small, 5000, 'pending', 'RFDEPOSIT0003') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'rejected', 'Payment not received');
  IF EXISTS (SELECT 1 FROM public.referral_rewards WHERE friend_id = v_small) THEN
    RAISE EXCEPTION 'a rejected deposit used up the referral';
  END IF;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_small, 99, 'pending', 'RFDEPOSIT0004') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  IF (SELECT status FROM public.referral_rewards WHERE friend_id = v_small) <> 'too_small'
     OR (SELECT reward FROM public.referral_rewards WHERE friend_id = v_small) <> 0 THEN
    RAISE EXCEPTION 'a deposit under 100 was rewarded';
  END IF;

  -- Big deposit: capped at 200.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_big, 9000, 'pending', 'RFDEPOSIT0005') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  IF (SELECT reward FROM public.referral_rewards WHERE friend_id = v_big) <> 200 THEN
    RAISE EXCEPTION 'the reward was not capped at 200';
  END IF;

  -- Banned inviter: no reward.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_of_banned, 1000, 'pending', 'RFDEPOSIT0006') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  IF (SELECT status FROM public.referral_rewards WHERE friend_id = v_of_banned) <> 'not_eligible'
     OR EXISTS (SELECT 1 FROM public.point_ledger WHERE user_id = v_banned AND reason = 'referral_bonus') THEN
    RAISE EXCEPTION 'a banned inviter was rewarded';
  END IF;

  -- 20 paid friends in 30 days is the limit (2 paid so far: v_friend, v_big).
  FOR i IN 1..18 LOOP
    v_filler := ('00000000-0000-4000-8000-0000000006' || lpad(i::text, 2, '0'))::uuid;
    INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    VALUES (v_filler, 'authenticated', 'authenticated', 'rf-filler' || i || '@example.invalid', '', now(), '{}',
      jsonb_build_object('display_name', 'Filler', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', v_code));
    INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
    VALUES (v_filler, 100, 'pending', 'RFFILLER' || lpad(i::text, 5, '0')) RETURNING id INTO v_request;
    PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  END LOOP;
  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_over, 'authenticated', 'authenticated', 'rf-over@example.invalid', '', now(), '{}',
    jsonb_build_object('display_name', 'Over', 'accepted_terms', true, 'terms_version', 'test', 'referral_code', v_code));
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_over, 1000, 'pending', 'RFDEPOSIT0007') RETURNING id INTO v_request;
  PERFORM public.admin_process_add_funds(v_request, 'approved', NULL);
  IF (SELECT count(*) FROM public.referral_rewards WHERE referrer_id = v_inviter AND status = 'paid') <> 20
     OR (SELECT status FROM public.referral_rewards WHERE friend_id = v_over) <> 'capped' THEN
    RAISE EXCEPTION 'the 20 friends per 30 days limit was not applied';
  END IF;

  -- What the inviter sees.
  PERFORM set_config('request.jwt.claim.sub', v_inviter::text, true);
  v_result := public.get_my_referral();
  IF v_result->>'code' <> v_code
     OR (v_result->>'friends_joined')::int <> 22
     OR (v_result->>'friends_rewarded')::int <> 20
     OR (v_result->>'total_earned')::int <> 150 + 200 + 18 * 10 THEN
    RAISE EXCEPTION 'unexpected get_my_referral: %', v_result - 'friends';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'friends') f WHERE f->>'name' = 'Ravi') THEN
    RAISE EXCEPTION 'friends list should show first names only';
  END IF;
  IF (public.get_balance_breakdown()->>'signup_earned')::int < 150 + 200 + 180 THEN
    RAISE EXCEPTION 'balance breakdown left out referral bonuses';
  END IF;

  -- Admin view.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.admin_user_referrals(v_friend);
  IF v_result->'invited_by'->>'id' <> v_inviter::text THEN
    RAISE EXCEPTION 'admin_user_referrals did not show the inviter: %', v_result;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_friend::text, true);
  BEGIN
    PERFORM public.admin_user_referrals(v_inviter);
    RAISE EXCEPTION 'a player read admin_user_referrals';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Admin only' THEN RAISE; END IF;
  END;

  RAISE NOTICE 'referral tests passed';
END;
$test$;

ROLLBACK;
