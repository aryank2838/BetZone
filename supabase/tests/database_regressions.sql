-- Run against a disposable local Supabase database after `supabase db reset`.
-- This transaction creates temporary Auth fixtures and rolls all changes back.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'db-test-admin@example.invalid', '', now(), '{}', '{"display_name":"DB test admin","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'db-test-user1@example.invalid', '', now(), '{}', '{"display_name":"DB test user 1","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'db-test-user2@example.invalid', '', now(), '{}', '{"display_name":"DB test user 2","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'db-test-user3@example.invalid', '', now(), '{}', '{"display_name":"DB test user 3","accepted_terms":true,"terms_version":"test"}');

UPDATE public.profiles
SET is_admin = (id = '00000000-0000-4000-8000-000000000001'),
    points = 100000,
    wallet = 0,
    is_banned = false
WHERE id IN (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004'
);

DO $test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000001';
  v_user1 uuid := '00000000-0000-4000-8000-000000000002';
  v_user2 uuid := '00000000-0000-4000-8000-000000000003';
  v_user3 uuid := '00000000-0000-4000-8000-000000000004';
  v_round date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date - 2;
  v_round_other date := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date - 3;
  v_result jsonb;
  v_withdrawal_id uuid;
  v_add_funds_id uuid;
  v_bet_type text;
  v_selection jsonb;
  v_error text;
  v_points integer;
  v_wallet integer;
  v_before integer;
  v_after integer;
  v_ledger_delta bigint;
  v_count bigint;
  v_count_before bigint;
  v_ledger_count_before bigint;
  v_winning_count_before bigint;
  v_wallet_total_before bigint;
  v_preview_total integer;
  v_opening_balance bigint;
  v_report_date constant date := date '2000-01-02';
  v_restriction_until timestamptz;
  v_loop integer;
  v_withdrawal_user uuid;
  v_my_bets jsonb;
  v_result_history jsonb;
  v_status jsonb;
  v_now time := (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::time;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_ledger_opening_balances
    WHERE user_id IN (v_admin, v_user1, v_user2, v_user3)
  ) THEN
    RAISE EXCEPTION 'a user created after the opening-balance migration received a legacy opening-balance row';
  END IF;

  IF NOT public.is_valid_patti('123')
     OR NOT public.is_valid_patti('000')
     OR NOT public.is_valid_patti('120')
     OR public.is_valid_patti('321')
     OR public.is_valid_patti('12')
     OR public.is_valid_patti('12a')
     OR public.is_valid_patti('') THEN
    RAISE EXCEPTION 'patti validity differs from SQL test cases';
  END IF;
  IF public.patti_digit('123') <> 6
     OR public.patti_digit('000') <> 0
     OR public.patti_digit('789') <> 4
     OR NOT public.is_valid_patti_combo('123-6')
     OR NOT public.is_valid_patti_combo('000-0')
     OR NOT public.is_valid_patti_combo('120-3')
     OR public.is_valid_patti_combo('123-5')
     OR public.is_valid_patti_combo('321-6')
     OR public.is_valid_patti_combo('123-06')
     OR public.is_valid_patti_combo('abc-6') THEN
    RAISE EXCEPTION 'patti digit/combo validation differs from SQL test cases';
  END IF;

  IF has_table_privilege('anon', 'public.selections', 'INSERT')
     OR has_table_privilege('authenticated', 'public.selections', 'INSERT')
     OR has_table_privilege('anon', 'public.selections', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.selections', 'UPDATE')
     OR has_column_privilege('anon', 'public.profiles', 'wallet', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'wallet', 'UPDATE')
     OR has_column_privilege('anon', 'public.profiles', 'is_admin', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.profiles', 'is_admin', 'UPDATE')
     OR has_function_privilege('anon', 'public.admin_toggle_ban(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.process_open_payouts(text,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.process_close_payouts(text,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.settle_bets(text,date,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.bet_round(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.bet_multiplier(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.bet_type_lock_key(text, date, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.internal_rule_constants()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_my_bets(text,date,date,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_result_history(text,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_process_withdrawal(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_process_add_funds(uuid,text,text)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('admin_process_withdrawal', 'admin_process_add_funds')
         AND p.pronargs = 2
     )
     OR EXISTS (
       SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname LIKE 'admin\_%' ESCAPE '\'
         AND (
           has_function_privilege('anon', p.oid, 'EXECUTE')
           OR pg_get_functiondef(p.oid) NOT ILIKE '%is_current_user_admin%'
         )
     ) THEN
    RAISE EXCEPTION 'unexpected direct table or internal-function privileges';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges rp
    WHERE rp.routine_schema = 'public'
      AND rp.grantee = 'anon'
      AND rp.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon has EXECUTE on a public routine: %',
      (
        SELECT string_agg(rp.routine_name, ', ')
        FROM information_schema.routine_privileges rp
        WHERE rp.routine_schema = 'public'
          AND rp.grantee = 'anon'
          AND rp.privilege_type = 'EXECUTE'
      );
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
    LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
    WHERE d.defaclobjtype = 'f'
      AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
      AND acl.privilege_type = 'EXECUTE'
      AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
      -- Only creator roles this session can administer. On hosted Supabase the
      -- platform role supabase_admin keeps its own defaults; migrations never run as it.
      AND pg_has_role(current_user, d.defaclrole, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'default function privileges still grant EXECUTE to PUBLIC, anon, or authenticated';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
    GROUP BY p.proname
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'public function overloads remain: %',
      (
        SELECT string_agg(overloads.proname, ', ' ORDER BY overloads.proname)
        FROM (
          SELECT p.proname
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
          GROUP BY p.proname
          HAVING count(*) > 1
        ) overloads
      );
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges rp
    JOIN information_schema.routines r
      ON r.specific_name = rp.specific_name
     AND r.routine_schema = rp.routine_schema
    WHERE rp.routine_schema = 'public'
      AND rp.grantee = 'authenticated'
      AND rp.privilege_type = 'EXECUTE'
      AND rp.routine_name LIKE 'admin\_%' ESCAPE '\'
      AND COALESCE(r.routine_definition, '') NOT ILIKE '%is_current_user_admin%'
  ) THEN
    RAISE EXCEPTION 'an authenticated admin RPC lacks its admin authorization guard';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges rp
    WHERE rp.routine_schema = 'public'
      AND rp.grantee = 'authenticated'
      AND rp.privilege_type = 'EXECUTE'
      AND rp.routine_name IN ('bet_round', 'round_lock_key', 'bet_type_lock_key', 'settle_bets', 'process_open_payouts', 'process_close_payouts')
  ) THEN
    RAISE EXCEPTION 'authenticated users can execute an internal betting or settlement routine';
  END IF;

  -- Make the current round available to exercise submit_selection independently of wall time.
  UPDATE public.game_schedule
  SET bets_open = time '00:00',
      open_bets_close = time '23:59:59',
      close_bets_close = time '23:59:59'
  WHERE game = 'test';

  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  v_status := public.get_game_status();
  IF jsonb_typeof(v_status) <> 'array'
     OR NOT ((v_status->0) ? 'server_now')
     OR NOT ((v_status->0) ? 'open_bets_close_ts')
     OR NOT ((v_status->0) ? 'close_bets_close_ts') THEN
    RAISE EXCEPTION 'game status did not include server clock and next cutoff timestamps: %', v_status;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(100, 'BAD-REF', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%8 to 30 letters or numbers%' THEN
    RAISE EXCEPTION 'add-funds UTR validation was not enforced: %', v_error;
  END IF;
  UPDATE public.profiles SET points = 2, wallet = 100 WHERE id = v_user1;
  v_before := 102;
  PERFORM public.submit_selection(
    'test',
    '[{"number":"9","points":5}]'::jsonb,
    'single_close'
  );
  SELECT points, wallet INTO v_points, v_wallet
  FROM public.profiles WHERE id = v_user1;
  IF v_points <> 0 OR v_wallet <> 97 THEN
    RAISE EXCEPTION 'balance spending was not play balance first (%, %)', v_points, v_wallet;
  END IF;
  SELECT COALESCE(SUM(delta), 0) INTO v_ledger_delta
  FROM public.point_ledger WHERE user_id = v_user1 AND reason = 'selection_submit';
  IF v_ledger_delta <> -5 OR v_before - v_points - v_wallet <> 5 THEN
    RAISE EXCEPTION 'selection ledger delta does not match the balance change';
  END IF;

  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"8","points":5001}]'::jsonb, 'single_close');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%whole number from 1 to 5000%' THEN
    RAISE EXCEPTION 'per-bet maximum was not enforced: %', v_error;
  END IF;

  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection(
      'test',
      '[{"number":"10","points":5000},{"number":"11","points":5000},{"number":"12","points":5000},{"number":"13","points":5000},{"number":"14","points":5000}]'::jsonb,
      'jodi'
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%single submit can total at most 20000%' THEN
    RAISE EXCEPTION 'per-submit maximum was not enforced: %', v_error;
  END IF;

  -- A failed spend must not change either balance.
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"8","points":1000}]'::jsonb, 'single_close');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Insufficient balance%' THEN
    RAISE EXCEPTION 'insufficient-balance submit did not fail as expected: %', v_error;
  END IF;

  -- Per-user round exposure applies across bet types.
  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES ('max_user_round_points', '5', v_admin)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;
  UPDATE public.profiles SET points = 100, wallet = 0 WHERE id = v_user2;
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  PERFORM public.submit_selection('test', '[{"number":"1","points":3}]'::jsonb, 'single_open');
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"123-6","points":3}]'::jsonb, 'patti_open');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Round stake limit exceeded%' THEN
    RAISE EXCEPTION 'per-user round exposure limit was not enforced: %', v_error;
  END IF;

  -- Aggregate number liability is shared across users.
  UPDATE public.app_settings
  SET value = '50000'
  WHERE key = 'max_user_round_points';
  UPDATE public.app_settings
  SET value = '9'
  WHERE key = 'max_number_liability';
  UPDATE public.profiles SET points = 100, wallet = 0 WHERE id = v_user1;
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM public.submit_selection('test', '[{"number":"6","points":1}]'::jsonb, 'single_open');
  UPDATE public.profiles SET points = 100, wallet = 0 WHERE id = v_user3;
  PERFORM set_config('request.jwt.claim.sub', v_user3::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"6","points":1}]'::jsonb, 'single_open');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Number liability limit exceeded%' THEN
    RAISE EXCEPTION 'aggregate number liability was not enforced: %', v_error;
  END IF;

  -- Open bets close independently while close bets remain accepted.
  UPDATE public.game_schedule
  SET bets_open = time '00:00',
      open_bets_close = time '00:00:01',
      close_bets_close = time '23:59:59'
  WHERE game = 'test';
  UPDATE public.app_settings SET value = '1000000' WHERE key = 'max_number_liability';
  IF public.bet_round('test', 'single_open') IS NOT NULL
     OR public.bet_round('test', 'jodi') IS NOT NULL
     OR public.bet_round('test', 'patti_open') IS NOT NULL
     OR public.bet_round('test', 'single_close') IS NULL
     OR public.bet_round('test', 'patti_close') IS NULL THEN
    RAISE EXCEPTION 'open and close bet windows were not distinguished';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_user3::text, true);
  PERFORM public.submit_selection('test', '[{"number":"3","points":1}]'::jsonb, 'single_close');
  PERFORM public.submit_selection('test', '[{"number":"123-6","points":1}]'::jsonb, 'patti_close');

  -- Each bet type is rejected outside its corresponding time window.
  UPDATE public.game_schedule
  SET bets_open = time '23:59:59',
      open_bets_close = time '23:59:59',
      close_bets_close = time '23:59:59'
  WHERE game = 'test';
  PERFORM set_config('request.jwt.claim.sub', v_user3::text, true);
  IF public.bet_round('test', 'single_open') IS NOT NULL
     OR public.bet_round('test', 'jodi') IS NOT NULL
     OR public.bet_round('test', 'patti_open') IS NOT NULL
     OR public.bet_round('test', 'single_close') IS NOT NULL
     OR public.bet_round('test', 'patti_close') IS NOT NULL THEN
    RAISE EXCEPTION 'bet_round accepted a bet outside all configured windows at %', v_now;
  END IF;
  FOREACH v_bet_type IN ARRAY ARRAY['single_open', 'single_close', 'jodi', 'patti_open', 'patti_close'] LOOP
    v_selection := CASE v_bet_type
      WHEN 'single_open' THEN '[{"number":"2","points":1}]'::jsonb
      WHEN 'single_close' THEN '[{"number":"3","points":1}]'::jsonb
      WHEN 'jodi' THEN '[{"number":"23","points":1}]'::jsonb
      WHEN 'patti_open' THEN '[{"number":"123-6","points":1}]'::jsonb
      ELSE '[{"number":"135-9","points":1}]'::jsonb
    END;
    v_error := NULL;
    BEGIN
      PERFORM public.submit_selection('test', v_selection, v_bet_type);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    END;
    IF v_error IS NULL OR v_error NOT ILIKE '%Betting is closed%' THEN
      RAISE EXCEPTION 'closed betting window was not enforced for %: %', v_bet_type, v_error;
    END IF;
  END LOOP;

  -- Settlement covers 9x, 90x, and 120x payouts, exact combo matching, and round scoping.
  UPDATE public.game_schedule
  SET bets_open = time '00:00',
      open_bets_close = time '23:59:59',
      close_bets_close = time '23:59:59'
  WHERE game = 'test';
  DELETE FROM public.selections
  WHERE user_id IN (v_user1, v_user2, v_user3)
    AND game = 'test'
    AND round_date IN (v_round, v_round_other);
  DELETE FROM public.winning_results
  WHERE game = 'test'
    AND round_date IN (v_round, v_round_other);
  UPDATE public.profiles SET points = 100, wallet = 0 WHERE id = v_user1;
  INSERT INTO public.selections (user_id, game, bet_type, round_date, selections, total_points)
  VALUES
    (v_user1, 'test', 'single_open', v_round, '[{"number":"6","points":1}]', 1),
    (v_user1, 'test', 'patti_open', v_round, '[{"number":"123-6","points":1},{"number":"120-3","points":1}]', 2),
    (v_user1, 'test', 'single_close', v_round, '[{"number":"9","points":1}]', 1),
    (v_user1, 'test', 'patti_close', v_round, '[{"number":"135-9","points":1}]', 1),
    (v_user1, 'test', 'jodi', v_round, '[{"number":"69","points":1}]', 1),
    (v_user2, 'test', 'single_open', v_round_other, '[{"number":"6","points":1}]', 1);

  SELECT count(*) INTO v_count_before
  FROM public.admin_action_log
  WHERE actor_id = v_admin
    AND game = 'test'
    AND round_date = v_round
    AND action IN ('post_open_result', 'post_close_result');
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.admin_preview_result('test', v_round, 'open', '123');
  v_preview_total := COALESCE((
    SELECT sum((item->>'total_payout')::integer)
    FROM jsonb_array_elements(v_result->'winning_by_bet_type') AS items(item)
  ), 0);
  IF v_preview_total <> 129
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"single_open","winning_number":"6","winning_picks":1,"total_payout":9}]'::jsonb)
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"patti_open","winning_picks":1,"total_payout":120}]'::jsonb) THEN
    RAISE EXCEPTION 'open result preview did not match the expected winners and payout: %', v_result;
  END IF;
  SELECT count(*) INTO v_ledger_count_before FROM public.point_ledger;
  SELECT count(*) INTO v_winning_count_before FROM public.winning_results;
  SELECT COALESCE(sum(wallet), 0) INTO v_wallet_total_before FROM public.profiles;
  SELECT count(*) INTO v_count_before
  FROM public.admin_action_log
  WHERE actor_id = v_admin
    AND game = 'test'
    AND round_date = v_round
    AND action IN ('post_open_result', 'post_close_result');
  PERFORM public.admin_preview_result('test', v_round, 'open', '123');
  IF (SELECT count(*) FROM public.point_ledger) <> v_ledger_count_before
     OR (SELECT count(*) FROM public.winning_results) <> v_winning_count_before
     OR (SELECT COALESCE(sum(wallet), 0) FROM public.profiles) <> v_wallet_total_before
     OR (SELECT count(*) FROM public.admin_action_log
         WHERE actor_id = v_admin AND game = 'test' AND round_date = v_round
           AND action IN ('post_open_result', 'post_close_result')) <> v_count_before THEN
    RAISE EXCEPTION 'admin result preview changed ledger, results, balances, or audit rows';
  END IF;
  v_result := public.admin_post_open_result('test', v_round, '123', '6');
  IF (v_result->>'total_paid')::integer <> v_preview_total THEN
    RAISE EXCEPTION 'open result payout did not match preview %: %', v_preview_total, v_result;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_post_open_result('test', v_round, '123', '6');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%already posted and paid%' THEN
    RAISE EXCEPTION 'duplicate open posting did not fail: %', v_error;
  END IF;

  v_result := public.admin_preview_result('test', v_round, 'close', '135');
  v_preview_total := COALESCE((
    SELECT sum((item->>'total_payout')::integer)
    FROM jsonb_array_elements(v_result->'winning_by_bet_type') AS items(item)
  ), 0);
  IF v_preview_total <> 219
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"single_close","winning_number":"9","winning_picks":1,"total_payout":9}]'::jsonb)
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"patti_close","winning_picks":1,"total_payout":120}]'::jsonb)
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"jodi","winning_number":"69","winning_picks":1,"total_payout":90}]'::jsonb) THEN
    RAISE EXCEPTION 'close result preview did not match expected winners and payout: %', v_result;
  END IF;
  v_result := public.admin_post_close_result('test', v_round, '135', '9');
  IF (v_result->>'total_paid')::integer <> v_preview_total THEN
    RAISE EXCEPTION 'close result payout did not match preview %: %', v_preview_total, v_result;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_post_close_result('test', v_round, '135', '9');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%already posted and paid%' THEN
    RAISE EXCEPTION 'duplicate close posting did not fail: %', v_error;
  END IF;
  IF (SELECT wallet FROM public.profiles WHERE id = v_user1) <> 348
     OR (SELECT wallet FROM public.profiles WHERE id = v_user2) <> 0 THEN
    RAISE EXCEPTION 'settlement paid the wrong amount or crossed the round boundary';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.admin_action_log
  WHERE actor_id = v_admin
    AND game = 'test'
    AND round_date = v_round
    AND action IN ('post_open_result', 'post_close_result');
  IF v_count <> v_count_before + 2 THEN
    RAISE EXCEPTION 'result posting did not write exactly one audit row per successful phase';
  END IF;

  v_result := public.admin_preview_result('test', v_round, 'close', '135');
  IF NOT (v_result->'warnings' @> '["Result has already been paid"]'::jsonb)
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"jodi","winning_number":"69","winning_picks":1,"total_payout":90}]'::jsonb)
     OR NOT (v_result->'winning_by_bet_type' @> '[{"bet_type":"patti_close","winning_picks":1,"total_payout":120}]'::jsonb) THEN
    RAISE EXCEPTION 'close result preview did not return expected matching payouts/warnings: %', v_result;
  END IF;
  v_result := public.admin_preview_result('test', v_round, 'open', '321');
  IF NOT (v_result->'warnings' @> '["Invalid patti"]'::jsonb) THEN
    RAISE EXCEPTION 'result preview did not report invalid patti: %', v_result;
  END IF;
  v_result := public.admin_get_exposure('test', v_round);
  IF NOT (v_result->'stake_totals' @> '[{"bet_type":"jodi","total_stake":1}]'::jsonb)
     OR NOT (v_result->'exposure' @> '[{"bet_type":"jodi","number":"69","total_stake":1,"potential_payout":90}]'::jsonb)
     OR NOT (v_result->'phase_exposure' @> '{"open_worst_case":129,"close_worst_case":219}'::jsonb) THEN
    RAISE EXCEPTION 'admin exposure did not include stake totals and ranked numbers: %', v_result;
  END IF;
  v_result := public.admin_get_user_detail(v_user1);
  IF v_result->'profile'->>'id' <> v_user1::text
     OR jsonb_array_length(v_result->'ledger') > 100
     OR jsonb_array_length(v_result->'bets') > 50
     OR (v_result->'profile' ? 'email') THEN
    RAISE EXCEPTION 'admin user detail shape or privacy limits are incorrect: %', v_result;
  END IF;
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata, created_at)
  VALUES
    (v_user1, -100, 'selection_submit', '{"game":"test"}', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
    (v_user1, 40, 'winning_payout', '{"game":"test"}', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
    (v_user1, 60, 'admin_adjust_wallet', '{}', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
    (v_user2, -20, 'selection_submit', '{"game":"test2"}', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
    (v_user2, 5, 'winning_payout', '{"game":"test2"}', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
    (v_user2, 15, 'admin_adjust_wallet', '{}', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref, processed_at)
  VALUES (v_user1, 200, 'approved', 'REPORTFIXTURE2000', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata');
  INSERT INTO public.withdrawals (user_id, amount, status, upi_id, processed_at)
  VALUES (v_user1, 30, 'approved', 'report-fixture@bank', v_report_date::timestamp AT TIME ZONE 'Asia/Kolkata');

  v_result := public.admin_daily_report(v_report_date);
  IF jsonb_array_length(v_result) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result) AS report_rows(row_data)
       WHERE row_data->>'game' = 'test'
         AND (row_data->>'total_staked')::bigint = 100
         AND (row_data->>'total_paid_out')::bigint = 40
         AND (row_data->>'gaming_revenue')::bigint = 60
         AND NOT (row_data ? 'net')
         AND NOT (row_data ? 'approved_deposits')
     )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result) AS report_rows(row_data)
       WHERE row_data->>'game' = 'test2'
         AND (row_data->>'total_staked')::bigint = 20
         AND (row_data->>'total_paid_out')::bigint = 5
         AND (row_data->>'gaming_revenue')::bigint = 15
     )
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result) AS report_rows(row_data)
       WHERE row_data->>'game' = 'ALL'
         AND (row_data->>'total_staked')::bigint = 120
         AND (row_data->>'total_paid_out')::bigint = 45
         AND (row_data->>'gaming_revenue')::bigint = 75
         AND (row_data->>'approved_deposits')::bigint = 200
         AND (row_data->>'approved_withdrawals')::bigint = 30
         AND (row_data->>'net_cash')::bigint = 170
         AND NOT (row_data ? 'net')
     ) THEN
    RAISE EXCEPTION 'daily report did not return exact gaming and cash-flow totals for its known fixture: %', v_result;
  END IF;

     INSERT INTO public.game_schedule (
       game, label, bets_open, open_bets_close, close_bets_close,
       open_result_at, close_result_at, close_result_next_day
     ) VALUES (
       'regression_game', 'Regression Game', time '00:00', time '23:59',
       time '23:59', time '23:59', time '23:59', false
     );
     PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
     v_result := public.admin_get_stats(v_round);
     SELECT count(*) INTO v_count
     FROM public.get_result_history('regression_game', 30, 0);
     IF NOT (v_result->'selection_counts' ? 'regression_game')
        OR jsonb_array_length(public.admin_list_selections('regression_game', v_round)) <> 0
        OR v_count <> 0 THEN
       RAISE EXCEPTION 'schedule-backed game validation or stats omitted a configured game: %', v_result;
     END IF;
     PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
     SELECT jsonb_agg(to_jsonb(b)) INTO v_my_bets
     FROM public.get_my_bets('regression_game', NULL, NULL, 30, 0) AS b;
     IF v_my_bets IS NOT NULL THEN
       RAISE EXCEPTION 'my bets rejected a configured game or returned unexpected fixture picks: %', v_my_bets;
     END IF;
     DELETE FROM public.game_schedule WHERE game = 'regression_game';
     PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

     INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_user1, 25, 'pending', 'FILTERTEST1234');
  INSERT INTO public.withdrawals (user_id, amount, status, upi_id)
  VALUES (v_user1, 25, 'rejected', 'test@bank');
  v_result := public.admin_list_users('DB test user 1', 'active', NULL, NULL, 50, 0);
  IF jsonb_array_length(v_result) <> 1
     OR v_result->0->>'id' <> v_user1::text THEN
    RAISE EXCEPTION 'admin user search/status filters did not apply in the database: %', v_result;
  END IF;
  v_result := public.admin_list_add_funds(
    50, 0, 'pending', (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,
    (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date, 'FILTERTEST1234'
  );
  IF jsonb_array_length(v_result) <> 1 OR v_result->0->>'payment_ref' <> 'FILTERTEST1234' THEN
    RAISE EXCEPTION 'add-funds UTR/status/date filters did not apply in the database: %', v_result;
  END IF;
  v_result := public.admin_list_withdrawals(
    50, 0, 'rejected', (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,
    (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date, 'DB test user 1'
  );
  IF jsonb_array_length(v_result) <> 1 OR v_result->0->>'upi_id' <> 'test@bank' THEN
    RAISE EXCEPTION 'withdrawal name/status/date filters did not apply in the database: %', v_result;
  END IF;
  -- Remove the filter fixture so later one-pending-request checks start clean.
  DELETE FROM public.add_funds_requests WHERE payment_ref = 'FILTERTEST1234';

  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  SELECT jsonb_agg(to_jsonb(b)) INTO v_my_bets
  FROM public.get_my_bets('test', v_round, v_round, 30, 0) AS b;
  IF COALESCE(jsonb_array_length(v_my_bets), 0) <> 1
     OR (v_my_bets->0->>'staked')::bigint <> 6
     OR (v_my_bets->0->>'won')::bigint <> 348
     OR (v_my_bets->0->>'pending_stake')::bigint <> 0
     OR jsonb_array_length(v_my_bets->0->'bet_types') <> 5
     OR NOT COALESCE(v_my_bets->0->'bet_types' @> jsonb_build_array(jsonb_build_object(
       'bet_type', 'single_open',
       'picks', jsonb_build_array(jsonb_build_object(
         'number', '6', 'stake', 1, 'status', 'won', 'payout', 9
       ))
     )), false)
     OR NOT COALESCE(v_my_bets->0->'bet_types' @> jsonb_build_array(jsonb_build_object(
       'bet_type', 'patti_open',
       'picks', jsonb_build_array(
         jsonb_build_object('number', '123-6', 'stake', 1, 'status', 'won', 'payout', 120),
         jsonb_build_object('number', '120-3', 'stake', 1, 'status', 'lost', 'payout', 0)
       )
     )), false) THEN
    RAISE EXCEPTION 'my bets did not return all bet types and exact per-round totals: %', v_my_bets;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  SELECT jsonb_agg(to_jsonb(b)) INTO v_my_bets
  FROM public.get_my_bets('test', v_round_other, v_round_other, 30, 0) AS b;
  IF COALESCE(jsonb_array_length(v_my_bets), 0) <> 1
     OR (v_my_bets->0->>'staked')::bigint <> 1
     OR (v_my_bets->0->>'won')::bigint <> 0
     OR (v_my_bets->0->>'pending_stake')::bigint <> 1
     OR jsonb_array_length(v_my_bets->0->'bet_types') <> 1
     OR NOT COALESCE(v_my_bets->0->'bet_types' @> jsonb_build_array(jsonb_build_object(
       'bet_type', 'single_open',
       'picks', jsonb_build_array(jsonb_build_object(
         'number', '6', 'stake', 1, 'status', 'pending', 'payout', 0
       ))
     )), false) THEN
    RAISE EXCEPTION 'my bets leaked another caller or failed to keep unpaid picks pending: %', v_my_bets;
  END IF;

  SELECT jsonb_agg(to_jsonb(r)) INTO v_result_history
  FROM public.get_result_history('test', 30, 0) AS r
  WHERE r.round_date = v_round;
  IF v_result_history IS NULL OR NOT v_result_history @> jsonb_build_array(jsonb_build_object(
    'round_date', v_round::text,
    'open_patti', '123',
    'open_digit', '6',
    'close_patti', '135',
    'close_digit', '9',
    'jodi', '69'
  )) THEN
    RAISE EXCEPTION 'result history did not return the posted round: %', v_result_history;
  END IF;

  -- Withdrawal minimum, deposit/turnover, one-pending, rejection refund, and ban checks.
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_user2, 100, 'approved', 'db-test-approved-deposit');
  UPDATE public.profiles SET wallet = 500, is_banned = false WHERE id = v_user2;
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);

  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(50, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Minimum withdrawal%' THEN
    RAISE EXCEPTION 'withdrawal minimum was not enforced: %', v_error;
  END IF;

  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(100, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  SELECT 100 - COALESCE(SUM(-delta), 0) INTO v_count
  FROM public.point_ledger WHERE user_id = v_user2 AND reason = 'selection_submit';
  IF v_error IS NULL OR v_error NOT ILIKE format('Wager %s more points before withdrawing.%%', v_count) THEN
    RAISE EXCEPTION 'deposit turnover requirement was not enforced (expected % remaining): %', v_count, v_error;
  END IF;

  INSERT INTO public.point_ledger (user_id, delta, reason)
  VALUES (v_user2, -100, 'selection_submit');
  PERFORM public.request_withdrawal(100, 'user@bank');
  SELECT id INTO v_withdrawal_id
  FROM public.withdrawals
  WHERE user_id = v_user2 AND status = 'pending';
  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(100, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%already have a withdrawal%' THEN
    RAISE EXCEPTION 'one-pending-withdrawal restriction was not enforced: %', v_error;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_process_withdrawal(v_withdrawal_id, 'rejected');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%rejection reason%' THEN
    RAISE EXCEPTION 'withdrawal rejection did not require a reason: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_process_withdrawal(v_withdrawal_id, 'rejected', repeat('x', 201));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%200 characters%' THEN
    RAISE EXCEPTION 'withdrawal rejection reason maximum length was not enforced: %', v_error;
  END IF;
  PERFORM public.admin_process_withdrawal(v_withdrawal_id, 'rejected', 'Incorrect payout details');
  IF (SELECT wallet FROM public.profiles WHERE id = v_user2) <> 500
     OR NOT EXISTS (
       SELECT 1 FROM public.point_ledger
       WHERE user_id = v_user2 AND reason = 'withdrawal_refund' AND delta = 100
     )
     OR (SELECT reject_reason FROM public.withdrawals WHERE id = v_withdrawal_id) <> 'Incorrect payout details' THEN
    RAISE EXCEPTION 'rejected withdrawal did not refund wallet balance and ledger';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.admin_action_log
  WHERE actor_id = v_admin
    AND action = 'reject_withdrawal'
    AND target_user_id = v_user2
    AND amount = 100;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'withdrawal rejection did not write exactly one audit row';
  END IF;

  UPDATE public.profiles SET terms_accepted_at = NULL WHERE id = v_user2;
  PERFORM set_config('request.jwt.claim.sub', v_user2::text, true);
  v_result := public.request_withdrawal(100, 'declined-terms@bank');
  SELECT id INTO v_withdrawal_id FROM public.withdrawals
  WHERE user_id = v_user2 AND status = 'pending'
    AND upi_id = 'declined-terms@bank';
  IF v_result->>'status' <> 'pending'
     OR (v_result->>'amount')::integer <> 100
     OR v_withdrawal_id IS NULL THEN
    RAISE EXCEPTION 'a user who declined terms could not withdraw an otherwise eligible balance: %', v_result;
  END IF;
  DELETE FROM public.withdrawals WHERE id = v_withdrawal_id;
  DELETE FROM public.point_ledger
  WHERE user_id = v_user2 AND reason = 'withdrawal_request'
    AND metadata->>'upi_id' = 'declined-terms@bank';
  UPDATE public.profiles SET wallet = 500, terms_accepted_at = now(), terms_version = 'test'
  WHERE id = v_user2;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM public.admin_set_app_setting('approval_time_note', 'Usually within 30 minutes');
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  IF public.get_app_setting('approval_time_note') <> 'Usually within 30 minutes' THEN
    RAISE EXCEPTION 'approval time note was not available to authenticated users';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.admin_get_settings();
  IF jsonb_array_length(v_result) <> 7
     OR NOT v_result @> jsonb_build_array(jsonb_build_object(
       'key', 'approval_time_note',
       'value', 'Usually within 30 minutes',
       'updated_by_display_name', 'DB test admin'
     ))
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result) AS setting_rows(row_data)
       WHERE row_data->>'key' = 'approval_time_note'
         AND row_data->>'updated_at' IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'admin settings RPC did not return the allowlisted setting audit metadata: %', v_result;
  END IF;
  PERFORM public.admin_add_blocked_domain('regression-check.invalid');
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_action_log
    WHERE actor_id = v_admin
      AND action = 'add_blocked_domain'
      AND metadata->>'domain' = 'regression-check.invalid'
  ) THEN
    RAISE EXCEPTION 'adding a blocked domain did not write an audit row';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  v_result := public.get_public_rules();
  IF (v_result->>'minimum_withdrawal')::integer <> 100
     OR (v_result->>'maximum_withdrawal')::integer <> 100000
     OR (v_result->>'approved_deposit_minimum')::integer <> 100
     OR (v_result->>'maximum_add_funds')::integer <> 100000
     OR (v_result->>'turnover_multiplier')::integer <> 1
     OR (v_result->>'maximum_bet')::integer <> 5000
     OR (v_result->>'maximum_submit')::integer <> 20000 THEN
    RAISE EXCEPTION 'public rules differ from shared internal constants: %', v_result;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_set_app_setting('approval_time_note', repeat('x', 121));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%120 characters%' THEN
    RAISE EXCEPTION 'approval time note length limit was not enforced: %', v_error;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user1::text, true);
  PERFORM public.request_add_funds(100, '123456789012', NULL);
  SELECT id INTO v_add_funds_id
  FROM public.add_funds_requests
  WHERE user_id = v_user1 AND status = 'pending';
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_process_add_funds(v_add_funds_id, 'rejected', 'no');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%rejection reason%' THEN
    RAISE EXCEPTION 'add-funds rejection did not require a minimum-length reason: %', v_error;
  END IF;
  PERFORM public.admin_process_add_funds(v_add_funds_id, 'rejected', 'Payment could not be verified');
  IF (SELECT reject_reason FROM public.add_funds_requests WHERE id = v_add_funds_id)
       <> 'Payment could not be verified' THEN
    RAISE EXCEPTION 'add-funds rejection reason was not stored';
  END IF;

  UPDATE public.profiles SET wallet = 500 WHERE id = v_user3;
  PERFORM set_config('request.jwt.claim.sub', v_user3::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(100, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%approved deposit%' THEN
    RAISE EXCEPTION 'withdrawal without an approved deposit was not blocked: %', v_error;
  END IF;

  UPDATE public.profiles SET is_banned = true WHERE id = v_user3;
  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(100, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%account is banned%' THEN
    RAISE EXCEPTION 'ban did not block withdrawal: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(100, 'db-test-banned-ref', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%account is banned%' THEN
    RAISE EXCEPTION 'ban did not block add-funds request: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"4","points":1}]'::jsonb, 'single_close');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%account is banned%' THEN
    RAISE EXCEPTION 'ban did not block selection submission: %', v_error;
  END IF;

  -- A non-admin authenticated caller must be rejected by the admin function body.
  UPDATE public.profiles SET is_banned = false WHERE id = v_user3;
  PERFORM set_config('request.jwt.claim.sub', v_user3::text, true);
  IF NOT (SELECT age_confirmed AND terms_accepted_at IS NOT NULL AND terms_version = 'test'
          FROM public.profiles WHERE id = v_user3) THEN
    RAISE EXCEPTION 'accepted signup terms were not stored on the profile';
  END IF;
  PERFORM public.set_my_limits(1000, 1000);
  PERFORM public.set_my_limits(500, 400);
  v_result := public.set_my_limits(800, NULL);
  IF (v_result->>'daily_deposit_limit')::integer <> 500
     OR (v_result->>'daily_loss_limit')::integer <> 400
     OR (v_result->>'pending_deposit_limit')::integer <> 800
     OR v_result->'pending_effective_at' = 'null'::jsonb THEN
    RAISE EXCEPTION 'limit increases/removals did not defer while lower limits applied immediately: %', v_result;
  END IF;
  v_result := public.set_my_limits(100, 100);
  IF (v_result->>'daily_deposit_limit')::integer <> 100
     OR (v_result->>'daily_loss_limit')::integer <> 100
     OR v_result->'pending_effective_at' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'lower limits did not take effect immediately: %', v_result;
  END IF;

  UPDATE public.profiles SET points = 1000, wallet = 0 WHERE id = v_user3;
  PERFORM public.request_add_funds(100, '123456789012', NULL);
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(1, '123456789013', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Daily deposit limit reached%' THEN
    RAISE EXCEPTION 'daily deposit limit including pending requests was not enforced: %', v_error;
  END IF;
  INSERT INTO public.point_ledger (user_id, delta, reason, created_at)
  VALUES
    (v_user3, -100, 'selection_submit', now()),
    (v_user3, 60, 'winning_payout', now());
  -- Earlier sections already staked for user3 today; allow exactly 10 more points of net loss.
  SELECT COALESCE(SUM(-delta), 0) INTO v_count
  FROM public.point_ledger
  WHERE user_id = v_user3 AND reason IN ('selection_submit', 'winning_payout')
    AND created_at >= ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
  PERFORM public.set_my_limits(NULL, (v_count + 10)::integer);
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"8","points":10}]'::jsonb, 'single_close');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NOT NULL THEN
    RAISE EXCEPTION 'IST daily net-loss did not subtract same-day winning payouts from stakes: %', v_error;
  END IF;
  v_result := public.set_my_limits(NULL, 1);
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"4","points":2}]'::jsonb, 'single_close');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Daily loss limit reached%' THEN
    RAISE EXCEPTION 'daily net-loss limit was not enforced: %', v_error;
  END IF;

  PERFORM public.start_cooldown(6);
  v_result := jsonb_build_object('until', public.start_cooldown(1));
  IF (v_result->>'until')::timestamptz < now() + interval '5 hours 59 minutes' THEN
    RAISE EXCEPTION 'a cooldown was shortened';
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_selection('test', '[{"number":"4","points":1}]'::jsonb, 'single_close');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Betting is paused%' THEN
    RAISE EXCEPTION 'active cooldown did not block betting: %', v_error;
  END IF;

  v_restriction_until := public.self_exclude(30);
  v_result := jsonb_build_object('until', public.self_exclude(7));
  IF (v_result->>'until')::timestamptz < v_restriction_until
     OR (v_result->>'until')::timestamptz < now() + interval '29 days 23 hours' THEN
    RAISE EXCEPTION 'self-exclusion did not start for the full selected term';
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(100, '123456789014', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%self-exclusion ends%' THEN
    RAISE EXCEPTION 'active self-exclusion did not block deposits: %', v_error;
  END IF;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_user3, 100, 'approved', 'db-test-exclusion-approved');
  UPDATE public.profiles SET wallet = 100 WHERE id = v_user3;
  INSERT INTO public.point_ledger (user_id, delta, reason)
  VALUES (v_user3, -100, 'selection_submit');
  v_error := NULL;
  BEGIN
    PERFORM public.request_withdrawal(100, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NOT NULL THEN
    RAISE EXCEPTION 'self-exclusion incorrectly blocked withdrawal: %', v_error;
  END IF;

  v_result := public.submit_support_ticket('other', NULL, 'Help me with this issue');
  IF v_result->>'status' <> 'open' THEN
    RAISE EXCEPTION 'support ticket was not opened: %', v_result;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_support_ticket('other', v_withdrawal_id, 'This is not my request');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Referenced request%' THEN
    RAISE EXCEPTION 'support ticket accepted a request belonging to another user: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_support_ticket('other', NULL, 'tiny');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%between 5 and 1000 characters%' THEN
    RAISE EXCEPTION 'support ticket accepted a message shorter than five characters: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_support_ticket('other', NULL, repeat('x', 1001));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%between 5 and 1000 characters%' THEN
    RAISE EXCEPTION 'support ticket accepted a message longer than 1000 characters: %', v_error;
  END IF;
  FOR v_loop IN 1..4 LOOP
    PERFORM public.submit_support_ticket('other', NULL, 'Follow-up issue report');
  END LOOP;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_support_ticket('other', NULL, 'Sixth daily issue report');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Daily support ticket limit reached%' THEN
    RAISE EXCEPTION 'support ticket daily cap did not reject the sixth report: %', v_error;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_close_ticket((v_result->>'id')::uuid, 'Reviewed');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM public.admin_action_log
    WHERE actor_id = v_admin AND action = 'close_support_ticket'
      AND metadata->>'ticket_id' = v_result->>'id'
  ) THEN
    RAISE EXCEPTION 'admin ticket close did not succeed and audit: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_list_support_tickets('open', NULL, 0);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Invalid pagination%' THEN
    RAISE EXCEPTION 'support ticket pagination accepted an unlimited null limit: %', v_error;
  END IF;

  IF has_table_privilege('authenticated', 'public.user_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_limits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_limits', 'DELETE')
     OR has_table_privilege('authenticated', 'public.support_tickets', 'INSERT')
     OR has_table_privilege('authenticated', 'public.support_tickets', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.support_tickets', 'DELETE')
     OR has_function_privilege('anon', 'public.get_my_limits()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.submit_support_ticket(text,uuid,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.user_ledger_opening_balances', 'SELECT')
     OR has_function_privilege('anon', 'public.admin_preview_result(text,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_get_user_detail(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_daily_report(date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_ledger_reconciliation()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_list_ledger_opening_balances()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_get_settings()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_preview_result(text,date,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_get_user_detail(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_daily_report(date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_ledger_reconciliation()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_list_ledger_opening_balances()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_get_settings()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.accept_terms(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'responsible-play or support RPC/table grants are too broad';
  END IF;

  v_result := public.admin_list_ledger_opening_balances();
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) AS legacy_rows(row_data)
    WHERE row_data->>'user_id' IN (v_admin::text, v_user1::text, v_user2::text, v_user3::text)
  ) THEN
    RAISE EXCEPTION 'a user created after the opening-balance migration appeared in the legacy report: %', v_result;
  END IF;

  SELECT COALESCE(opening_balance, 0) INTO v_opening_balance
  FROM public.user_ledger_opening_balances WHERE user_id = v_user3;
  DELETE FROM public.point_ledger WHERE user_id = v_user3;
  UPDATE public.profiles
  SET points = COALESCE(v_opening_balance, 0)::integer, wallet = 0
  WHERE id = v_user3;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.admin_ledger_reconciliation();
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) AS mismatch(row_data)
    WHERE row_data->>'user_id' = v_user3::text
  ) THEN
    RAISE EXCEPTION 'reconciled test fixture unexpectedly appears in mismatch report: %', v_result;
  END IF;
  UPDATE public.profiles SET points = points + 1 WHERE id = v_user3;
  v_result := public.admin_ledger_reconciliation();
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) AS mismatch(row_data)
    WHERE row_data->>'user_id' = v_user3::text
      AND (row_data->>'difference')::bigint = 1
  ) THEN
    RAISE EXCEPTION 'ledger reconciliation did not flag the deliberately corrupted fixture balance: %', v_result;
  END IF;
  UPDATE public.profiles SET points = points - 1 WHERE id = v_user3;

  PERFORM set_config('request.jwt.claim.sub', v_user3::text, true);
  DELETE FROM public.withdrawals
  WHERE user_id = v_user3 AND status = 'pending';
  DELETE FROM public.point_ledger
  WHERE user_id = v_user3 AND reason = 'withdrawal_request';
  UPDATE public.profiles
  SET wallet = 100, is_banned = false
  WHERE id = v_user3;
  INSERT INTO public.point_ledger (user_id, delta, reason)
  VALUES (v_user3, -100, 'selection_submit');
  UPDATE public.profiles SET terms_accepted_at = NULL, age_confirmed = false WHERE id = v_user3;
  FOREACH v_bet_type IN ARRAY ARRAY['single_close'] LOOP
    v_error := NULL;
    BEGIN
      PERFORM public.submit_selection('test', '[{"number":"8","points":1}]'::jsonb, v_bet_type);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    END;
    IF v_error IS NULL OR v_error NOT ILIKE '%accept the Terms%' THEN
      RAISE EXCEPTION 'terms-unaccepted user could submit a bet: %', v_error;
    END IF;
  END LOOP;
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(100, '123456789015', NULL);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%accept the Terms%' THEN
    RAISE EXCEPTION 'terms-unaccepted user could request a deposit: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    v_result := public.request_withdrawal(100, 'user@bank');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NOT NULL OR v_result->>'status' <> 'pending'
     OR (SELECT wallet FROM public.profiles WHERE id = v_user3) <> 0 THEN
    RAISE EXCEPTION 'terms-unaccepted user could not withdraw their own eligible balance: %, %', v_error, v_result;
  END IF;
  PERFORM public.accept_terms('test-restored');
  v_error := NULL;
  BEGIN
    PERFORM public.admin_get_settings();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%admin%' THEN
    RAISE EXCEPTION 'non-admin user invoked admin_get_settings: %', v_error;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_toggle_ban(v_user2);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%admin%' THEN
    RAISE EXCEPTION 'non-admin user invoked admin action: %', v_error;
  END IF;
  RAISE NOTICE 'database regression assertions passed';
