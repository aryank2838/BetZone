/*
# Refer a friend

Every player has a short invite code (profiles.referral_code) and a link
https://<site>/?ref=CODE. A friend who signs up with that code is recorded
in profiles.referred_by (set once, at sign-up; players cannot change it).

When the friend's FIRST deposit is approved, the inviter gets 10% of it as
play balance (bet only, not withdrawable; winnings from it are, as usual):
  - only if that deposit is at least 100, so the smallest reward is 10
  - at most 200 per friend
  - at most 20 rewarded friends per inviter in any 30 days (more are
    recorded with reward 0 and status 'capped', so the admin can see them)
  - nothing if the inviter is banned or an admin
Each friend can earn their inviter a reward only once (referral_rewards is
unique per friend). The reward is a 'referral_bonus' ledger row, and the
inviter gets a push notification when they have them turned on.

The friend's own 5% first-deposit bonus is unchanged.
*/

-- 1. Codes ----------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- No 0/O or 1/I, so codes are easy to read out and type.
CREATE OR REPLACE FUNCTION public.new_referral_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
BEGIN
  LOOP
    SELECT string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1), '')
    INTO v_code
    FROM generate_series(1, 6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE referral_code = v_code);
  END LOOP;
  RETURN v_code;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.new_referral_code() FROM PUBLIC, anon, authenticated;

DO $backfill$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.profiles WHERE referral_code IS NULL LOOP
    UPDATE public.profiles SET referral_code = public.new_referral_code() WHERE id = v_id;
  END LOOP;
END;
$backfill$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_referral_code_key ON public.profiles (referral_code);
ALTER TABLE public.profiles ALTER COLUMN referral_code SET NOT NULL;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_referral_code_format;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_referral_code_format CHECK (referral_code ~ '^[A-Z2-9]{6}$');
CREATE INDEX IF NOT EXISTS profiles_referred_by_idx ON public.profiles (referred_by) WHERE referred_by IS NOT NULL;

-- A new profile gets its code, and its inviter from the sign-up metadata
-- ("referral_code"). A wrong or unknown code is ignored: it never blocks a sign-up.
CREATE OR REPLACE FUNCTION public.profiles_set_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_given text;
BEGIN
  IF NEW.referral_code IS NULL THEN
    NEW.referral_code := public.new_referral_code();
  END IF;
  SELECT upper(btrim(u.raw_user_meta_data->>'referral_code')) INTO v_given
  FROM auth.users u WHERE u.id = NEW.id;
  IF v_given ~ '^[A-Z2-9]{6}$' THEN
    SELECT p.id INTO NEW.referred_by
    FROM public.profiles p
    WHERE p.referral_code = v_given AND p.id <> NEW.id;
  ELSE
    NEW.referred_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.profiles_set_referral() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_set_referral ON public.profiles;
CREATE TRIGGER profiles_set_referral
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_set_referral();

-- 2. Rewards ----------------------------------------------------------------------
ALTER TABLE public.point_ledger DROP CONSTRAINT IF EXISTS point_ledger_reason_valid;
ALTER TABLE public.point_ledger
  ADD CONSTRAINT point_ledger_reason_valid CHECK (reason IN (
    'signup_bonus', 'first_deposit_bonus', 'selection_submit', 'winning_payout',
    'withdrawal_request', 'withdrawal_refund', 'add_funds',
    'admin_adjust_points', 'admin_adjust_wallet', 'bet_refund',
    'referral_bonus'
  ));

ALTER TABLE public.push_outbox DROP CONSTRAINT IF EXISTS push_outbox_kind_check;
ALTER TABLE public.push_outbox
  ADD CONSTRAINT push_outbox_kind_check CHECK (kind IN (
    'deposit_approved', 'deposit_rejected', 'withdrawal_approved', 'withdrawal_rejected', 'winnings',
    'match_starting', 'referral_bonus'
  ));

CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  friend_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  deposit_request_id uuid NOT NULL REFERENCES public.add_funds_requests(id) ON DELETE RESTRICT,
  deposit_amount integer NOT NULL CHECK (deposit_amount > 0),
  reward integer NOT NULL CHECK (reward >= 0),
  status text NOT NULL CHECK (status IN ('paid', 'capped', 'too_small', 'not_eligible')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_rewards_referrer_idx ON public.referral_rewards (referrer_id, created_at DESC);
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.referral_rewards FROM PUBLIC, anon, authenticated;

/** The rules, in one place (the app shows them from get_my_referral). */
CREATE OR REPLACE FUNCTION public.referral_rules()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'percent', 10,
    'max_reward', 200,
    'min_deposit', 100,
    'max_friends_per_30_days', 20
  )
