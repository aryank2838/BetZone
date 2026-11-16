-- Run against a disposable local Supabase database after `supabase db reset`.
-- Checks the first-deposit bonus: 5% of the first approved deposit, at least
-- 10 points, no cap, only once, and a rejected deposit does not use it up.
-- This transaction creates Auth fixtures and rolls all changes back.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES
  ('00000000-0000-4000-8000-000000000201', 'authenticated', 'authenticated', 'fdb-admin@example.invalid', '', now(), '{}', '{"display_name":"FDB admin","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000202', 'authenticated', 'authenticated', 'fdb-small@example.invalid', '', now(), '{}', '{"display_name":"FDB small","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000203', 'authenticated', 'authenticated', 'fdb-large@example.invalid', '', now(), '{}', '{"display_name":"FDB large","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000204', 'authenticated', 'authenticated', 'fdb-tiny@example.invalid', '', now(), '{}', '{"display_name":"FDB tiny","accepted_terms":true,"terms_version":"test"}');

UPDATE public.profiles SET is_admin = true
WHERE id = '00000000-0000-4000-8000-000000000201';

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000201';
  v_small uuid := '00000000-0000-4000-8000-000000000202';
  v_large uuid := '00000000-0000-4000-8000-000000000203';
  v_tiny uuid := '00000000-0000-4000-8000-000000000204';
  v_request uuid;
  v_result jsonb;
  v_points integer;
  v_bonus_rows integer;
  v_bonus_total bigint;
BEGIN
  -- Deposits are inserted directly as pending; the screenshot checks on
  -- request_add_funds are covered by database_regressions.sql.
  IF public.first_deposit_bonus_amount(1) <> 0
     OR public.first_deposit_bonus_amount(49) <> 0
     OR public.first_deposit_bonus_amount(50) <> 10
     OR public.first_deposit_bonus_amount(200) <> 10
     OR public.first_deposit_bonus_amount(219) <> 10
     OR public.first_deposit_bonus_amount(220) <> 11
     OR public.first_deposit_bonus_amount(1000) <> 50
     OR public.first_deposit_bonus_amount(100000) <> 5000 THEN
    RAISE EXCEPTION 'first_deposit_bonus_amount does not match 5%% with a 10-point minimum from 50';
  END IF;

  -- New signups start at 0 with no signup bonus.
  IF (SELECT points FROM public.profiles WHERE id = v_small) <> 0
     OR EXISTS (SELECT 1 FROM public.point_ledger
                WHERE user_id IN (v_small, v_large) AND reason = 'signup_bonus') THEN
    RAISE EXCEPTION 'new signup still received a signup bonus';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- A rejected first deposit does not use up the bonus.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_small, 50, 'pending', 'FDBREJECT0001') RETURNING id INTO v_request;
  v_result := public.admin_process_add_funds(v_request, 'rejected', 'Payment not received');
  IF (v_result->>'bonus')::integer <> 0
     OR EXISTS (SELECT 1 FROM public.point_ledger
                WHERE user_id = v_small AND reason = 'first_deposit_bonus') THEN
    RAISE EXCEPTION 'rejecting a deposit granted a bonus: %', v_result;
  END IF;

  -- Small first deposit: 50 + minimum bonus 10.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_small, 50, 'pending', 'FDBSMALL0001') RETURNING id INTO v_request;
  v_result := public.admin_process_add_funds(v_request, 'approved');
  SELECT points INTO v_points FROM public.profiles WHERE id = v_small;
  IF (v_result->>'bonus')::integer <> 10 OR v_points <> 60 THEN
    RAISE EXCEPTION 'small first deposit did not get the 10-point minimum: result %, points %', v_result, v_points;
  END IF;

  -- Second deposit: no more bonus.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_small, 1000, 'pending', 'FDBSMALL0002') RETURNING id INTO v_request;
  v_result := public.admin_process_add_funds(v_request, 'approved');
  SELECT points INTO v_points FROM public.profiles WHERE id = v_small;
  SELECT count(*), COALESCE(SUM(delta), 0) INTO v_bonus_rows, v_bonus_total
  FROM public.point_ledger WHERE user_id = v_small AND reason = 'first_deposit_bonus';
  IF (v_result->>'bonus')::integer <> 0 OR v_points <> 1060
     OR v_bonus_rows <> 1 OR v_bonus_total <> 10 THEN
    RAISE EXCEPTION 'second deposit got a bonus: result %, points %, bonus rows %', v_result, v_points, v_bonus_rows;
  END IF;

  -- Large first deposit: 5%, no cap.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_large, 100000, 'pending', 'FDBLARGE0001') RETURNING id INTO v_request;
  v_result := public.admin_process_add_funds(v_request, 'approved');
  SELECT points INTO v_points FROM public.profiles WHERE id = v_large;
  IF (v_result->>'bonus')::integer <> 5000 OR v_points <> 105000 THEN
    RAISE EXCEPTION 'large first deposit bonus was not 5%% uncapped: result %, points %', v_result, v_points;
  END IF;

  -- First deposit under 50: no bonus, and the offer is closed afterwards.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_tiny, 1, 'pending', 'FDBTINY0001') RETURNING id INTO v_request;
  v_result := public.admin_process_add_funds(v_request, 'approved');
  IF (v_result->>'bonus')::integer <> 0 THEN
    RAISE EXCEPTION 'first deposit under 50 got a bonus: %', v_result;
  END IF;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_tiny, 1000, 'pending', 'FDBTINY0002') RETURNING id INTO v_request;
  v_result := public.admin_process_add_funds(v_request, 'approved');
  SELECT points INTO v_points FROM public.profiles WHERE id = v_tiny;
  IF (v_result->>'bonus')::integer <> 0 OR v_points <> 1001
     OR EXISTS (SELECT 1 FROM public.point_ledger
                WHERE user_id = v_tiny AND reason = 'first_deposit_bonus') THEN
    RAISE EXCEPTION 'deposit after a tiny first deposit got a bonus: result %, points %', v_result, v_points;
  END IF;

  -- Balance breakdown shows the bonus and closes the offer.
  PERFORM set_config('request.jwt.claim.sub', v_large::text, true);
  v_result := public.get_balance_breakdown();
  IF (v_result->>'signup_earned')::integer <> 5000
     OR (v_result->>'first_deposit_bonus_available')::boolean THEN
    RAISE EXCEPTION 'balance breakdown does not reflect the first-deposit bonus: %', v_result;
  END IF;

  RAISE NOTICE 'first deposit bonus assertions passed';
END
$test$;

ROLLBACK;