END
$test$;

INSERT INTO public.user_limits (user_id)
VALUES
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.support_tickets (user_id, category, message)
VALUES
  ('00000000-0000-4000-8000-000000000002', 'other', 'RLS test fixture ticket'),
  ('00000000-0000-4000-8000-000000000003', 'other', 'RLS test fixture ticket');
INSERT INTO public.point_ledger (user_id, delta, reason)
VALUES
  ('00000000-0000-4000-8000-000000000002', 1, 'admin_adjust_wallet'),
  ('00000000-0000-4000-8000-000000000003', 1, 'admin_adjust_wallet');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000004', true);
DO $rls_test$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF EXISTS (SELECT 1 FROM public.selections WHERE user_id <> v_user)
     OR EXISTS (SELECT 1 FROM public.support_tickets WHERE user_id <> v_user)
     OR EXISTS (SELECT 1 FROM public.user_limits WHERE user_id <> v_user)
     OR EXISTS (SELECT 1 FROM public.point_ledger WHERE user_id <> v_user) THEN
    RAISE EXCEPTION 'authenticated user read another user''s bets, tickets, limits, or ledger rows';
  END IF;
END
$rls_test$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- E1 additions: admin guards, screenshot paths, storage, blocked domains.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES (
  '00000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated',
  'db-test-user5@example.invalid', '', now(), '{}',
  '{"display_name":"DB test user 5","accepted_terms":true,"terms_version":"test"}'
);

