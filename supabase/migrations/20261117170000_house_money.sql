/*
House money: so a bet always has someone on the other side.

- When the first real bet lands on a match, the house puts house_seed (default
  50) on Yes AND on No. That money is part of yes_total / no_total, so the
  payout formula is unchanged and the match is no longer refunded as
  one-sided.
- At most house_seed_daily_matches matches (default 10) get house money per
  day (India time), so the most the house can lose in a day is known in advance.
  Setting either value to 0 turns house money off.
- The house money never touches a wallet or the ledger. The house's share of
  winnings simply is not paid out, and its losing money is shared among the
  winners like anyone else's.
- house_net on each match = real players' losing stakes - extra paid to real
  winners: the house's true win (positive) or loss (negative). It replaces
  fee_taken for reporting; old matches are backfilled with fee_taken.
- If the match is refunded (cancelled, no result...), the house money just
  disappears: house_net = 0.
*/

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sport_settings
  ADD COLUMN IF NOT EXISTS house_seed integer NOT NULL DEFAULT 50
    CHECK (house_seed BETWEEN 0 AND 10000),
  ADD COLUMN IF NOT EXISTS house_seed_daily_matches integer NOT NULL DEFAULT 10
    CHECK (house_seed_daily_matches BETWEEN 0 AND 200);

ALTER TABLE public.sport_events
  ADD COLUMN IF NOT EXISTS house_yes bigint NOT NULL DEFAULT 0 CHECK (house_yes >= 0),
  ADD COLUMN IF NOT EXISTS house_no bigint NOT NULL DEFAULT 0 CHECK (house_no >= 0),
  ADD COLUMN IF NOT EXISTS house_seeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS house_net bigint;

UPDATE public.sport_events
SET house_net = CASE WHEN state = 'settled' THEN COALESCE(fee_taken, 0) ELSE 0 END
WHERE house_net IS NULL AND state IN ('settled', 'void');

CREATE INDEX IF NOT EXISTS sport_events_house_seeded_idx
  ON public.sport_events (house_seeded_at) WHERE house_seeded_at IS NOT NULL;

GRANT SELECT ON TABLE public.sport_settings TO service_role;

-- Matches given house money today (India time).
CREATE OR REPLACE FUNCTION public.sport_house_seeded_today()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer FROM public.sport_events
  WHERE house_seeded_at >= ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
