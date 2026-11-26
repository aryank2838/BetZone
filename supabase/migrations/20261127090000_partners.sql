/*
# Partners: a share of the net profit from the players they bring

A partner is a player the admin promotes. Their normal invite link
(/?ref=CODE) becomes their partner link.

## Who is a partner's player
- Anyone who signs up with the partner's code, and anyone those players invite
  in turn (the tag is inherited). Set once at sign-up, in profiles.partner_id.
- When someone becomes a partner, the players they had already invited (and
  who have no partner yet) are tagged to them.
- The admin can move any player to a partner, or take them off one.
- A partner's own account is never their player.
- Partners do not get the 10% referral bonus; their reward is the share.

## Week and net profit
- The week runs Monday to Saturday (IST). Matka is closed on Sunday; Sunday's
  sports activity counts in the next week. So a week's window is
  Sunday 00:00 → next Sunday 00:00 IST, labelled by its Monday.
- Net profit from a partner's players in the window (Matka and sports):
    paid bets (selection_submit, minus bet_refund)
  − winnings paid (winning_payout)
  − bonuses given (signup_bonus, first_deposit_bonus, referral_bonus)
  Free slip commission is not a paid bet; its winnings are a cost.
  Admin balance adjustments are not counted.
- Losing weeks carry forward: base = net + carry_in. When base > 0 the
  partner earns floor(base × share% / 100) and the carry resets to 0;
  otherwise they earn 0 and carry base into the next week.

## Settling
- close_partner_weeks() writes one partner_weeks row per partner per finished
  week, in order. Cron runs it on Sunday 00:30 IST; the admin Partners tab
  also runs it on load, so a missed cron run fixes itself.
- The admin pays the partner's UPI and marks the week paid with the UTR.
- A paused partner earns nothing for weeks after they were paused; their
  players stay tagged so they can be turned back on.
*/