DO $e1_test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000001';
  v_user1 uuid := '00000000-0000-4000-8000-000000000002';
  v_user5 uuid := '00000000-0000-4000-8000-000000000005';
  v_error text;
  v_result jsonb;
  v_count bigint;
BEGIN
  -- admin_adjust_points: self-adjustment, +/-10000 cap, reason length.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_adjust_points(v_admin, 10, 'Self credit attempt', 'points');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%own balance%' THEN
    RAISE EXCEPTION 'admin self-adjustment was not blocked: %', v_error;
  END IF;
  FOREACH v_count IN ARRAY ARRAY[10001, -10001]::bigint[] LOOP
    v_error := NULL;
    BEGIN
      PERFORM public.admin_adjust_points(v_user1, v_count::integer, 'Cap check adjustment', 'wallet');
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    END;
    IF v_error IS NULL OR v_error NOT ILIKE '%cannot exceed 10000%' THEN
      RAISE EXCEPTION 'admin adjustment cap was not enforced for %: %', v_count, v_error;
    END IF;
  END LOOP;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_adjust_points(v_user1, 5, '  abc ', 'points');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%at least 5 characters%' THEN
    RAISE EXCEPTION 'admin adjustment reason length was not enforced: %', v_error;
  END IF;
  v_result := public.admin_adjust_points(v_user1, 10000, 'Maximum allowed credit', 'wallet');
  IF (v_result->>'delta')::integer <> 10000 THEN
    RAISE EXCEPTION 'admin adjustment at the cap was rejected: %', v_result;
  END IF;

  -- admin_set_admin: the last administrator cannot be removed.
  UPDATE public.profiles SET is_admin = (id = v_admin);
  v_error := NULL;
  BEGIN
    PERFORM public.admin_set_admin(v_admin, false);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%last administrator%' THEN
    RAISE EXCEPTION 'the last admin could be removed: %', v_error;
  END IF;

  -- admin_add_blocked_domain: bad domains are rejected and write no audit row.
  SELECT count(*) INTO v_count FROM public.admin_action_log WHERE action = 'add_blocked_domain';
  FOREACH v_error IN ARRAY ARRAY['', 'not a domain', '-bad.example', 'bad..example', 'bad_domain.example'] LOOP
    BEGIN
      PERFORM public.admin_add_blocked_domain(v_error);
      RAISE EXCEPTION 'accepted bad domain "%"', v_error USING ERRCODE = 'P0099';
    EXCEPTION
      WHEN SQLSTATE 'P0099' THEN RAISE;
      WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  IF (SELECT count(*) FROM public.admin_action_log WHERE action = 'add_blocked_domain') <> v_count THEN
    RAISE EXCEPTION 'a rejected blocked domain wrote an audit row';
  END IF;
  PERFORM public.admin_add_blocked_domain('  Throwaway-E1.Example ');
  IF NOT EXISTS (SELECT 1 FROM public.blocked_email_domains WHERE domain = 'throwaway-e1.example')
     OR (SELECT count(*) FROM public.admin_action_log
         WHERE action = 'add_blocked_domain' AND metadata->>'domain' = 'throwaway-e1.example') <> 1 THEN
    RAISE EXCEPTION 'valid blocked domain was not normalized, stored and audited once';
  END IF;

  -- request_add_funds: another user's screenshot path and reused screenshots are rejected.
  PERFORM set_config('request.jwt.claim.sub', v_user5::text, true);
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(100, 'E1WRONGUSER01', v_user1::text || '/proof.png');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%Invalid screenshot path%' THEN
    RAISE EXCEPTION 'add funds accepted another user''s screenshot path: %', v_error;
  END IF;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref, screenshot_path, reject_reason)
  VALUES (v_user5, 100, 'rejected', 'E1REUSED00001', v_user5::text || '/reused.png', 'Fixture rejection');
  v_error := NULL;
  BEGIN
    PERFORM public.request_add_funds(100, 'E1REUSED00002', v_user5::text || '/reused.png');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%already been used%' THEN
    RAISE EXCEPTION 'add funds accepted a reused screenshot: %', v_error;
  END IF;

  -- Storage: bucket limits and the upload/read/delete ownership policies.
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'payment-screenshots' AND NOT public
      AND file_size_limit = 5242880
      AND allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp']
      AND allowed_mime_types <@ ARRAY['image/jpeg', 'image/png', 'image/webp']
  ) THEN
    RAISE EXCEPTION 'payment screenshot bucket is public or has the wrong size/MIME limits';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND (policyname, cmd) IN (
      ('users_upload_own_screenshots', 'INSERT'),
      ('users_read_own_screenshots', 'SELECT'),
      ('users_delete_own_screenshots', 'DELETE')
    )
    AND COALESCE(qual, with_check) LIKE '%foldername(name))[1] = (auth.uid())::text%';
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 owner-scoped screenshot policies, found %', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'users_upload_own_screenshots'
      AND with_check LIKE '%add_funds_requests%pending%'
  ) THEN
    RAISE EXCEPTION 'screenshot upload policy no longer blocks uploads while a request is pending';
  END IF;

  -- Prepare user5 for the authenticated-role user-flow checks below.
  UPDATE public.profiles SET points = 0, wallet = 1000, is_banned = false WHERE id = v_user5;
  INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref)
  VALUES (v_user5, 100, 'approved', 'E1APPROVED001');
  UPDATE public.game_schedule
  SET bets_open = time '00:00', open_bets_close = time '23:59:59', close_bets_close = time '23:59:59'
  WHERE game = 'test';