$$;
REVOKE EXECUTE ON FUNCTION public.referral_rules() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.referral_reward_on_first_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rules jsonb := public.referral_rules();
  v_referrer uuid;
  v_referrer_ok boolean;
  v_recent integer;
  v_reward integer := 0;
  v_status text;
BEGIN
  -- Only the friend's first approved deposit counts.
  IF EXISTS (
    SELECT 1 FROM public.add_funds_requests
    WHERE user_id = NEW.user_id AND status = 'approved' AND id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT referred_by INTO v_referrer FROM public.profiles WHERE id = NEW.user_id;
  IF v_referrer IS NULL
     OR EXISTS (SELECT 1 FROM public.referral_rewards WHERE friend_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  -- Lock the inviter so two friends approved at once count against the cap in turn.
  SELECT NOT is_banned AND NOT is_admin INTO v_referrer_ok
  FROM public.profiles WHERE id = v_referrer FOR UPDATE;

  SELECT count(*) INTO v_recent
  FROM public.referral_rewards
  WHERE referrer_id = v_referrer AND status = 'paid' AND created_at > now() - interval '30 days';

  IF NOT COALESCE(v_referrer_ok, false) THEN
    v_status := 'not_eligible';
  ELSIF NEW.amount < (v_rules->>'min_deposit')::integer THEN
    v_status := 'too_small';
  ELSIF v_recent >= (v_rules->>'max_friends_per_30_days')::integer THEN
    v_status := 'capped';
  ELSE
    v_reward := LEAST(
      floor(NEW.amount * (v_rules->>'percent')::numeric / 100)::integer,
      (v_rules->>'max_reward')::integer
    );
    v_status := CASE WHEN v_reward > 0 THEN 'paid' ELSE 'too_small' END;
  END IF;

  INSERT INTO public.referral_rewards (referrer_id, friend_id, deposit_request_id, deposit_amount, reward, status)
  VALUES (v_referrer, NEW.user_id, NEW.id, NEW.amount, CASE WHEN v_status = 'paid' THEN v_reward ELSE 0 END, v_status);

  IF v_status = 'paid' THEN
    UPDATE public.profiles SET points = points + v_reward WHERE id = v_referrer;
    INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
    VALUES (v_referrer, v_reward, 'referral_bonus', jsonb_build_object(
      'friend_id', NEW.user_id,
      'friend_name', (SELECT display_name FROM public.profiles WHERE id = NEW.user_id),
      'request_id', NEW.id,
      'deposit_amount', NEW.amount
    ));
    PERFORM public.push_enqueue(v_referrer, 'referral_bonus', v_reward,
      (SELECT NULLIF(display_name, '') FROM public.profiles WHERE id = NEW.user_id));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.referral_reward_on_first_deposit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS referral_reward_on_first_deposit ON public.add_funds_requests;
CREATE TRIGGER referral_reward_on_first_deposit
  AFTER UPDATE OF status ON public.add_funds_requests
  FOR EACH ROW
  WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION public.referral_reward_on_first_deposit();

-- 3. Player view -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_referral()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_code text;
  v_friends jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  SELECT referral_code INTO v_code FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;

  -- Newest 50 friends: first name only, and whether they earned a reward yet.
  SELECT COALESCE(jsonb_agg(row_data ORDER BY row_data.joined_at DESC), '[]'::jsonb)
  INTO v_friends
  FROM (
    SELECT
      split_part(COALESCE(NULLIF(btrim(p.display_name), ''), '—'), ' ', 1) AS name,
      p.created_at AS joined_at,
      r.status,
      COALESCE(r.reward, 0) AS reward
    FROM public.profiles p
    LEFT JOIN public.referral_rewards r ON r.friend_id = p.id
    WHERE p.referred_by = v_uid
    ORDER BY p.created_at DESC
    LIMIT 50
  ) row_data;

  RETURN jsonb_build_object(
    'code', v_code,
    'rules', public.referral_rules(),
    'friends_joined', (SELECT count(*) FROM public.profiles WHERE referred_by = v_uid),
    'friends_rewarded', (SELECT count(*) FROM public.referral_rewards WHERE referrer_id = v_uid AND status = 'paid'),
    'total_earned', (SELECT COALESCE(SUM(reward), 0) FROM public.referral_rewards WHERE referrer_id = v_uid),
    'friends', v_friends
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_referral() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_referral() TO authenticated;

-- 4. Admin view --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_user_referrals(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'User ID is required'; END IF;

  SELECT jsonb_build_object(
    'code', p.referral_code,
    'invited_by', CASE WHEN inviter.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', inviter.id, 'display_name', inviter.display_name) END,
    'friends', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id, 'display_name', f.display_name, 'joined_at', f.created_at,
        'is_banned', f.is_banned, 'status', r.status, 'reward', COALESCE(r.reward, 0),
        'deposit_amount', r.deposit_amount
      ) ORDER BY f.created_at DESC)
      FROM public.profiles f
      LEFT JOIN public.referral_rewards r ON r.friend_id = f.id
      WHERE f.referred_by = p.id
    ), '[]'::jsonb),
    'total_earned', (SELECT COALESCE(SUM(reward), 0) FROM public.referral_rewards WHERE referrer_id = p.id)
  ) INTO v_result
  FROM public.profiles p
  LEFT JOIN public.profiles inviter ON inviter.id = p.referred_by
  WHERE p.id = p_user_id;

  IF v_result IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_user_referrals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_user_referrals(uuid) TO authenticated;