$$;
REVOKE EXECUTE ON FUNCTION public.sport_house_seeded_today() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Settlement: records the house's real result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sport_settle_internal(
  p_event_id uuid,
  p_outcome text,
  p_void_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.sport_events%ROWTYPE;
  v_bet public.sport_bets%ROWTYPE;
  v_win_total bigint;
  v_lose_total bigint;
  v_house_lose bigint;
  v_distributable bigint;
  v_payout bigint;
  v_paid_extra bigint := 0;
  v_refunded integer := 0;
  v_winners integer := 0;
  v_house_net bigint;
  v_reason text := p_void_reason;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('yes', 'no', 'void') THEN
    RAISE EXCEPTION 'Outcome must be yes, no or void';
  END IF;

  SELECT * INTO v_event FROM public.sport_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_event.state IN ('settled', 'void') THEN
    RETURN jsonb_build_object('event_id', p_event_id, 'state', v_event.state, 'already', true);
  END IF;

  -- With house money both sides are above 0, so this only happens without it.
  IF p_outcome <> 'void' AND (v_event.yes_total = 0 OR v_event.no_total = 0) THEN
    p_outcome := 'void';
    v_reason := 'one_sided';
  END IF;

  IF p_outcome = 'void' THEN
    FOR v_bet IN
      SELECT * FROM public.sport_bets
      WHERE event_id = p_event_id AND status = 'open'
      ORDER BY user_id, id
    LOOP
      UPDATE public.profiles
      SET points = points + v_bet.from_points,
          wallet = wallet + v_bet.from_wallet
      WHERE id = v_bet.user_id;
      INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
      VALUES (v_bet.user_id, v_bet.amount, 'bet_refund', jsonb_build_object(
        'game', v_event.sport, 'event_id', p_event_id, 'bet_id', v_bet.id,
        'side', v_bet.side, 'to_points', v_bet.from_points,
        'to_wallet', v_bet.from_wallet, 'reason', COALESCE(v_reason, 'void')));
      UPDATE public.sport_bets
      SET status = 'refunded', payout = v_bet.amount, settled_at = now()
      WHERE id = v_bet.id;
      v_refunded := v_refunded + 1;
    END LOOP;

    UPDATE public.sport_events
    SET state = 'void', void_reason = COALESCE(v_reason, 'void'),
        fee_taken = 0, house_net = 0, settled_at = now(), updated_at = now()
    WHERE id = p_event_id;
    RETURN jsonb_build_object('event_id', p_event_id, 'state', 'void',
      'reason', COALESCE(v_reason, 'void'), 'refunded', v_refunded);
  END IF;

  IF p_outcome = 'yes' THEN
    v_win_total := v_event.yes_total; v_lose_total := v_event.no_total;
    v_house_lose := v_event.house_no;
  ELSE
    v_win_total := v_event.no_total; v_lose_total := v_event.yes_total;
    v_house_lose := v_event.house_yes;
  END IF;
  v_distributable := v_lose_total - (v_lose_total * v_event.fee_percent / 100);

  -- Only real bets are paid. The house's share of the winnings stays unpaid.
  FOR v_bet IN
    SELECT * FROM public.sport_bets
    WHERE event_id = p_event_id AND status = 'open'
    ORDER BY user_id, id
  LOOP
    IF v_bet.side = p_outcome THEN
      v_payout := v_bet.amount + (v_distributable * v_bet.amount / v_win_total);
      UPDATE public.profiles SET wallet = wallet + v_payout WHERE id = v_bet.user_id;
      INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
      VALUES (v_bet.user_id, v_payout, 'winning_payout', jsonb_build_object(
        'game', v_event.sport, 'event_id', p_event_id, 'bet_id', v_bet.id,
        'side', v_bet.side, 'bet', v_bet.amount));
      UPDATE public.sport_bets
      SET status = 'won', payout = v_payout, settled_at = now()
      WHERE id = v_bet.id;
      v_paid_extra := v_paid_extra + (v_payout - v_bet.amount);
      v_winners := v_winners + 1;
    ELSE
      UPDATE public.sport_bets
      SET status = 'lost', payout = 0, settled_at = now()
      WHERE id = v_bet.id;
    END IF;
  END LOOP;

  -- Real players' losing money minus what real winners got on top of their stake.
  v_house_net := (v_lose_total - v_house_lose) - v_paid_extra;

  UPDATE public.sport_events
  SET state = 'settled', outcome = p_outcome,
      fee_taken = v_lose_total - v_paid_extra,
      house_net = v_house_net,
      settled_at = now(), updated_at = now()
  WHERE id = p_event_id;

  RETURN jsonb_build_object('event_id', p_event_id, 'state', 'settled',
    'outcome', p_outcome, 'winners', v_winners,
    'fee_taken', v_lose_total - v_paid_extra, 'house_net', v_house_net);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sport_settle_internal(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Placing a bet: the first real bet brings in the house money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_sport_bet(
  p_event_id uuid,
  p_side text,
  p_amount integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_settings public.sport_settings%ROWTYPE;
  v_event public.sport_events%ROWTYPE;
  v_points integer;
  v_wallet integer;
  v_banned boolean;
  v_is_admin boolean;
  v_terms_accepted_at timestamptz;
  v_limits public.user_limits%ROWTYPE;
  v_today_net_loss bigint;
  v_my_total bigint;
  v_from_points integer;
  v_from_wallet integer;
  v_bet_id uuid;
  v_seed integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_side IS NULL OR p_side NOT IN ('yes', 'no') THEN RAISE EXCEPTION 'Choose Yes or No'; END IF;
  SELECT * INTO v_settings FROM public.sport_settings WHERE id = 1;
  IF p_amount IS NULL OR p_amount < v_settings.min_bet OR p_amount > v_settings.max_bet THEN
    RAISE EXCEPTION 'Each bet must be a whole number from % to %', v_settings.min_bet, v_settings.max_bet;
  END IF;

  -- Lock order: match, then sport settings (house money only), then profile.
  SELECT * INTO v_event FROM public.sport_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.hidden THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF (v_event.sport = 'football' AND NOT v_settings.football_enabled)
     OR (v_event.sport = 'cricket' AND NOT v_settings.cricket_enabled) THEN
    RAISE EXCEPTION 'Betting on % is turned off right now.', v_event.sport;
  END IF;
  IF v_event.state <> 'open' OR v_event.provider_status <> 'scheduled'
     OR clock_timestamp() >= v_event.starts_at THEN
    RAISE EXCEPTION 'Betting is closed for this match.';
  END IF;

  -- House money, once per match, within today's budget. The settings row lock
  -- makes the daily count exact when several first bets arrive together.
  IF v_event.house_seeded_at IS NULL AND v_settings.house_seed > 0
     AND v_settings.house_seed_daily_matches > 0 THEN
    SELECT * INTO v_settings FROM public.sport_settings WHERE id = 1 FOR UPDATE;
    IF v_settings.house_seed > 0
       AND public.sport_house_seeded_today() < v_settings.house_seed_daily_matches THEN
      v_seed := v_settings.house_seed;
    END IF;
  END IF;

  PERFORM public.apply_pending_user_limits(v_uid);
  SELECT points, wallet, is_banned, is_admin, terms_accepted_at
  INTO v_points, v_wallet, v_banned, v_is_admin, v_terms_accepted_at
  FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF COALESCE(v_is_admin, false) THEN RAISE EXCEPTION 'Admin accounts cannot place bets.'; END IF;
  IF v_terms_accepted_at IS NULL THEN RAISE EXCEPTION 'Please accept the Terms and Privacy Policy first.'; END IF;
  IF COALESCE(v_banned, false) THEN RAISE EXCEPTION 'Your account is banned. Contact support.'; END IF;

  SELECT * INTO v_limits FROM public.user_limits WHERE user_id = v_uid;
  IF v_limits.cooldown_until > now() THEN
    RAISE EXCEPTION 'Betting is paused until % due to your cooldown.', v_limits.cooldown_until;
  END IF;
  IF v_limits.self_excluded_until > now() THEN
    RAISE EXCEPTION 'Betting is unavailable until your self-exclusion ends on %.', v_limits.self_excluded_until;
  END IF;
  IF v_limits.daily_loss_limit IS NOT NULL THEN
    -- Same rule and wording as submit_selection().
    SELECT COALESCE(SUM(-delta::bigint), 0)
    INTO v_today_net_loss
    FROM public.point_ledger
    WHERE user_id = v_uid
      AND reason IN ('selection_submit', 'winning_payout')
      AND created_at >= ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata');
    IF v_today_net_loss + p_amount > v_limits.daily_loss_limit THEN
      RAISE EXCEPTION 'Daily loss limit reached. Limit: % points; today: % points.',
        v_limits.daily_loss_limit, v_today_net_loss;
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_my_total
  FROM public.sport_bets WHERE event_id = p_event_id AND user_id = v_uid;
  IF v_my_total + p_amount > v_settings.max_bet THEN
    RAISE EXCEPTION 'You can bet at most % on one match. You have already bet %.',
      v_settings.max_bet, v_my_total;
  END IF;

  IF v_points + v_wallet < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. You have % (play: %, wallet: %), this bet costs %.',
      v_points + v_wallet, v_points, v_wallet, p_amount;
  END IF;
  v_from_points := LEAST(v_points, p_amount);
  v_from_wallet := p_amount - v_from_points;

  UPDATE public.profiles
  SET points = points - v_from_points, wallet = wallet - v_from_wallet
  WHERE id = v_uid;
  INSERT INTO public.sport_bets (event_id, user_id, side, amount, from_points, from_wallet)
  VALUES (p_event_id, v_uid, p_side, p_amount, v_from_points, v_from_wallet)
  RETURNING id INTO v_bet_id;
  UPDATE public.sport_events
  SET yes_total = yes_total + v_seed + CASE WHEN p_side = 'yes' THEN p_amount ELSE 0 END,
      no_total = no_total + v_seed + CASE WHEN p_side = 'no' THEN p_amount ELSE 0 END,
      house_yes = house_yes + v_seed,
      house_no = house_no + v_seed,
      house_seeded_at = CASE WHEN v_seed > 0 THEN now() ELSE house_seeded_at END,
      updated_at = now()
  WHERE id = p_event_id
  RETURNING * INTO v_event;
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -p_amount, 'selection_submit', jsonb_build_object(
    'game', v_event.sport, 'event_id', p_event_id, 'bet_id', v_bet_id,
    'side', p_side, 'from_points', v_from_points, 'from_wallet', v_from_wallet));

  RETURN jsonb_build_object(
    'bet_id', v_bet_id,
    'points', v_points - v_from_points,
    'wallet', v_wallet - v_from_wallet,
    'yes_total', v_event.yes_total,
    'no_total', v_event.no_total
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.place_sport_bet(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_sport_bet(uuid, text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Player list: shows the house money and what an untouched match will get.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sport_events(p_sport text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_settings public.sport_settings%ROWTYPE;
  v_events jsonb;
  v_next_seed integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_sport IS NOT NULL AND p_sport NOT IN ('football', 'cricket') THEN
    RAISE EXCEPTION 'Invalid sport';
  END IF;
  SELECT * INTO v_settings FROM public.sport_settings WHERE id = 1;
  IF v_settings.house_seed > 0
     AND public.sport_house_seeded_today() < v_settings.house_seed_daily_matches THEN
    v_next_seed := v_settings.house_seed;
  END IF;

  SELECT COALESCE(jsonb_agg(row_data ORDER BY sort_key, starts), '[]'::jsonb)
  INTO v_events
  FROM (
    SELECT
      CASE WHEN e.state = 'open' AND e.starts_at > now() THEN 0 ELSE 1 END AS sort_key,
      CASE WHEN e.state = 'open' AND e.starts_at > now()
        THEN extract(epoch FROM e.starts_at) ELSE -extract(epoch FROM e.starts_at) END AS starts,
      jsonb_build_object(
        'id', e.id, 'sport', e.sport,
        'competition', e.competition, 'competition_name', e.competition_name,
        'home_team', e.home_team, 'away_team', e.away_team,
        'subject_side', e.subject_side, 'starts_at', e.starts_at,
        'state', CASE WHEN e.state = 'open' AND e.starts_at <= now() THEN 'closed' ELSE e.state END,
        'provider_status', e.provider_status,
        'home_score', e.home_score, 'away_score', e.away_score,
        'outcome', e.outcome, 'void_reason', e.void_reason,
        'fee_percent', e.fee_percent,
        'yes_total', e.yes_total, 'no_total', e.no_total,
        'house_yes', e.house_yes, 'house_no', e.house_no,
        'house_seeded', e.house_seeded_at IS NOT NULL,
        'my_yes', COALESCE((SELECT SUM(b.amount) FROM public.sport_bets b
                            WHERE b.event_id = e.id AND b.user_id = v_uid AND b.side = 'yes'), 0),
        'my_no', COALESCE((SELECT SUM(b.amount) FROM public.sport_bets b
                           WHERE b.event_id = e.id AND b.user_id = v_uid AND b.side = 'no'), 0)
      ) AS row_data
    FROM public.sport_events e
    WHERE NOT e.hidden
      AND (p_sport IS NULL OR e.sport = p_sport)
      AND ((e.sport = 'football' AND v_settings.football_enabled)
        OR (e.sport = 'cricket' AND v_settings.cricket_enabled))
      AND (e.state IN ('open', 'closed') OR e.starts_at > now() - interval '2 days')
      AND e.starts_at < now() + interval '8 days'
    ORDER BY e.starts_at
    LIMIT 150
  ) rows;

  RETURN jsonb_build_object(
    'football_enabled', v_settings.football_enabled,
    'cricket_enabled', v_settings.cricket_enabled,
    'min_bet', v_settings.min_bet,
    'max_bet', v_settings.max_bet,
    -- What the house will add to a match that has no bets yet (0 = none today).
    'house_seed', v_next_seed,
    'events', v_events
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_sport_events(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sport_events(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Admin: house money per match and overall.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_sports()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_settings jsonb;
  v_sync jsonb;
  v_events jsonb;
  v_house jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;

  SELECT to_jsonb(s) - 'id' INTO v_settings FROM public.sport_settings s WHERE id = 1;
  SELECT COALESCE(jsonb_agg(to_jsonb(st) ORDER BY st.sport), '[]'::jsonb)
  INTO v_sync FROM public.sport_sync_status st;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', e.id, 'sport', e.sport, 'competition_name', e.competition_name,
      'home_team', e.home_team, 'away_team', e.away_team,
      'subject_side', e.subject_side, 'starts_at', e.starts_at,
      'state', e.state, 'provider_status', e.provider_status,
      'home_score', e.home_score, 'away_score', e.away_score,
      'result_winner', e.result_winner, 'result_seen_at', e.result_seen_at,
      'outcome', e.outcome, 'void_reason', e.void_reason,
      'fee_percent', e.fee_percent, 'fee_taken', e.fee_taken,
      'yes_total', e.yes_total, 'no_total', e.no_total, 'hidden', e.hidden,
      'house_yes', e.house_yes, 'house_no', e.house_no,
      'house_seeded', e.house_seeded_at IS NOT NULL, 'house_net', e.house_net,
      'bettors', (SELECT count(DISTINCT b.user_id) FROM public.sport_bets b WHERE b.event_id = e.id)
    ) ORDER BY e.starts_at DESC), '[]'::jsonb)
  INTO v_events
  FROM public.sport_events e
  WHERE e.starts_at > now() - interval '7 days'
     OR e.state IN ('open', 'closed');

  -- All time, only matches that got house money.
  SELECT jsonb_build_object(
    'seeded_today', public.sport_house_seeded_today(),
    'matches_paid', count(*) FILTER (WHERE state = 'settled'),
    'matches_won', count(*) FILTER (WHERE state = 'settled' AND house_net >= 0),
    'matches_lost', count(*) FILTER (WHERE state = 'settled' AND house_net < 0),
    'matches_waiting', count(*) FILTER (WHERE state IN ('open', 'closed')),
    'net', COALESCE(SUM(house_net) FILTER (WHERE state = 'settled'), 0),
    'at_risk', COALESCE(SUM(GREATEST(house_yes, house_no)) FILTER (WHERE state IN ('open', 'closed')), 0)
  )
  INTO v_house
  FROM public.sport_events
  WHERE house_seeded_at IS NOT NULL;

  RETURN jsonb_build_object('settings', v_settings, 'sync', v_sync, 'events', v_events, 'house', v_house);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_sports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_sports() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_sport_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_row public.sport_settings%ROWTYPE;
  v_comp text;
  v_old_leagues text[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF COALESCE(jsonb_typeof(p_settings), 'null') <> 'object' THEN
    RAISE EXCEPTION 'Settings must be an object';
  END IF;

  SELECT * INTO v_row FROM public.sport_settings WHERE id = 1 FOR UPDATE;
  v_old_leagues := v_row.cricket_leagues;
  IF p_settings ? 'football_enabled' THEN v_row.football_enabled := (p_settings->>'football_enabled')::boolean; END IF;
  IF p_settings ? 'cricket_enabled' THEN v_row.cricket_enabled := (p_settings->>'cricket_enabled')::boolean; END IF;
  IF p_settings ? 'fee_percent' THEN v_row.fee_percent := (p_settings->>'fee_percent')::integer; END IF;
  IF p_settings ? 'min_bet' THEN v_row.min_bet := (p_settings->>'min_bet')::integer; END IF;
  IF p_settings ? 'max_bet' THEN v_row.max_bet := (p_settings->>'max_bet')::integer; END IF;
  IF p_settings ? 'house_seed' THEN v_row.house_seed := (p_settings->>'house_seed')::integer; END IF;
  IF p_settings ? 'house_seed_daily_matches' THEN
    v_row.house_seed_daily_matches := (p_settings->>'house_seed_daily_matches')::integer;
  END IF;
  IF p_settings ? 'football_competitions' THEN
    IF jsonb_typeof(p_settings->'football_competitions') <> 'array' THEN
      RAISE EXCEPTION 'Competitions must be a list';
    END IF;
    v_row.football_competitions := ARRAY(
      SELECT upper(btrim(x)) FROM jsonb_array_elements_text(p_settings->'football_competitions') x
      WHERE btrim(x) <> '');
    FOREACH v_comp IN ARRAY v_row.football_competitions LOOP
      IF v_comp !~ '^[A-Z0-9]{2,5}$' THEN RAISE EXCEPTION 'Invalid competition code %', v_comp; END IF;
    END LOOP;
  END IF;
  IF p_settings ? 'cricket_leagues' THEN
    IF jsonb_typeof(p_settings->'cricket_leagues') <> 'array' THEN
      RAISE EXCEPTION 'Cricket leagues must be a list';
    END IF;
    v_row.cricket_leagues := ARRAY(
      SELECT DISTINCT lower(btrim(x)) FROM jsonb_array_elements_text(p_settings->'cricket_leagues') x
      WHERE btrim(x) <> '');
    FOREACH v_comp IN ARRAY v_row.cricket_leagues LOOP
      IF v_comp NOT IN ('india', 'ipl', 'wbbl', 'bbl', 'wpl') THEN
        RAISE EXCEPTION 'Unknown cricket league %', v_comp;
      END IF;
    END LOOP;
  END IF;
  IF v_row.fee_percent IS NULL OR v_row.fee_percent NOT BETWEEN 0 AND 30 THEN
    RAISE EXCEPTION 'Fee must be from 0 to 30 percent';
  END IF;
  IF v_row.min_bet IS NULL OR v_row.max_bet IS NULL OR v_row.min_bet < 1
     OR v_row.max_bet > 100000 OR v_row.min_bet > v_row.max_bet THEN
    RAISE EXCEPTION 'Bet limits must be whole numbers with minimum at most maximum (maximum up to 100000)';
  END IF;
  IF v_row.house_seed IS NULL OR v_row.house_seed NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'House money per side must be from 0 to 10000';
  END IF;
  IF v_row.house_seed_daily_matches IS NULL OR v_row.house_seed_daily_matches NOT BETWEEN 0 AND 200 THEN
    RAISE EXCEPTION 'House money matches per day must be from 0 to 200';
  END IF;

  UPDATE public.sport_settings
  SET football_enabled = COALESCE(v_row.football_enabled, false),
      cricket_enabled = COALESCE(v_row.cricket_enabled, false),
      fee_percent = v_row.fee_percent,
      football_competitions = v_row.football_competitions,
      cricket_leagues = v_row.cricket_leagues,
      min_bet = v_row.min_bet, max_bet = v_row.max_bet,
      house_seed = v_row.house_seed,
      house_seed_daily_matches = v_row.house_seed_daily_matches,
      updated_at = now(), updated_by = v_uid
  WHERE id = 1;
  -- A league that was just switched on is searched for on the next sync.
  IF v_row.cricket_leagues IS DISTINCT FROM v_old_leagues THEN
    DELETE FROM public.sport_feed_state WHERE key = 'cricket_discovery';
  END IF;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'set_sport_settings', p_settings);

  RETURN (SELECT to_jsonb(s) - 'id' FROM public.sport_settings s WHERE id = 1);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_set_sport_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_sport_settings(jsonb) TO authenticated;