END
$e1_test$;

-- Storage policies, evaluated as the authenticated role.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000005', true);
DO $storage_test$
DECLARE
  v_error text;
BEGIN
  INSERT INTO storage.objects (bucket_id, name, owner)
  VALUES ('payment-screenshots', '00000000-0000-4000-8000-000000000005/own.png', auth.uid());
  v_error := NULL;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner)
    VALUES ('payment-screenshots', '00000000-0000-4000-8000-000000000002/other.png', auth.uid());
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL OR v_error NOT ILIKE '%row-level security%' THEN
    RAISE EXCEPTION 'a user could upload into another user''s screenshot folder: %', v_error;
  END IF;
  IF (SELECT count(*) FROM storage.objects WHERE bucket_id = 'payment-screenshots') <> 1 THEN
    RAISE EXCEPTION 'screenshot read policy exposed objects outside the caller''s folder';
  END IF;
END
$storage_test$;

-- Main user flows as the authenticated role (not as the owner).
DO $user_flow_test$
DECLARE
  v_result jsonb;
  v_bets jsonb;
  v_error text;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'user-flow checks must run as authenticated, not %', current_user;
  END IF;
  v_result := public.submit_selection('test', '[{"number":"7","points":100}]'::jsonb, 'single_open');
  IF (v_result->>'new_points')::integer <> 100 OR (v_result->>'wallet')::integer <> 900 THEN
    RAISE EXCEPTION 'authenticated bet did not debit the wallet: %', v_result;
  END IF;
  SELECT jsonb_agg(to_jsonb(b)) INTO v_bets FROM public.get_my_bets('test', NULL, NULL, 30, 0) AS b;
  IF jsonb_array_length(v_bets) <> 1
     OR (v_bets->0->>'staked')::integer <> 100
     OR (v_bets->0->>'pending_stake')::integer <> 100 THEN
    RAISE EXCEPTION 'authenticated get_my_bets returned unexpected rows: %', v_bets;
  END IF;
  v_result := public.request_add_funds(200, 'E1AUTHDEPOSIT1', NULL);
  IF v_result->>'status' <> 'pending' THEN
    RAISE EXCEPTION 'authenticated deposit request failed: %', v_result;
  END IF;
  v_result := public.request_withdrawal(150, 'e1-user@bank');
  IF v_result->>'status' <> 'pending' OR (v_result->>'remaining_wallet')::integer <> 750 THEN
    RAISE EXCEPTION 'authenticated withdrawal request failed: %', v_result;
  END IF;
  v_error := NULL;
  BEGIN
    PERFORM public.admin_get_stats(NULL);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
  END;
  IF v_error IS NULL THEN
    RAISE EXCEPTION 'a non-admin authenticated user could read admin stats';
  END IF;