-- 1. Tables --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partners (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  share_percent integer NOT NULL CHECK (share_percent BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  payout_upi text CHECK (payout_upi IS NULL OR payout_upi ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$'),
  -- First week this partner earns for (the Monday of the week they joined).
  first_week date NOT NULL,
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.partners FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.partners TO authenticated;
DROP POLICY IF EXISTS partners_read_own ON public.partners;
CREATE POLICY partners_read_own ON public.partners
  FOR SELECT TO authenticated USING (user_id = auth.uid());

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES public.partners(user_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_partner_id_idx ON public.profiles (partner_id) WHERE partner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.partner_weeks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(user_id) ON DELETE RESTRICT,
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  bets bigint NOT NULL,
  wins bigint NOT NULL,
  bonuses bigint NOT NULL,
  net bigint NOT NULL,
  carry_in bigint NOT NULL CHECK (carry_in <= 0),
  share_percent integer NOT NULL,
  share bigint NOT NULL CHECK (share >= 0),
  carry_out bigint NOT NULL CHECK (carry_out <= 0),
  status text NOT NULL CHECK (status IN ('due', 'paid', 'nothing_due')),
  paid_at timestamptz,
  paid_utr text,
  paid_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, week_start)
);
ALTER TABLE public.partner_weeks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.partner_weeks FROM PUBLIC, anon, authenticated;

-- 2. Week helpers ---------------------------------------------------------------------
-- Monday of the week a date's activity counts in (Sunday → the next Monday).
CREATE OR REPLACE FUNCTION public.partner_week_of(p_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN extract(isodow FROM p_date) = 7 THEN p_date + 1
              ELSE p_date - (extract(isodow FROM p_date)::integer - 1) END;
$$;

CREATE OR REPLACE FUNCTION public.partner_week_from(p_week_start date)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$ SELECT ((p_week_start - 1)::timestamp AT TIME ZONE 'Asia/Kolkata'); $$;

CREATE OR REPLACE FUNCTION public.partner_week_to(p_week_start date)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$ SELECT ((p_week_start + 6)::timestamp AT TIME ZONE 'Asia/Kolkata'); $$;

REVOKE EXECUTE ON FUNCTION public.partner_week_of(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.partner_week_from(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.partner_week_to(date) FROM PUBLIC, anon, authenticated;

-- Per-player totals for a partner's players in [p_from, p_to).
CREATE OR REPLACE FUNCTION public.partner_player_totals(p_partner uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(player_id uuid, bets bigint, wins bigint, bonuses bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.user_id,
    COALESCE(SUM(CASE WHEN l.reason IN ('selection_submit', 'bet_refund') THEN -l.delta::bigint ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN l.reason = 'winning_payout' THEN l.delta::bigint ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN l.reason IN ('signup_bonus', 'first_deposit_bonus', 'referral_bonus') THEN l.delta::bigint ELSE 0 END), 0)
  FROM public.point_ledger l
  JOIN public.profiles p ON p.id = l.user_id
  WHERE p.partner_id = p_partner
    AND p.id <> p_partner
    AND NOT p.is_admin
    AND l.created_at >= p_from AND l.created_at < p_to
    AND l.reason IN ('selection_submit', 'bet_refund', 'winning_payout',
                     'signup_bonus', 'first_deposit_bonus', 'referral_bonus')
  GROUP BY l.user_id;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_player_totals(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- Last finished week (its Monday): the week whose Saturday is before today, IST.
CREATE OR REPLACE FUNCTION public.partner_last_closed_week()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT public.partner_week_of((now() AT TIME ZONE 'Asia/Kolkata')::date) - 7;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_last_closed_week() FROM PUBLIC, anon, authenticated;

-- 3. Closing weeks --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_partner_weeks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last date := public.partner_last_closed_week();
  v_partner public.partners%ROWTYPE;
  v_week date;
  v_carry bigint;
  v_bets bigint;
  v_wins bigint;
  v_bonuses bigint;
  v_net bigint;
  v_base bigint;
  v_share bigint;
  v_written integer := 0;
BEGIN
  FOR v_partner IN SELECT * FROM public.partners ORDER BY user_id FOR UPDATE LOOP
    SELECT week_start + 7, carry_out INTO v_week, v_carry
    FROM public.partner_weeks WHERE partner_id = v_partner.user_id
    ORDER BY week_start DESC LIMIT 1;
    IF v_week IS NULL THEN
      v_week := v_partner.first_week;
      v_carry := 0;
    END IF;
    WHILE v_week <= v_last LOOP
      -- A paused partner earns nothing for weeks that start after the pause.
      EXIT WHEN NOT v_partner.active
        AND v_partner.paused_at IS NOT NULL
        AND public.partner_week_from(v_week) >= v_partner.paused_at;
      SELECT COALESCE(SUM(t.bets), 0), COALESCE(SUM(t.wins), 0), COALESCE(SUM(t.bonuses), 0)
      INTO v_bets, v_wins, v_bonuses
      FROM public.partner_player_totals(v_partner.user_id, public.partner_week_from(v_week), public.partner_week_to(v_week)) t;
      v_net := v_bets - v_wins - v_bonuses;
      v_base := v_net + v_carry;
      v_share := CASE WHEN v_base > 0 THEN floor(v_base * v_partner.share_percent / 100.0)::bigint ELSE 0 END;
      INSERT INTO public.partner_weeks (partner_id, week_start, bets, wins, bonuses, net, carry_in,
        share_percent, share, carry_out, status)
      VALUES (v_partner.user_id, v_week, v_bets, v_wins, v_bonuses, v_net, v_carry,
        v_partner.share_percent, v_share, LEAST(v_base, 0),
        CASE WHEN v_share > 0 THEN 'due' ELSE 'nothing_due' END)
      ON CONFLICT (partner_id, week_start) DO NOTHING;
      v_written := v_written + 1;
      v_carry := LEAST(v_base, 0);
      v_week := v_week + 7;
    END LOOP;
  END LOOP;
  RETURN v_written;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.close_partner_weeks() FROM PUBLIC, anon, authenticated;

-- This week so far for one partner (not saved).
CREATE OR REPLACE FUNCTION public.partner_live_week(p_partner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week date := public.partner_week_of((now() AT TIME ZONE 'Asia/Kolkata')::date);
  v_percent integer;
  v_carry bigint;
  v_bets bigint;
  v_wins bigint;
  v_bonuses bigint;
  v_net bigint;
  v_base bigint;
BEGIN
  SELECT share_percent INTO v_percent FROM public.partners WHERE user_id = p_partner;
  -- Carry from the last closed week (or the week before, if it is not closed yet).
  SELECT carry_out INTO v_carry FROM public.partner_weeks
  WHERE partner_id = p_partner AND week_start < v_week ORDER BY week_start DESC LIMIT 1;
  v_carry := COALESCE(v_carry, 0);
  SELECT COALESCE(SUM(t.bets), 0), COALESCE(SUM(t.wins), 0), COALESCE(SUM(t.bonuses), 0)
  INTO v_bets, v_wins, v_bonuses
  FROM public.partner_player_totals(p_partner, public.partner_week_from(v_week), public.partner_week_to(v_week)) t;
  v_net := v_bets - v_wins - v_bonuses;
  v_base := v_net + v_carry;
  RETURN jsonb_build_object(
    'week_start', v_week,
    'week_end', v_week + 5,
    'bets', v_bets, 'wins', v_wins, 'bonuses', v_bonuses, 'net', v_net,
    'carry_in', v_carry,
    'share_percent', v_percent,
    'projected_share', CASE WHEN v_base > 0 THEN floor(v_base * v_percent / 100.0)::bigint ELSE 0 END
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_live_week(uuid) FROM PUBLIC, anon, authenticated;

-- 4. Tagging at sign-up -----------------------------------------------------------------
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
  -- Partner: the inviter if they are an active partner, else the inviter's partner.
  NEW.partner_id := NULL;
  IF NEW.referred_by IS NOT NULL THEN
    SELECT pt.user_id INTO NEW.partner_id
    FROM public.partners pt
    WHERE pt.active AND pt.user_id = NEW.referred_by;
    IF NEW.partner_id IS NULL THEN
      SELECT pt.user_id INTO NEW.partner_id
      FROM public.profiles p
      JOIN public.partners pt ON pt.user_id = p.partner_id AND pt.active
      WHERE p.id = NEW.referred_by;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.profiles_set_referral() FROM PUBLIC, anon, authenticated;

-- 5. Partners get no referral bonus (their reward is the share) ------------------------
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
  IF EXISTS (SELECT 1 FROM public.partners WHERE user_id = v_referrer AND active) THEN
    v_referrer_ok := false;
  END IF;

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

-- 6. Partner's own dashboard ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_partner_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_partner public.partners%ROWTYPE;
  v_live jsonb;
  v_players jsonb;
  v_weeks jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.partners WHERE user_id = v_uid) THEN RETURN NULL; END IF;
  -- Never wait on the Sunday cron: close any finished week now.
  PERFORM public.close_partner_weeks();
  SELECT * INTO v_partner FROM public.partners WHERE user_id = v_uid;
  v_live := public.partner_live_week(v_uid);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'name', COALESCE(NULLIF(btrim(p.display_name), ''), 'Player'),
      'joined_at', p.created_at,
      'bets', COALESCE(t.bets, 0),
      'wins', COALESCE(t.wins, 0),
      'net', COALESCE(t.bets, 0) - COALESCE(t.wins, 0) - COALESCE(t.bonuses, 0),
      'last_active', (SELECT max(l.created_at) FROM public.point_ledger l WHERE l.user_id = p.id)
    ) ORDER BY COALESCE(t.bets, 0) DESC, p.created_at DESC), '[]'::jsonb)
  INTO v_players
  FROM (SELECT * FROM public.profiles WHERE partner_id = v_uid AND id <> v_uid AND NOT is_admin
        ORDER BY created_at DESC LIMIT 500) p
  LEFT JOIN public.partner_player_totals(v_uid,
    public.partner_week_from((v_live->>'week_start')::date),
    public.partner_week_to((v_live->>'week_start')::date)) t ON t.player_id = p.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'week_start', w.week_start, 'week_end', w.week_start + 5,
      'bets', w.bets, 'wins', w.wins, 'bonuses', w.bonuses, 'net', w.net,
      'carry_in', w.carry_in, 'carry_out', w.carry_out,
      'share_percent', w.share_percent, 'share', w.share,
      'status', w.status, 'paid_at', w.paid_at, 'paid_utr', w.paid_utr
    ) ORDER BY w.week_start DESC), '[]'::jsonb)
  INTO v_weeks
  FROM (SELECT * FROM public.partner_weeks WHERE partner_id = v_uid ORDER BY week_start DESC LIMIT 26) w;

  RETURN jsonb_build_object(
    'code', (SELECT referral_code FROM public.profiles WHERE id = v_uid),
    'share_percent', v_partner.share_percent,
    'active', v_partner.active,
    'payout_upi', v_partner.payout_upi,
    'player_count', (SELECT count(*) FROM public.profiles WHERE partner_id = v_uid AND id <> v_uid AND NOT is_admin),
    'week', v_live,
    'players', v_players,
    'weeks', v_weeks
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_partner_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_partner_dashboard() TO authenticated;

CREATE OR REPLACE FUNCTION public.partner_set_payout_upi(p_upi text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_upi text := NULLIF(btrim(COALESCE(p_upi, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.partners WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only partners can do this';
  END IF;
  IF v_upi IS NOT NULL AND v_upi !~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'UPI ID must use the format username@provider';
  END IF;
  UPDATE public.partners SET payout_upi = v_upi, updated_at = now() WHERE user_id = auth.uid();
  RETURN jsonb_build_object('payout_upi', v_upi);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_set_payout_upi(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_set_payout_upi(text) TO authenticated;

-- 7. Admin ------------------------------------------------------------------------------
-- Finds a user by invite code or email.
CREATE OR REPLACE FUNCTION public.admin_find_user(p_lookup text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lookup text := btrim(COALESCE(p_lookup, ''));
  v_id uuid;
BEGIN
  IF v_lookup = '' THEN RAISE EXCEPTION 'Enter an invite code or email'; END IF;
  SELECT id INTO v_id FROM public.profiles WHERE referral_code = upper(v_lookup);
  IF v_id IS NULL THEN
    SELECT u.id INTO v_id FROM auth.users u WHERE lower(u.email) = lower(v_lookup);
  END IF;
  IF v_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_id) THEN
    RAISE EXCEPTION 'No player found with that invite code or email';
  END IF;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_find_user(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_partners()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  PERFORM public.close_partner_weeks();
  SELECT COALESCE(jsonb_agg(row_data ORDER BY (row_data->>'active')::boolean DESC, row_data->>'name'), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'user_id', pt.user_id,
      'name', COALESCE(NULLIF(btrim(p.display_name), ''), u.email),
      'email', u.email,
      'code', p.referral_code,
      'share_percent', pt.share_percent,
      'active', pt.active,
      'payout_upi', pt.payout_upi,
      'created_at', pt.created_at,
      'player_count', (SELECT count(*) FROM public.profiles x WHERE x.partner_id = pt.user_id AND x.id <> pt.user_id AND NOT x.is_admin),
      'week', public.partner_live_week(pt.user_id),
      'due_total', (SELECT COALESCE(SUM(share), 0) FROM public.partner_weeks w WHERE w.partner_id = pt.user_id AND w.status = 'due'),
      'weeks', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', w.id, 'week_start', w.week_start, 'week_end', w.week_start + 5,
          'bets', w.bets, 'wins', w.wins, 'bonuses', w.bonuses, 'net', w.net,
          'carry_in', w.carry_in, 'carry_out', w.carry_out,
          'share_percent', w.share_percent, 'share', w.share,
          'status', w.status, 'paid_at', w.paid_at, 'paid_utr', w.paid_utr
        ) ORDER BY w.week_start DESC), '[]'::jsonb)
        FROM (SELECT * FROM public.partner_weeks WHERE partner_id = pt.user_id ORDER BY week_start DESC LIMIT 12) w)
    ) AS row_data
    FROM public.partners pt
    JOIN public.profiles p ON p.id = pt.user_id
    LEFT JOIN auth.users u ON u.id = pt.user_id
  ) partner_rows;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_partners() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_partners() TO authenticated;

-- Make someone a partner (or update their share / turn them back on).
CREATE OR REPLACE FUNCTION public.admin_save_partner(p_lookup text, p_share_percent integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_user uuid;
  v_existing public.partners%ROWTYPE;
  v_tagged integer := 0;
  v_last_week date;
  v_last_carry bigint;
  v_from date;
  v_to date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_share_percent IS NULL OR p_share_percent < 1 OR p_share_percent > 100 THEN
    RAISE EXCEPTION 'Share must be a whole number from 1 to 100';
  END IF;
  v_user := public.admin_find_user(p_lookup);
  IF (SELECT is_admin FROM public.profiles WHERE id = v_user) THEN
    RAISE EXCEPTION 'An admin account cannot be a partner';
  END IF;
  -- Close finished weeks first, so a new share only applies from now on.
  PERFORM public.close_partner_weeks();
  SELECT * INTO v_existing FROM public.partners WHERE user_id = v_user FOR UPDATE;
  IF FOUND THEN
    IF NOT v_existing.active THEN
      -- Turned back on: the finished weeks while paused earn nothing, and any
      -- carried loss stays carried (a pause never wipes it).
      SELECT week_start, carry_out INTO v_last_week, v_last_carry
      FROM public.partner_weeks WHERE partner_id = v_user ORDER BY week_start DESC LIMIT 1;
      v_from := COALESCE(v_last_week + 7, v_existing.first_week);
      v_to := public.partner_last_closed_week();
      v_last_carry := COALESCE(v_last_carry, 0);
      IF v_from <= v_to THEN
        INSERT INTO public.partner_weeks (partner_id, week_start, bets, wins, bonuses, net, carry_in,
          share_percent, share, carry_out, status)
        SELECT v_user, g::date, 0, 0, 0, 0, v_last_carry, p_share_percent, 0, v_last_carry, 'nothing_due'
        FROM generate_series(v_from::timestamp, v_to::timestamp, interval '7 days') AS g
        ON CONFLICT (partner_id, week_start) DO NOTHING;
      END IF;
    END IF;
    UPDATE public.partners
    SET share_percent = p_share_percent, active = true, paused_at = NULL, updated_at = now()
    WHERE user_id = v_user;
  ELSE
    INSERT INTO public.partners (user_id, share_percent, first_week)
    VALUES (v_user, p_share_percent, public.partner_week_of((now() AT TIME ZONE 'Asia/Kolkata')::date));
    -- Players they had already invited, who have no partner yet.
    UPDATE public.profiles SET partner_id = v_user
    WHERE referred_by = v_user AND partner_id IS NULL AND id <> v_user AND NOT is_admin;
    GET DIAGNOSTICS v_tagged = ROW_COUNT;
  END IF;
  -- A partner is never their own player.
  UPDATE public.profiles SET partner_id = NULL WHERE id = v_user;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'save_partner', jsonb_build_object('user_id', v_user, 'share_percent', p_share_percent, 'tagged_players', v_tagged));
  RETURN jsonb_build_object('user_id', v_user, 'share_percent', p_share_percent, 'tagged_players', v_tagged);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_save_partner(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_partner(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_pause_partner(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  PERFORM public.close_partner_weeks();
  UPDATE public.partners SET active = false, paused_at = now(), updated_at = now()
  WHERE user_id = p_user_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partner not found or already paused'; END IF;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (auth.uid(), 'pause_partner', jsonb_build_object('user_id', p_user_id));
  RETURN jsonb_build_object('user_id', p_user_id, 'active', false);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_pause_partner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_pause_partner(uuid) TO authenticated;

-- Move a player to a partner (p_partner_id NULL takes them off any partner).
CREATE OR REPLACE FUNCTION public.admin_assign_player_partner(p_lookup text, p_partner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_player uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  v_player := public.admin_find_user(p_lookup);
  IF (SELECT is_admin FROM public.profiles WHERE id = v_player) THEN
    RAISE EXCEPTION 'An admin account cannot be a partner''s player';
  END IF;
  IF p_partner_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.partners WHERE user_id = p_partner_id) THEN
      RAISE EXCEPTION 'Partner not found';
    END IF;
    IF p_partner_id = v_player THEN RAISE EXCEPTION 'A partner cannot be their own player'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.partners WHERE user_id = v_player) THEN
    RAISE EXCEPTION 'That account is a partner';
  END IF;
  UPDATE public.profiles SET partner_id = p_partner_id WHERE id = v_player;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (auth.uid(), 'assign_player_partner', jsonb_build_object('player_id', v_player, 'partner_id', p_partner_id));
  RETURN jsonb_build_object('player_id', v_player,
    'player_name', (SELECT display_name FROM public.profiles WHERE id = v_player),
    'partner_id', p_partner_id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_assign_player_partner(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_player_partner(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_mark_partner_week_paid(p_week_id uuid, p_utr text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_utr text := btrim(COALESCE(p_utr, ''));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF v_utr !~ '^[A-Za-z0-9]{6,40}$' THEN RAISE EXCEPTION 'Enter the UTR / reference number of the payment'; END IF;
  UPDATE public.partner_weeks
  SET status = 'paid', paid_at = now(), paid_utr = v_utr, paid_by = auth.uid()
  WHERE id = p_week_id AND status = 'due';
  IF NOT FOUND THEN RAISE EXCEPTION 'That week is not waiting for payment'; END IF;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (auth.uid(), 'partner_week_paid', jsonb_build_object('week_id', p_week_id, 'utr', v_utr));
  RETURN jsonb_build_object('id', p_week_id, 'status', 'paid');
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_mark_partner_week_paid(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_partner_week_paid(uuid, text) TO authenticated;

-- 8. Sunday 00:30 IST: close the week that just ended -------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partner-weeks-close') THEN
    PERFORM cron.unschedule('partner-weeks-close');
  END IF;
  -- Saturday 19:00 UTC = Sunday 00:30 IST.
  PERFORM cron.schedule(
    'partner-weeks-close',
    '0 19 * * 6',
    $job$ SELECT public.close_partner_weeks(); $job$
  );
END;
$cron$;
