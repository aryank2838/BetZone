/*
# Sign up now, verify the email once before the first withdrawal

Players get into the app straight after signing up; the Supabase "Confirm
email" setting is turned off. Their email is verified once, with a 6-digit
code, before their first withdrawal.

1. profiles.email_verified_at: when the player proved they own their email.
   Players cannot write it (they can only update display_name).
   Existing players who already confirmed their email are marked verified.
2. mark_email_verified(): the app calls this after the player enters the code
   (supabase.auth.verifyOtp). It only works from a session that was started
   with an email code or email link (the JWT "amr" claim), so a password
   login cannot mark itself verified.
3. request_withdrawal() refuses until the email is verified (EMAIL_NOT_VERIFIED).
4. admin_mark_email_verified(): the admin can verify a player by hand, for
   example when the player cannot find the email. Logged in admin_action_log.
5. Changing the account email clears the verification.
6. Old sign-ups that never confirmed are let in (email_confirmed_at is set),
   but stay unverified, as under the new flow.
7. The daily clean-up now removes accounts that never verified, are over 30
   days old, have not logged in for 30 days, and have no money or bets
   (RESTRICT foreign keys skip those). This frees emails typed by mistake.

Order when deploying: push this migration first, then turn off
Authentication -> Providers -> Email -> "Confirm email".
*/

-- 1. The flag ----------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

UPDATE public.profiles p
SET email_verified_at = u.email_confirmed_at
FROM auth.users u
WHERE u.id = p.id
  AND u.email_confirmed_at IS NOT NULL
  AND p.email_verified_at IS NULL;

-- 6. Let old unconfirmed sign-ups log in (they stay unverified).
UPDATE auth.users
SET email_confirmed_at = now()
WHERE email_confirmed_at IS NULL
  AND email IS NOT NULL
  AND NOT COALESCE(is_sso_user, false)
  AND NOT COALESCE(is_anonymous, false);

-- 2. Player marks their own email verified -----------------------------------
-- Sessions started from an email (code or link) carry one of these methods.
-- "email/signup" is left out on purpose: with "Confirm email" off it is not
-- proof of owning the inbox.
CREATE OR REPLACE FUNCTION public.session_proves_email()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(auth.jwt()->'amr') = 'array' THEN auth.jwt()->'amr' ELSE '[]'::jsonb END
    ) AS claim(item)
    WHERE claim.item->>'method' IN ('otp', 'magiclink', 'recovery')
  );
$$;
REVOKE EXECUTE ON FUNCTION public.session_proves_email() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mark_email_verified()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_verified_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.session_proves_email() THEN
    RAISE EXCEPTION 'EMAIL_CODE_REQUIRED';
  END IF;
  UPDATE public.profiles
  SET email_verified_at = COALESCE(email_verified_at, now())
  WHERE id = v_uid
  RETURNING email_verified_at INTO v_verified_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  RETURN jsonb_build_object('email_verified_at', v_verified_at);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_email_verified() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_email_verified() TO authenticated;

