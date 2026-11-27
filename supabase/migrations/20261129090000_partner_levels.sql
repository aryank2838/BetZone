/*
# Partner levels: the share grows with the week's profit

The share percent is picked each week from the partner's profit that week
(base = net + carried loss), using partner_levels:

    base up to ₹1,000      → 30%
    base ₹1,001 – ₹2,000   → 40%
    base above ₹2,000      → 50%

- The whole week is paid at that level's percent (₹1,500 → 40% → ₹600).
- A losing week (base ≤ 0) still earns 0 and carries forward, as before.
- partners.share_percent NULL means "use the levels". A number there is a
  fixed percent for that one partner, which replaces the levels.
- Every existing partner moves to the levels. The current, unfinished week
  is the first one paid by level; finished weeks keep what they had.
- The admin can change the levels (admin_save_partner_levels). A change applies
  to weeks that close after it; closed weeks never change.
- partner_weeks.share_percent keeps recording the percent actually used.
*/

-- 1. Levels table -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_levels (
  min_profit bigint PRIMARY KEY CHECK (min_profit >= 0),
  percent integer NOT NULL CHECK (percent BETWEEN 1 AND 100)
);
ALTER TABLE public.partner_levels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.partner_levels FROM PUBLIC, anon, authenticated;

INSERT INTO public.partner_levels (min_profit, percent) VALUES (0, 30), (1001, 40), (2001, 50)
ON CONFLICT (min_profit) DO NOTHING;

-- 2. Partners can use the levels (NULL) or a fixed percent -------------------------------
ALTER TABLE public.partners ALTER COLUMN share_percent DROP NOT NULL;
UPDATE public.partners SET share_percent = NULL, updated_at = now();

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
    'verify_email',
    'save_partner', 'pause_partner', 'assign_player_partner', 'partner_week_paid',
    'remove_partner', 'save_partner_levels'
  ));

-- 3. Helpers --------------------------------------------------------------------------------
-- The percent for a week: the fixed percent if set, else the level for this base.
CREATE OR REPLACE FUNCTION public.partner_percent_for(p_fixed integer, p_base bigint)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    p_fixed,
    (SELECT percent FROM public.partner_levels
     WHERE min_profit <= GREATEST(p_base, 0) ORDER BY min_profit DESC LIMIT 1),
    (SELECT percent FROM public.partner_levels ORDER BY min_profit LIMIT 1),
    0
  );
$$;
REVOKE EXECUTE ON FUNCTION public.partner_percent_for(integer, bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.partner_levels_json()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('min_profit', min_profit, 'percent', percent) ORDER BY min_profit), '[]'::jsonb)
  FROM public.partner_levels;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_levels_json() FROM PUBLIC, anon, authenticated;

