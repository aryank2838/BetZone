/*
Football gets a Draw pool.

Before: one question "Will <team> win?" with Yes and No, and a draw counted as
No. So No was always the safer side.

Now football matches have three pools: Yes (the team wins), Draw, and No (the
other team wins). Exactly one pool wins; it shares the other two pools
(minus the fee) the same way as before.

- sport_events.has_draw marks a match with a Draw pool. New football matches
  from the sync get it. Open football matches with no bets yet are switched
  over now. Matches that already have bets keep the old Yes/No rules (a draw is
  No), because that is what their players bet on. Cricket stays Yes/No.
- draw_total / house_draw are the Draw pool and the house money in it. House
  money goes on all three sides of a Draw match.
- Settlement refunds everyone when the winning pool or all the other pools are
  empty. For a Yes/No match this is the same as the old one-sided rule. A
  Draw match whose winning pool is empty is refunded with reason 'no_winners'.
- sport_outcome_for_winner() turns a feed result (home/away/draw) into the
  winning pool, used by the sync and by the admin manual result.
*/

-- ---------------------------------------------------------------------------
-- 1. Columns and checks.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sport_events
  ADD COLUMN IF NOT EXISTS has_draw boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS draw_total bigint NOT NULL DEFAULT 0 CHECK (draw_total >= 0),
  ADD COLUMN IF NOT EXISTS house_draw bigint NOT NULL DEFAULT 0 CHECK (house_draw >= 0);

ALTER TABLE public.sport_events DROP CONSTRAINT IF EXISTS sport_events_outcome_check;
ALTER TABLE public.sport_events
  ADD CONSTRAINT sport_events_outcome_check CHECK (outcome IN ('yes', 'no', 'draw'));
ALTER TABLE public.sport_events DROP CONSTRAINT IF EXISTS sport_events_draw_only_with_pool;
ALTER TABLE public.sport_events
  ADD CONSTRAINT sport_events_draw_only_with_pool
  CHECK (has_draw OR (draw_total = 0 AND house_draw = 0 AND outcome IS DISTINCT FROM 'draw'));

ALTER TABLE public.sport_bets DROP CONSTRAINT IF EXISTS sport_bets_side_check;
ALTER TABLE public.sport_bets
  ADD CONSTRAINT sport_bets_side_check CHECK (side IN ('yes', 'no', 'draw'));

-- Open football matches nobody has bet on yet switch to three pools. The
-- totals are on the row itself, so a bet landing during this update is seen.
UPDATE public.sport_events e
SET has_draw = true, updated_at = now()
WHERE e.sport = 'football' AND e.state = 'open' AND NOT e.has_draw
  AND e.yes_total = 0 AND e.no_total = 0 AND e.house_seeded_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.sport_bets b WHERE b.event_id = e.id);

