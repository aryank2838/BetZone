-- Run this audit as the postgres role (e.g. psql "$DB_URL" -U postgres -f ...).
-- information_schema.routines.routine_definition is NULL for functions you do
-- not own, so this audit checks catalog privileges (has_function_privilege,
-- pg_default_acl) instead of function source.
-- Expected result: the DO block raises nothing and both result queries return
-- zero rows. Every function anon/authenticated can execute must be listed in
-- the allowlist below; anon must have none.
SET ROLE postgres;
DROP TABLE IF EXISTS pg_temp.function_execute_allowlist;
CREATE TEMP TABLE function_execute_allowlist (
  grantee name NOT NULL,
  routine_name name NOT NULL,
  PRIMARY KEY (grantee, routine_name)
);
INSERT INTO function_execute_allowlist (grantee, routine_name) VALUES
  ('authenticated', 'accept_terms'),
  ('authenticated', 'admin_add_blocked_domain'),
  ('authenticated', 'admin_adjust_points'),
  ('authenticated', 'admin_close_ticket'),
  ('authenticated', 'admin_daily_report'),
  ('authenticated', 'admin_get_exposure'),
  ('authenticated', 'admin_get_settings'),
  ('authenticated', 'admin_get_stats'),
  ('authenticated', 'admin_get_user_detail'),
  ('authenticated', 'admin_ledger_reconciliation'),
  ('authenticated', 'admin_list_add_funds'),
  ('authenticated', 'admin_list_ledger_opening_balances'),
  ('authenticated', 'admin_list_selections'),
  ('authenticated', 'admin_list_support_tickets'),
  ('authenticated', 'admin_list_users'),
  ('authenticated', 'admin_list_withdrawals'),
  ('authenticated', 'admin_post_close_result'),
  ('authenticated', 'admin_post_open_result'),
  ('authenticated', 'admin_preview_result'),
  ('authenticated', 'admin_process_add_funds'),
  ('authenticated', 'admin_process_withdrawal'),
  ('authenticated', 'admin_set_admin'),
  ('authenticated', 'admin_set_app_setting'),
  ('authenticated', 'admin_toggle_ban'),
  ('authenticated', 'award_ad_reward'),
  ('authenticated', 'get_ad_reward_status'),
  ('authenticated', 'get_all_latest_results'),
  ('authenticated', 'get_app_setting'),
  ('authenticated', 'get_balance_breakdown'),
  ('authenticated', 'get_game_status'),
  ('authenticated', 'get_latest_results'),
  ('authenticated', 'get_my_bets'),
  ('authenticated', 'get_my_limits'),
  ('authenticated', 'get_public_rules'),
  ('authenticated', 'get_result_history'),
  ('authenticated', 'get_wallet_status'),
  ('authenticated', 'is_current_user_admin'),
  ('authenticated', 'is_valid_patti'),
  ('authenticated', 'is_valid_patti_combo'),
  ('authenticated', 'patti_digit'),
  ('authenticated', 'request_add_funds'),
  ('authenticated', 'request_withdrawal'),
  ('authenticated', 'self_exclude'),
  ('authenticated', 'set_my_limits'),
  ('authenticated', 'start_cooldown'),
  ('authenticated', 'submit_selection'),
  ('authenticated', 'submit_support_ticket');

DO $audit$
DECLARE
  v_unexpected text;
  v_count bigint;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'function privilege audit must run as postgres; current role is %', current_user;
  END IF;

  WITH executable AS (
    SELECT 'anon'::name AS grantee, p.proname AS routine_name, p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
    UNION ALL
    SELECT 'authenticated', p.proname, p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )
  SELECT string_agg(format('%s can execute public.%s', e.grantee, e.routine_name), ', ')
  INTO v_unexpected
  FROM executable e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_temp.function_execute_allowlist a
    WHERE a.grantee = e.grantee AND a.routine_name = e.routine_name
  );
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'public function EXECUTE grants are not allowlisted: %', v_unexpected;
  END IF;

  SELECT string_agg(
    format('creator %s has EXECUTE default for %s', creator.rolname, COALESCE(grantee.rolname, 'PUBLIC')),
    ', '
  )
  INTO v_unexpected
  FROM pg_default_acl d
  JOIN pg_roles creator ON creator.oid = d.defaclrole
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE d.defaclobjtype = 'f'
    AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
    AND acl.privilege_type = 'EXECUTE'
    AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
    AND pg_has_role(current_user, d.defaclrole, 'MEMBER');
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'public function default privileges still grant EXECUTE: %', v_unexpected;
  END IF;

  -- Roles postgres cannot administer (on hosted Supabase: the platform role
  -- supabase_admin). Migrations never run as these roles, so this is reported only.
  SELECT string_agg(DISTINCT creator.rolname, ', ')
  INTO v_unexpected
  FROM pg_default_acl d
  JOIN pg_roles creator ON creator.oid = d.defaclrole
  CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
  LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE d.defaclobjtype = 'f'
    AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
    AND acl.privilege_type = 'EXECUTE'
    AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
    AND NOT pg_has_role(current_user, d.defaclrole, 'MEMBER');
  IF v_unexpected IS NOT NULL THEN
    RAISE NOTICE 'not checked (role not administrable by %): default EXECUTE grants of %', current_user, v_unexpected;
  END IF;

  -- Without a global (schema 0) entry, PostgreSQL's built-in default grants
  -- EXECUTE to PUBLIC on every new function, which anon inherits.
  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclrole = 'postgres'::regrole
      AND d.defaclnamespace = 0
      AND d.defaclobjtype = 'f'
      AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) acl WHERE acl.grantee = 0)
  ) THEN
    RAISE EXCEPTION 'postgres has no global default ACL revoking EXECUTE on new functions from PUBLIC';
  END IF;

  -- Behavioural check: a function created now must not be executable by clients.
  EXECUTE 'CREATE FUNCTION public.zz_privilege_audit_probe() RETURNS integer LANGUAGE sql AS ''SELECT 1''';
  IF has_function_privilege('anon', 'public.zz_privilege_audit_probe()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.zz_privilege_audit_probe()', 'EXECUTE') THEN
    EXECUTE 'DROP FUNCTION public.zz_privilege_audit_probe()';
    RAISE EXCEPTION 'a newly created public function is executable by anon or authenticated';
  END IF;
  EXECUTE 'DROP FUNCTION public.zz_privilege_audit_probe()';

  SELECT count(*) INTO v_count FROM pg_temp.function_execute_allowlist;
  RAISE NOTICE 'function privilege audit passed (% allowlisted grants)', v_count;
END;
$audit$;

WITH executable AS (
  SELECT 'anon'::name AS grantee, p.proname AS routine_name, p.oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
  UNION ALL
  SELECT 'authenticated', p.proname, p.oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
)
-- Expected: zero rows (any row is a client-executable function missing from the allowlist).
SELECT e.grantee, e.routine_name, e.oid::regprocedure AS routine_signature
FROM executable e
WHERE NOT EXISTS (
  SELECT 1 FROM pg_temp.function_execute_allowlist a
  WHERE a.grantee = e.grantee AND a.routine_name = e.routine_name
)
ORDER BY e.grantee, e.routine_name, routine_signature;

SELECT creator.rolname AS creator_role,
       COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
       acl.privilege_type
FROM pg_default_acl d
JOIN pg_roles creator ON creator.oid = d.defaclrole
CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE d.defaclobjtype = 'f'
  AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
  AND acl.privilege_type = 'EXECUTE'
  AND (acl.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
  AND pg_has_role(current_user, d.defaclrole, 'MEMBER')
ORDER BY creator.rolname, grantee;

RESET ROLE;