-- 4. Closing weeks uses the level ----------------------------------------------------------
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
  v_percent integer;
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
      v_percent := public.partner_percent_for(v_partner.share_percent, v_base);
      v_share := CASE WHEN v_base > 0 THEN floor(v_base * v_percent / 100.0)::bigint ELSE 0 END;
      INSERT INTO public.partner_weeks (partner_id, week_start, bets, wins, bonuses, net, carry_in,
        share_percent, share, carry_out, status)
      VALUES (v_partner.user_id, v_week, v_bets, v_wins, v_bonuses, v_net, v_carry,
        v_percent, v_share, LEAST(v_base, 0),
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

-- 5. This week so far: current level and the next one ---------------------------------------
CREATE OR REPLACE FUNCTION public.partner_live_week(p_partner uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_week date := public.partner_week_of((now() AT TIME ZONE 'Asia/Kolkata')::date);
  v_fixed integer;
  v_percent integer;
  v_carry bigint;
  v_bets bigint;
  v_wins bigint;
  v_bonuses bigint;
  v_net bigint;
  v_base bigint;
  v_next public.partner_levels%ROWTYPE;
BEGIN
  SELECT share_percent INTO v_fixed FROM public.partners WHERE user_id = p_partner;
  -- Carry from the last closed week (or the week before, if it is not closed yet).
  SELECT carry_out INTO v_carry FROM public.partner_weeks
  WHERE partner_id = p_partner AND week_start < v_week ORDER BY week_start DESC LIMIT 1;
  v_carry := COALESCE(v_carry, 0);
  SELECT COALESCE(SUM(t.bets), 0), COALESCE(SUM(t.wins), 0), COALESCE(SUM(t.bonuses), 0)
  INTO v_bets, v_wins, v_bonuses
  FROM public.partner_player_totals(p_partner, public.partner_week_from(v_week), public.partner_week_to(v_week)) t;
  v_net := v_bets - v_wins - v_bonuses;
  v_base := v_net + v_carry;
  v_percent := public.partner_percent_for(v_fixed, v_base);
  IF v_fixed IS NULL THEN
    SELECT * INTO v_next FROM public.partner_levels
    WHERE min_profit > GREATEST(v_base, 0) ORDER BY min_profit LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'week_start', v_week,
    'week_end', v_week + 5,
    'bets', v_bets, 'wins', v_wins, 'bonuses', v_bonuses, 'net', v_net,
    'carry_in', v_carry,
    'share_percent', v_percent,
    'uses_levels', v_fixed IS NULL,
    'next_level_min', v_next.min_profit,
    'next_level_percent', v_next.percent,
    'projected_share', CASE WHEN v_base > 0 THEN floor(v_base * v_percent / 100.0)::bigint ELSE 0 END
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_live_week(uuid) FROM PUBLIC, anon, authenticated;

-- 6. Partner dashboard: effective percent and the levels -----------------------------------
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
    'share_percent', (v_live->>'share_percent')::integer,
    'uses_levels', v_partner.share_percent IS NULL,
    'levels', CASE WHEN v_partner.share_percent IS NULL THEN public.partner_levels_json() ELSE '[]'::jsonb END,
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

-- 7. Admin: save a partner with levels (NULL) or a fixed percent ----------------------------
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
  IF p_share_percent IS NOT NULL AND (p_share_percent < 1 OR p_share_percent > 100) THEN
    RAISE EXCEPTION 'Fixed share must be a whole number from 1 to 100 (leave it empty to use the levels)';
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
        SELECT v_user, g::date, 0, 0, 0, 0, v_last_carry,
          public.partner_percent_for(p_share_percent, 0), 0, v_last_carry, 'nothing_due'
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

-- 8. Admin: read and change the levels -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_partner_levels()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  RETURN public.partner_levels_json();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_partner_levels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_partner_levels() TO authenticated;

-- p_levels: [{"min_profit": 0, "percent": 30}, {"min_profit": 1001, "percent": 40}, ...]
CREATE OR REPLACE FUNCTION public.admin_save_partner_levels(p_levels jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_min bigint;
  v_percent integer;
  v_prev bigint := -1;
  v_count integer := 0;
  v_old jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_levels IS NULL OR jsonb_typeof(p_levels) <> 'array' OR jsonb_array_length(p_levels) = 0 THEN
    RAISE EXCEPTION 'Add at least one level';
  END IF;
  IF jsonb_array_length(p_levels) > 10 THEN RAISE EXCEPTION 'At most 10 levels'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_levels) LOOP
    BEGIN
      v_min := (v_item->>'min_profit')::bigint;
      v_percent := (v_item->>'percent')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Each level needs a whole-rupee profit amount and a whole percent';
    END;
    IF v_min IS NULL OR v_percent IS NULL THEN
      RAISE EXCEPTION 'Each level needs a whole-rupee profit amount and a whole percent';
    END IF;
    IF v_count = 0 AND v_min <> 0 THEN RAISE EXCEPTION 'The first level must start at ₹0'; END IF;
    IF v_min <= v_prev THEN RAISE EXCEPTION 'Each level must start at a higher profit than the one before'; END IF;
    IF v_percent < 1 OR v_percent > 100 THEN RAISE EXCEPTION 'Each percent must be from 1 to 100'; END IF;
    v_prev := v_min;
    v_count := v_count + 1;
  END LOOP;

  -- Close finished weeks first, so the new levels only apply from this week on.
  PERFORM public.close_partner_weeks();
  v_old := public.partner_levels_json();
  DELETE FROM public.partner_levels WHERE true;
  INSERT INTO public.partner_levels (min_profit, percent)
  SELECT (value->>'min_profit')::bigint, (value->>'percent')::integer FROM jsonb_array_elements(p_levels);

  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (auth.uid(), 'save_partner_levels', jsonb_build_object('old', v_old, 'new', public.partner_levels_json()));
  RETURN public.partner_levels_json();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_save_partner_levels(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_partner_levels(jsonb) TO authenticated;