END
$user_flow_test$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- R3: balance, amount, status and ledger constraints hold even for direct SQL.
-- ---------------------------------------------------------------------------
DO $r3_test$
DECLARE
  v_user1 uuid := '00000000-0000-4000-8000-000000000002';
  v_state text;
  v_constraint text;
  v_statement text;
BEGIN
  FOREACH v_statement IN ARRAY ARRAY[
    format('UPDATE public.profiles SET wallet = -1 WHERE id = %L', v_user1),
    format('UPDATE public.profiles SET points = -1 WHERE id = %L', v_user1),
    format('INSERT INTO public.withdrawals (user_id, amount, status, upi_id) VALUES (%L, 0, %L, %L)', v_user1, 'rejected', 'r3@bank'),
    format('INSERT INTO public.withdrawals (user_id, amount, status, upi_id) VALUES (%L, 10, %L, %L)', v_user1, 'paid', 'r3@bank'),
    format('INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref) VALUES (%L, -5, %L, %L)', v_user1, 'rejected', 'R3NEGATIVE1'),
    format('INSERT INTO public.add_funds_requests (user_id, amount, status, payment_ref) VALUES (%L, 5, %L, %L)', v_user1, 'done', 'R3BADSTATUS1'),
    format('INSERT INTO public.point_ledger (user_id, delta, reason) VALUES (%L, 0, %L)', v_user1, 'add_funds'),
    format('INSERT INTO public.point_ledger (user_id, delta, reason) VALUES (%L, 5, %L)', v_user1, 'made_up_reason')
  ] LOOP
    v_state := NULL;
    BEGIN
      EXECUTE v_statement;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_constraint = CONSTRAINT_NAME;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN
      RAISE EXCEPTION 'R3: statement was not rejected by a check constraint: %', v_statement;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN (
      'profiles_points_nonnegative', 'profiles_wallet_nonnegative',
      'withdrawals_amount_positive', 'withdrawals_status_valid',
      'add_funds_requests_amount_positive', 'add_funds_requests_status_valid',
      'point_ledger_delta_nonzero', 'point_ledger_reason_valid')
      AND NOT convalidated
  ) OR (
    SELECT count(*) FROM pg_constraint
    WHERE conname IN (
      'profiles_points_nonnegative', 'profiles_wallet_nonnegative',
      'withdrawals_amount_positive', 'withdrawals_status_valid',
      'add_funds_requests_amount_positive', 'add_funds_requests_status_valid',
      'point_ledger_delta_nonzero', 'point_ledger_reason_valid')
  ) <> 8 THEN
    RAISE EXCEPTION 'R3: a money constraint is missing or still NOT VALID';
  END IF;