-- 3. Withdrawals need a verified email ---------------------------------------
CREATE OR REPLACE FUNCTION public.request_withdrawal(p_amount integer, p_upi_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_wallet integer;
  v_banned boolean;
  v_email_verified_at timestamptz;
  v_pending_count integer;
  v_approved_deposits bigint;
  v_wagered_turnover bigint;
  v_remaining_turnover bigint;
  v_rules jsonb;
  v_min_withdrawal integer;
  v_max_withdrawal integer;
  v_approved_deposit_minimum integer;
  v_turnover_multiplier integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  v_rules := public.internal_rule_constants();
  v_min_withdrawal := (v_rules->>'minimum_withdrawal')::integer;
  v_max_withdrawal := (v_rules->>'maximum_withdrawal')::integer;
  v_approved_deposit_minimum := (v_rules->>'approved_deposit_minimum')::integer;
  v_turnover_multiplier := (v_rules->>'turnover_multiplier')::integer;
  SELECT wallet, is_banned, email_verified_at INTO v_wallet, v_banned, v_email_verified_at
  FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;
  IF v_email_verified_at IS NULL THEN RAISE EXCEPTION 'EMAIL_NOT_VERIFIED'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be a positive whole number'; END IF;
  IF p_amount < v_min_withdrawal THEN RAISE EXCEPTION 'Minimum withdrawal is % points.', v_min_withdrawal; END IF;
  IF p_amount > v_max_withdrawal THEN RAISE EXCEPTION 'Maximum withdrawal is % points.', v_max_withdrawal; END IF;
  IF p_upi_id IS NULL OR trim(p_upi_id) !~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'Enter a valid UPI ID in the format username@provider.';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_approved_deposits
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'approved';
  IF v_approved_deposits < v_approved_deposit_minimum THEN
    RAISE EXCEPTION 'Add at least % approved deposit points before requesting a withdrawal.', v_approved_deposit_minimum;
  END IF;
  SELECT COALESCE(SUM(ABS(delta::bigint)), 0) INTO v_wagered_turnover
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'selection_submit';
  v_remaining_turnover := GREATEST(
    v_approved_deposits * v_turnover_multiplier - v_wagered_turnover, 0
  );
  IF v_remaining_turnover > 0 THEN
    RAISE EXCEPTION 'Wager % more points before withdrawing. Required turnover: % points; completed: % points.',
      v_remaining_turnover, v_approved_deposits * v_turnover_multiplier, v_wagered_turnover;
  END IF;
  SELECT count(*) INTO v_pending_count FROM public.withdrawals
  WHERE user_id = v_uid AND status = 'pending';
  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'You already have a withdrawal awaiting admin approval. Wait for it to be processed before requesting another.';
  END IF;
  IF v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient wallet balance. You have %, requested %.', v_wallet, p_amount;
  END IF;
  UPDATE public.profiles SET wallet = wallet - p_amount WHERE id = v_uid;
  INSERT INTO public.withdrawals (user_id, amount, status, upi_id)
  VALUES (v_uid, p_amount, 'pending', trim(p_upi_id));
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -p_amount, 'withdrawal_request', jsonb_build_object('upi_id', trim(p_upi_id)));
  SELECT wallet INTO v_wallet FROM public.profiles WHERE id = v_uid;
  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount, 'remaining_wallet', v_wallet);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.request_withdrawal(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_withdrawal(integer, text) TO authenticated;

-- 4. Admin verifies by hand ---------------------------------------------------
ALTER TABLE public.admin_action_log
  DROP CONSTRAINT IF EXISTS admin_action_log_action_check;
ALTER TABLE public.admin_action_log
  ADD CONSTRAINT admin_action_log_action_check
  CHECK (action IN (
    'ban', 'unban', 'grant_admin', 'revoke_admin',
    'adjust_points', 'adjust_wallet',
    'approve_withdrawal', 'reject_withdrawal',
    'approve_add_funds', 'reject_add_funds',
    'post_open_result', 'post_close_result', 'set_setting',
    'close_support_ticket', 'add_blocked_domain',
    'set_holiday', 'end_holiday',
    'set_sport_settings', 'void_sport_event', 'settle_sport_event',
    'verify_email'
  ));

CREATE OR REPLACE FUNCTION public.admin_mark_email_verified(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_verified_at timestamptz;
  v_was_verified boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
  SELECT email_verified_at IS NOT NULL INTO v_was_verified
  FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  UPDATE public.profiles
  SET email_verified_at = COALESCE(email_verified_at, now())
  WHERE id = p_user_id
  RETURNING email_verified_at INTO v_verified_at;
  IF NOT v_was_verified THEN
    INSERT INTO public.admin_action_log (actor_id, target_user_id, action, metadata)
    VALUES (v_uid, p_user_id, 'verify_email', '{}'::jsonb);
  END IF;
  RETURN jsonb_build_object('email_verified_at', v_verified_at);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_mark_email_verified(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_email_verified(uuid) TO authenticated;

-- The admin user page shows the email and whether it is verified.
CREATE OR REPLACE FUNCTION public.admin_get_user_detail(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile jsonb;
  v_limits jsonb;
  v_ledger jsonb;
  v_bets jsonb;
  v_deposits jsonb;
  v_withdrawals jsonb;
  v_tickets jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;
  SELECT jsonb_build_object(
    'id', p.id, 'display_name', p.display_name, 'points', p.points, 'wallet', p.wallet,
    'is_admin', p.is_admin, 'is_banned', p.is_banned, 'created_at', p.created_at,
    'age_confirmed', p.age_confirmed, 'terms_accepted_at', p.terms_accepted_at,
    'terms_version', p.terms_version,
    'email', u.email, 'email_verified_at', p.email_verified_at
  ) INTO v_profile
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = p_user_id;
  IF v_profile IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT to_jsonb(l) INTO v_limits FROM public.user_limits l WHERE l.user_id = p_user_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_ledger FROM (
    SELECT id, delta, reason, metadata, created_at FROM public.point_ledger
    WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 100
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_bets FROM (
    SELECT id, game, round_date, bet_type, selections, total_points, created_at, updated_at
    FROM public.selections WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_deposits FROM (
    SELECT id, amount, status, payment_ref, created_at, processed_at, reject_reason
    FROM public.add_funds_requests WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_withdrawals FROM (
    SELECT id, amount, status, upi_id, created_at, processed_at, reject_reason
    FROM public.withdrawals WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_tickets FROM (
    SELECT id, category, request_ref, message, status, admin_note, created_at, closed_at
    FROM public.support_tickets WHERE user_id = p_user_id
    ORDER BY created_at DESC LIMIT 50
  ) row_data;
  RETURN jsonb_build_object(
    'profile', v_profile, 'limits', v_limits, 'ledger', v_ledger, 'bets', v_bets,
    'deposits', v_deposits, 'withdrawals', v_withdrawals, 'tickets', v_tickets
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO authenticated;

-- 5. A new email has to be verified again -------------------------------------
CREATE OR REPLACE FUNCTION public.handle_user_email_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.profiles SET email_verified_at = NULL WHERE id = NEW.id;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_user_email_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (lower(OLD.email) IS DISTINCT FROM lower(NEW.email))
  EXECUTE FUNCTION public.handle_user_email_changed();

-- 7. Clean-up of accounts that never verified ---------------------------------
CREATE OR REPLACE FUNCTION public.unconfirmed_user_retention_days()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 30 $$;
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
  v_cutoff timestamptz := now() - make_interval(days => public.unconfirmed_user_retention_days());
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Invalid limit';
  END IF;

  FOR v_user IN
    SELECT u.id
    FROM auth.users u
    JOIN public.profiles p ON p.id = u.id
    WHERE p.email_verified_at IS NULL
      AND NOT p.is_admin
      AND u.created_at < v_cutoff
      AND COALESCE(u.last_sign_in_at, u.created_at) < v_cutoff
      AND NOT COALESCE(u.is_sso_user, false)
      AND NOT COALESCE(u.is_anonymous, false)
    ORDER BY u.created_at
    LIMIT p_limit
  LOOP
    BEGIN
      -- Bets, deposits, withdrawals and ledger rows use RESTRICT foreign
      -- keys, so an account with any money history is skipped, not deleted.
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
