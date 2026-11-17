/*
Delete sign-ups that never confirmed their email.

An account whose email is still unconfirmed 14 days after sign-up is removed.
Deleting the auth user also deletes its profile (ON DELETE CASCADE), which
frees the email: check_signup_email() only blocks emails that still have a
profile, so the person can sign up again with the same address.

Unconfirmed users cannot log in, so they never have bets, deposits or ledger
rows. If one somehow does, the RESTRICT foreign keys stop that delete, and the
user is skipped (not deleted) instead of failing the whole run.

Runs every day at 03:30 IST (22:00 UTC) through pg_cron.
*/

CREATE OR REPLACE FUNCTION public.unconfirmed_user_retention_days()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 14 $$;
REVOKE EXECUTE ON FUNCTION public.unconfirmed_user_retention_days()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.delete_stale_unconfirmed_users(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user record;
  v_deleted integer := 0;
  v_skipped integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Invalid limit';
  END IF;

  FOR v_user IN
    SELECT u.id
    FROM auth.users u
    WHERE u.email_confirmed_at IS NULL
      AND u.confirmed_at IS NULL
      AND u.created_at < now() - make_interval(days => public.unconfirmed_user_retention_days())
      AND NOT COALESCE(u.is_sso_user, false)
      AND NOT COALESCE(u.is_anonymous, false)
      -- never touch an admin
      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id AND p.is_admin)
    ORDER BY u.created_at
    LIMIT p_limit
  LOOP
    BEGIN
      DELETE FROM auth.users WHERE id = v_user.id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_stale_unconfirmed_users(integer)
  FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'delete-stale-unconfirmed-users') THEN
    PERFORM cron.unschedule('delete-stale-unconfirmed-users');
  END IF;
  PERFORM cron.schedule(
    'delete-stale-unconfirmed-users',
    '0 22 * * *',
    $job$ SELECT public.delete_stale_unconfirmed_users(); $job$
  );
END;
$cron$;