END
$r3_test$;

-- ---------------------------------------------------------------------------
-- R4: deleting an Auth user with financial history fails (ON DELETE RESTRICT);
-- a user without history can still be deleted.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES
  ('00000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated',
   'db-test-user6@example.invalid', '', now(), '{}',
   '{"display_name":"DB test user 6","accepted_terms":true,"terms_version":"test"}'),
  ('00000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated',
   'db-test-user7@example.invalid', '', NULL, '{}',
   '{"display_name":"DB test user 7","accepted_terms":true,"terms_version":"test"}');

DO $r4_test$
DECLARE
  v_user6 uuid := '00000000-0000-4000-8000-000000000006';
  v_user7 uuid := '00000000-0000-4000-8000-000000000007';
  v_state text;
  v_table text;
BEGIN
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (v_user6, 5, 'admin_adjust_wallet', '{"test":"r4"}');

  v_state := NULL;
  BEGIN
    DELETE FROM auth.users WHERE id = v_user6;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23503' THEN
    RAISE EXCEPTION 'R4: deleting a user with ledger rows was not blocked';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.point_ledger WHERE user_id = v_user6)
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user6) THEN
    RAISE EXCEPTION 'R4: a blocked delete still removed the user''s rows';
  END IF;

  IF EXISTS (SELECT 1 FROM public.point_ledger WHERE user_id = v_user7) THEN
    RAISE EXCEPTION 'R4 fixture: unconfirmed user 7 unexpectedly has ledger rows';
  END IF;
  DELETE FROM auth.users WHERE id = v_user7;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user7) THEN
    RAISE EXCEPTION 'R4: deleting a user without history did not cascade to profiles';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['point_ledger', 'withdrawals', 'add_funds_requests', 'selections'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = format('public.%I', v_table)::regclass
        AND c.confrelid = 'auth.users'::regclass
        AND c.confdeltype = 'r'
    ) THEN
      RAISE EXCEPTION 'R4: public.% user_id foreign key is not ON DELETE RESTRICT', v_table;
    END IF;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['profiles', 'user_limits', 'support_tickets', 'user_ledger_opening_balances'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = format('public.%I', v_table)::regclass
        AND c.confrelid = 'auth.users'::regclass
        AND c.confdeltype = 'c'
    ) THEN
      RAISE EXCEPTION 'R4: public.% should keep ON DELETE CASCADE', v_table;
    END IF;
  END LOOP;