-- 5. Balance breakdown: referral rewards count with the other bonuses -------------
CREATE OR REPLACE FUNCTION public.get_balance_breakdown()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_signup_earned bigint;
  v_selections_spent bigint;
  v_winnings_total bigint;
  v_deposits_total bigint;
  v_withdrawn_total bigint;
  v_play_balance integer;
  v_wallet integer;
  v_pending_withdrawals bigint;
  v_pending_add_funds bigint;
  v_bonus_available boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  SELECT COALESCE(SUM(delta), 0) INTO v_signup_earned
  FROM public.point_ledger
  WHERE user_id = v_uid AND reason IN ('signup_bonus', 'first_deposit_bonus', 'referral_bonus');

  SELECT COALESCE(SUM(CASE WHEN reason = 'selection_submit' THEN ABS(delta::bigint)
                           ELSE -delta::bigint END), 0)
  INTO v_selections_spent
  FROM public.point_ledger
  WHERE user_id = v_uid AND reason IN ('selection_submit', 'bet_refund');

  SELECT COALESCE(SUM(delta), 0) INTO v_winnings_total
  FROM public.point_ledger WHERE user_id = v_uid AND reason = 'winning_payout';

  SELECT COALESCE(SUM(amount), 0) INTO v_deposits_total
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'approved';

  SELECT COALESCE(SUM(amount), 0) INTO v_withdrawn_total
  FROM public.withdrawals WHERE user_id = v_uid AND status = 'approved';

  SELECT points, wallet INTO v_play_balance, v_wallet
  FROM public.profiles WHERE id = v_uid;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_withdrawals
  FROM public.withdrawals WHERE user_id = v_uid AND status = 'pending';

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_add_funds
  FROM public.add_funds_requests WHERE user_id = v_uid AND status = 'pending';

  v_bonus_available := NOT EXISTS (
      SELECT 1 FROM public.add_funds_requests
      WHERE user_id = v_uid AND status = 'approved'
    ) AND NOT EXISTS (
      SELECT 1 FROM public.point_ledger
      WHERE user_id = v_uid AND reason = 'first_deposit_bonus'
    );

  RETURN jsonb_build_object(
    'signup_earned', v_signup_earned,
    'selections_spent', v_selections_spent,
    'winnings_total', v_winnings_total,
    'deposits_total', v_deposits_total,
    'withdrawn_total', v_withdrawn_total,
    'play_balance', v_play_balance,
    'wallet', v_wallet,
    'pending_withdrawals', v_pending_withdrawals,
    'pending_add_funds', v_pending_add_funds,
    'max_add_funds_amount', 100000,
    'first_deposit_bonus_available', v_bonus_available
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_balance_breakdown() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_balance_breakdown() TO authenticated;