-- ---------------------------------------------------------------------------
-- 2. Feed result -> winning pool.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sport_outcome_for_winner(
  p_subject_side text, p_has_draw boolean, p_winner text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_winner = p_subject_side THEN 'yes'
    WHEN p_winner = 'draw' AND p_has_draw THEN 'draw'
    ELSE 'no'
  END;
$$;
REVOKE EXECUTE ON FUNCTION public.sport_outcome_for_winner(text, boolean, text)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Settlement with up to three pools.
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
  IF p_outcome IS NULL OR p_outcome NOT IN ('yes', 'no', 'draw', 'void') THEN
    RAISE EXCEPTION 'Outcome must be yes, no, draw or void';
  END IF;

  SELECT * INTO v_event FROM public.sport_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_event.state IN ('settled', 'void') THEN
    RETURN jsonb_build_object('event_id', p_event_id, 'state', v_event.state, 'already', true);
  END IF;
  IF p_outcome = 'draw' AND NOT v_event.has_draw THEN
    RAISE EXCEPTION 'This match has no Draw pool';
  END IF;

  IF p_outcome <> 'void' THEN
    v_win_total := CASE p_outcome WHEN 'yes' THEN v_event.yes_total
                                  WHEN 'no' THEN v_event.no_total
                                  ELSE v_event.draw_total END;
    v_lose_total := v_event.yes_total + v_event.no_total + v_event.draw_total - v_win_total;
    v_house_lose := v_event.house_yes + v_event.house_no + v_event.house_draw
      - CASE p_outcome WHEN 'yes' THEN v_event.house_yes
                       WHEN 'no' THEN v_event.house_no
                       ELSE v_event.house_draw END;
    -- Nobody to pay, or nothing to win: everyone gets their money back.
    IF v_lose_total = 0 THEN
      p_outcome := 'void';
      v_reason := 'one_sided';
    ELSIF v_win_total = 0 THEN
      p_outcome := 'void';
      v_reason := CASE WHEN v_event.has_draw THEN 'no_winners' ELSE 'one_sided' END;
    END IF;
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
-- 4. Placing a bet: Draw allowed on Draw matches; house money on every pool.
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
  v_draw_seed integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_side IS NULL OR p_side NOT IN ('yes', 'no', 'draw') THEN RAISE EXCEPTION 'Choose Yes, Draw or No'; END IF;
  SELECT * INTO v_settings FROM public.sport_settings WHERE id = 1;
  IF p_amount IS NULL OR p_amount < v_settings.min_bet OR p_amount > v_settings.max_bet THEN
    RAISE EXCEPTION 'Each bet must be a whole number from % to %', v_settings.min_bet, v_settings.max_bet;
  END IF;

  -- Lock order: match, then sport settings (house money only), then profile.
  SELECT * INTO v_event FROM public.sport_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.hidden THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF p_side = 'draw' AND NOT v_event.has_draw THEN
    RAISE EXCEPTION 'This match has no Draw option. Choose Yes or No.';
  END IF;
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
      IF v_event.has_draw THEN v_draw_seed := v_seed; END IF;
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
      draw_total = draw_total + v_draw_seed + CASE WHEN p_side = 'draw' THEN p_amount ELSE 0 END,
      house_yes = house_yes + v_seed,
      house_no = house_no + v_seed,
      house_draw = house_draw + v_draw_seed,
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
    'no_total', v_event.no_total,
    'draw_total', v_event.draw_total
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.place_sport_bet(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_sport_bet(uuid, text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Player list: Draw pool fields.
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
        'has_draw', e.has_draw,
        'yes_total', e.yes_total, 'no_total', e.no_total, 'draw_total', e.draw_total,
        'house_yes', e.house_yes, 'house_no', e.house_no, 'house_draw', e.house_draw,
        'house_seeded', e.house_seeded_at IS NOT NULL,
        'my_yes', COALESCE((SELECT SUM(b.amount) FROM public.sport_bets b
                            WHERE b.event_id = e.id AND b.user_id = v_uid AND b.side = 'yes'), 0),
        'my_no', COALESCE((SELECT SUM(b.amount) FROM public.sport_bets b
                           WHERE b.event_id = e.id AND b.user_id = v_uid AND b.side = 'no'), 0),
        'my_draw', COALESCE((SELECT SUM(b.amount) FROM public.sport_bets b
                             WHERE b.event_id = e.id AND b.user_id = v_uid AND b.side = 'draw'), 0)
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
-- 6. Admin list: Draw pool fields; the most the house can lose on a match is
--    all its money except what sits on the smallest of its pools.
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
      'has_draw', e.has_draw,
      'yes_total', e.yes_total, 'no_total', e.no_total, 'draw_total', e.draw_total,
      'hidden', e.hidden,
      'house_yes', e.house_yes, 'house_no', e.house_no, 'house_draw', e.house_draw,
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
    'at_risk', COALESCE(SUM(CASE WHEN has_draw
        THEN house_yes + house_no + house_draw - LEAST(house_yes, house_no, house_draw)
        ELSE GREATEST(house_yes, house_no) END) FILTER (WHERE state IN ('open', 'closed')), 0)
  )
  INTO v_house
  FROM public.sport_events
  WHERE house_seeded_at IS NOT NULL;

  RETURN jsonb_build_object('settings', v_settings, 'sync', v_sync, 'events', v_events, 'house', v_house);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_sports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_sports() TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Admin manual result: a draw pays the Draw pool on Draw matches.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_settle_sport_event(p_event_id uuid, p_winner text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_event public.sport_events%ROWTYPE;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_winner IS NULL OR p_winner NOT IN ('home', 'away', 'draw') THEN
    RAISE EXCEPTION 'Winner must be home, away or draw';
  END IF;
  SELECT * INTO v_event FROM public.sport_events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_event.state IN ('settled', 'void') THEN
    RAISE EXCEPTION 'This match is already paid out or refunded.';
  END IF;
  IF now() < v_event.starts_at + interval '90 minutes' THEN
    RAISE EXCEPTION 'This match has not finished yet.';
  END IF;
  v_result := public.sport_settle_internal(
    p_event_id, public.sport_outcome_for_winner(v_event.subject_side, v_event.has_draw, p_winner));
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'settle_sport_event', jsonb_build_object('event_id', p_event_id, 'winner', p_winner));
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_settle_sport_event(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_settle_sport_event(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Sync: new football matches get a Draw pool; results map through
--    sport_outcome_for_winner(). Otherwise unchanged from
--    20261117150000_faster_cricket_results.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sports_sync_upsert(p_events jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item jsonb;
  v_existing public.sport_events%ROWTYPE;
  v_fee integer;
  v_starts timestamptz;
  v_status text;
  v_winner text;
  v_signature text;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_settled integer := 0;
  v_voided integer := 0;
  v_event_id uuid;
BEGIN
  IF COALESCE(jsonb_typeof(p_events), 'null') <> 'array' THEN
    RAISE EXCEPTION 'Events must be an array';
  END IF;
  SELECT fee_percent INTO v_fee FROM public.sport_settings WHERE id = 1;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_starts := (v_item->>'starts_at')::timestamptz;
    v_status := v_item->>'status';
    v_winner := NULLIF(v_item->>'winner', '');
    IF v_status NOT IN ('scheduled', 'live', 'finished', 'cancelled')
       OR v_item->>'sport' NOT IN ('football', 'cricket')
       OR (v_winner IS NOT NULL AND v_winner NOT IN ('home', 'away', 'draw')) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM public.sport_events
    WHERE provider = v_item->>'provider' AND provider_event_id = v_item->>'provider_event_id'
    FOR UPDATE;

    IF NOT FOUND THEN
      -- Only matches that can still be bet on are imported.
      IF v_status <> 'scheduled' OR v_starts <= now() THEN CONTINUE; END IF;
      INSERT INTO public.sport_events (
        sport, provider, provider_event_id, competition, competition_name,
        home_team, away_team, subject_side, starts_at, provider_status, fee_percent, has_draw
      ) VALUES (
        v_item->>'sport', v_item->>'provider', v_item->>'provider_event_id',
        left(v_item->>'competition', 40), left(v_item->>'competition_name', 80),
        left(v_item->>'home_team', 80), left(v_item->>'away_team', 80),
        COALESCE(NULLIF(v_item->>'subject_side', ''), 'home'), v_starts, 'scheduled', v_fee,
        v_item->>'sport' = 'football'
      );
      v_inserted := v_inserted + 1;
      CONTINUE;
    END IF;

    IF v_existing.state IN ('settled', 'void') THEN CONTINUE; END IF;
    v_event_id := v_existing.id;

    -- Start time moved earlier than bets already placed: those bets may have
    -- been placed after the real start, so refund the whole match.
    IF v_starts < v_existing.starts_at AND EXISTS (
         SELECT 1 FROM public.sport_bets
         WHERE event_id = v_event_id AND created_at >= v_starts) THEN
      PERFORM public.sport_settle_internal(v_event_id, 'void', 'start_moved_earlier');
      v_voided := v_voided + 1;
      CONTINUE;
    END IF;

    IF v_status = 'cancelled' THEN
      PERFORM public.sport_settle_internal(v_event_id, 'void', 'cancelled_or_postponed');
      v_voided := v_voided + 1;
      CONTINUE;
    END IF;

    UPDATE public.sport_events
    SET starts_at = v_starts,
        provider_status = v_status,
        home_score = NULLIF(v_item->>'home_score', ''),
        away_score = NULLIF(v_item->>'away_score', ''),
        state = CASE WHEN v_status <> 'scheduled' OR v_starts <= now() THEN 'closed' ELSE state END,
        updated_at = now()
    WHERE id = v_event_id;
    v_updated := v_updated + 1;

    IF v_status = 'finished' AND v_winner IS NOT NULL THEN
      v_signature := v_winner || ':' || COALESCE(v_item->>'home_score', '') || '-' || COALESCE(v_item->>'away_score', '');
      IF v_existing.result_signature IS DISTINCT FROM v_signature THEN
        UPDATE public.sport_events
        SET result_winner = v_winner, result_signature = v_signature, result_seen_at = now()
        WHERE id = v_event_id;
      ELSIF v_existing.result_seen_at <= now() - (CASE WHEN v_existing.sport = 'cricket'
                                              THEN interval '15 minutes' ELSE interval '30 minutes' END) THEN
        PERFORM public.sport_settle_internal(v_event_id,
          public.sport_outcome_for_winner(v_existing.subject_side, v_existing.has_draw, v_winner));
        v_settled := v_settled + 1;
      END IF;
    END IF;
  END LOOP;

  -- Close betting on matches that have started.
  UPDATE public.sport_events SET state = 'closed', updated_at = now()
  WHERE state = 'open' AND starts_at <= now();

  -- No result within 7 days (a Test lasts up to 5): refund.
  FOR v_event_id IN
    SELECT id FROM public.sport_events
    WHERE state IN ('open', 'closed') AND starts_at < now() - interval '7 days'
  LOOP
    PERFORM public.sport_settle_internal(v_event_id, 'void', 'no_result');
    v_voided := v_voided + 1;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated,
    'settled', v_settled, 'voided', v_voided);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sports_sync_upsert(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sports_sync_upsert(jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Bet histories say whether the match has a Draw pool, so the app can show
--    team names instead of Yes/No. Otherwise unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_sport_bets(
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  SELECT COALESCE(jsonb_agg(r ORDER BY created_at DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT b.created_at, jsonb_build_object(
      'id', b.id, 'side', b.side, 'amount', b.amount, 'status', b.status,
      'payout', b.payout, 'created_at', b.created_at, 'settled_at', b.settled_at,
      'event', jsonb_build_object(
        'id', e.id, 'sport', e.sport, 'competition_name', e.competition_name,
        'home_team', e.home_team, 'away_team', e.away_team,
        'subject_side', e.subject_side, 'starts_at', e.starts_at, 'has_draw', e.has_draw,
        'state', e.state, 'outcome', e.outcome, 'void_reason', e.void_reason,
        'home_score', e.home_score, 'away_score', e.away_score)
    ) AS r
    FROM public.sport_bets b
    JOIN public.sport_events e ON e.id = b.event_id
    WHERE b.user_id = v_uid
    ORDER BY b.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) rows;
  RETURN v_rows;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_sport_bets(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_sport_bets(integer, integer) TO authenticated;

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
  v_sport_bets jsonb;
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
  SELECT COALESCE(jsonb_agg(row_data.item ORDER BY row_data.created_at DESC), '[]'::jsonb)
  INTO v_sport_bets FROM (
    SELECT b.created_at, jsonb_build_object(
      'id', b.id, 'side', b.side, 'amount', b.amount, 'status', b.status, 'payout', b.payout,
      'from_points', b.from_points, 'from_wallet', b.from_wallet,
      'created_at', b.created_at, 'settled_at', b.settled_at,
      'event', jsonb_build_object(
        'id', e.id, 'sport', e.sport, 'competition_name', e.competition_name,
        'home_team', e.home_team, 'away_team', e.away_team, 'subject_side', e.subject_side, 'has_draw', e.has_draw,
        'starts_at', e.starts_at, 'state', e.state, 'outcome', e.outcome,
        'home_score', e.home_score, 'away_score', e.away_score, 'void_reason', e.void_reason)
    ) AS item
    FROM public.sport_bets b
    JOIN public.sport_events e ON e.id = b.event_id
    WHERE b.user_id = p_user_id
    ORDER BY b.created_at DESC LIMIT 50
  ) row_data;
  RETURN jsonb_build_object(
    'sport_bets', v_sport_bets,
    'profile', v_profile, 'limits', v_limits, 'ledger', v_ledger, 'bets', v_bets,
    'deposits', v_deposits, 'withdrawals', v_withdrawals, 'tickets', v_tickets
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_detail(uuid) TO authenticated;