END
$r4_test$;

-- ---------------------------------------------------------------------------
-- R6: settlement, the liability check and exposure all use bet_multiplier().
-- ---------------------------------------------------------------------------
DO $r6_test$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000001';
  v_bet_type text;
  v_error text;
  v_def text;
  v_function text;
  v_exposure jsonb;
  v_row jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Settlement: every payout written by settle_bets used bet_multiplier().
  IF NOT EXISTS (SELECT 1 FROM public.point_ledger WHERE reason = 'winning_payout' AND metadata ? 'multiplier') THEN
    RAISE EXCEPTION 'R6: earlier settlement tests produced no payouts to compare';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.point_ledger
    WHERE reason = 'winning_payout' AND metadata ? 'multiplier'
      AND (metadata->>'multiplier')::integer IS DISTINCT FROM public.bet_multiplier(metadata->>'bet_type')
  ) THEN
    RAISE EXCEPTION 'R6: a settlement payout used a multiplier different from bet_multiplier()';
  END IF;
  FOREACH v_bet_type IN ARRAY ARRAY['single_open', 'single_close', 'jodi', 'patti_open', 'patti_close'] LOOP
    v_error := NULL;
    BEGIN
      PERFORM public.settle_bets('test', date '2000-01-01', v_bet_type, '0', public.bet_multiplier(v_bet_type) + 1);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    END;
    IF v_error IS NULL OR v_error NOT LIKE 'Multiplier % does not match bet_multiplier%' THEN
      RAISE EXCEPTION 'R6: settle_bets accepted a multiplier that differs from bet_multiplier(%)', v_bet_type;
    END IF;
  END LOOP;

  -- Liability check and exposure: no hard-coded payout multipliers remain.
  FOREACH v_function IN ARRAY ARRAY[
    'public.submit_selection(text, jsonb, text)',
    'public.admin_get_exposure(text, date)',
    'public.process_open_payouts(text, date)',
    'public.process_close_payouts(text, date)'
  ] LOOP
    v_def := pg_get_functiondef(v_function::regprocedure);
    IF v_def !~ 'bet_multiplier\(' OR v_def ~ 'THEN (9|90|120)\M' OR v_def ~ ', (9|90|120)\)' THEN
      RAISE EXCEPTION 'R6: % does not take its multiplier from bet_multiplier()', v_function;
    END IF;
  END LOOP;

  v_exposure := public.admin_get_exposure('test', (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date - 2);
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_exposure->'exposure') LOOP
    IF (v_row->>'potential_payout')::bigint
       <> (v_row->>'total_stake')::bigint * public.bet_multiplier(v_row->>'bet_type') THEN
      RAISE EXCEPTION 'R6: exposure payout differs from stake * bet_multiplier(): %', v_row;
    END IF;
  END LOOP;
END
$r6_test$;

-- ---------------------------------------------------------------------------
-- R7: get_public_rules exposes the current terms version; users who accepted
-- an older version can still bet and deposit (only the frontend re-asks).
-- ---------------------------------------------------------------------------
DO $r7_test$
DECLARE
  v_rules jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
  v_rules := public.get_public_rules();
  IF v_rules->>'current_terms_version' IS DISTINCT FROM '2026-11-10' THEN
    RAISE EXCEPTION 'R7: get_public_rules current_terms_version is %, expected 2026-11-10 (src/lib/terms.ts)', v_rules->>'current_terms_version';
  END IF;
END
$r7_test$;

ROLLBACK;
