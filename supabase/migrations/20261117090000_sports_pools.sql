/*
Sports pools (football now, cricket later).

How it works
- Each match has one Yes/No question: "Will <team> win?".
- Every Yes bet goes into the Yes pool and every No bet into the No pool.
  The house never puts money in, so it cannot lose.
- Betting closes at the scheduled start time, so nobody can bet with
  knowledge of the match.
- After the match: the house fee (fee_percent of the losing pool, fixed on the
  match when it is imported) is kept, and the rest of the losing pool is
  shared among the winners in proportion to their stakes, on top of their
  own stake back. Payouts are rounded down; the few leftover points stay
  with the house.
- Refund (stake back to the exact balances it came from) when only one side
  has bets, the match is postponed/cancelled, the start time moves earlier
  than bets already placed, or no result arrives within 3 days.
- Admins cannot bet.

Ledger
- A bet is 'selection_submit' and a payout is 'winning_payout' (metadata has
  'game' = the sport), so daily loss limits, today's usage and the balance
  summary count sports with no changes. A refund is the new 'bet_refund'.
- admin_daily_report and get_balance_breakdown are updated so refunded
  stakes are not counted as spent or as house revenue.

Automation
- sports_sync_upsert() and sports_sync_record() are called only by the
  sports-sync Edge Function with the service role.
- A finished result is paid out only after the same result has been seen for
  30 minutes, so a late correction from the feed cannot pay the wrong side.
*/

-- ---------------------------------------------------------------------------
-- 1. Ledger reason for refunds.
-- ---------------------------------------------------------------------------
ALTER TABLE public.point_ledger DROP CONSTRAINT IF EXISTS point_ledger_reason_valid;
ALTER TABLE public.point_ledger
  ADD CONSTRAINT point_ledger_reason_valid CHECK (reason IN (
    'signup_bonus', 'first_deposit_bonus', 'selection_submit', 'winning_payout',
    'withdrawal_request', 'withdrawal_refund', 'add_funds',
    'admin_adjust_points', 'admin_adjust_wallet', 'ad_reward', 'bet_refund'
  ));

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
    'set_sport_settings', 'void_sport_event', 'settle_sport_event'
  ));

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE public.sport_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  football_enabled boolean NOT NULL DEFAULT false,
  cricket_enabled boolean NOT NULL DEFAULT false,
  fee_percent integer NOT NULL DEFAULT 10 CHECK (fee_percent BETWEEN 0 AND 30),
  football_competitions text[] NOT NULL DEFAULT ARRAY['PL', 'CL', 'PD'],
  min_bet integer NOT NULL DEFAULT 10 CHECK (min_bet >= 1),
  max_bet integer NOT NULL DEFAULT 5000 CHECK (max_bet >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  CONSTRAINT sport_settings_bet_range CHECK (min_bet <= max_bet)
);
INSERT INTO public.sport_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE public.sport_sync_status (
  sport text PRIMARY KEY CHECK (sport IN ('football', 'cricket')),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  events_seen integer NOT NULL DEFAULT 0
);

CREATE TABLE public.sport_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL CHECK (sport IN ('football', 'cricket')),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  competition text NOT NULL,
  competition_name text NOT NULL,
  home_team text NOT NULL,
  away_team text NOT NULL,
  -- The question is "Will <subject team> win?"; Yes wins when winner = subject_side.
  subject_side text NOT NULL DEFAULT 'home' CHECK (subject_side IN ('home', 'away')),
  starts_at timestamptz NOT NULL,
  provider_status text NOT NULL DEFAULT 'scheduled'
    CHECK (provider_status IN ('scheduled', 'live', 'finished', 'cancelled')),
  home_score text,
  away_score text,
  result_winner text CHECK (result_winner IN ('home', 'away', 'draw')),
  result_signature text,
  result_seen_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'settled', 'void')),
  fee_percent integer NOT NULL CHECK (fee_percent BETWEEN 0 AND 30),
  yes_total bigint NOT NULL DEFAULT 0 CHECK (yes_total >= 0),
  no_total bigint NOT NULL DEFAULT 0 CHECK (no_total >= 0),
  outcome text CHECK (outcome IN ('yes', 'no')),
  fee_taken bigint,
  void_reason text,
  settled_at timestamptz,
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX sport_events_starts_idx ON public.sport_events (starts_at);
CREATE INDEX sport_events_state_idx ON public.sport_events (state, starts_at);

CREATE TABLE public.sport_bets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.sport_events(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  side text NOT NULL CHECK (side IN ('yes', 'no')),
  amount integer NOT NULL CHECK (amount > 0),
  from_points integer NOT NULL CHECK (from_points >= 0),
  from_wallet integer NOT NULL CHECK (from_wallet >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'refunded')),
  payout integer NOT NULL DEFAULT 0 CHECK (payout >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT sport_bets_split CHECK (from_points + from_wallet = amount)
);
CREATE INDEX sport_bets_event_idx ON public.sport_bets (event_id);
CREATE INDEX sport_bets_user_idx ON public.sport_bets (user_id, created_at DESC);

ALTER TABLE public.sport_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sport_sync_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sport_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sport_bets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sport_settings, public.sport_sync_status,
  public.sport_events, public.sport_bets FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Settlement (internal). p_outcome: 'yes', 'no' or 'void'.
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
  v_distributable bigint;
  v_payout bigint;
  v_paid_extra bigint := 0;
  v_refunded integer := 0;
  v_winners integer := 0;
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
        fee_taken = 0, settled_at = now(), updated_at = now()
    WHERE id = p_event_id;
    RETURN jsonb_build_object('event_id', p_event_id, 'state', 'void',
      'reason', COALESCE(v_reason, 'void'), 'refunded', v_refunded);
  END IF;

  IF p_outcome = 'yes' THEN
    v_win_total := v_event.yes_total; v_lose_total := v_event.no_total;
  ELSE
    v_win_total := v_event.no_total; v_lose_total := v_event.yes_total;
  END IF;
  v_distributable := v_lose_total - (v_lose_total * v_event.fee_percent / 100);

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

  UPDATE public.sport_events
  SET state = 'settled', outcome = p_outcome,
      fee_taken = v_lose_total - v_paid_extra,
      settled_at = now(), updated_at = now()
  WHERE id = p_event_id;

  RETURN jsonb_build_object('event_id', p_event_id, 'state', 'settled',
    'outcome', p_outcome, 'winners', v_winners,
    'fee_taken', v_lose_total - v_paid_extra);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sport_settle_internal(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Player functions.
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
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_sport IS NOT NULL AND p_sport NOT IN ('football', 'cricket') THEN
    RAISE EXCEPTION 'Invalid sport';
  END IF;
  SELECT * INTO v_settings FROM public.sport_settings WHERE id = 1;

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
      AND e.starts_at > now() - interval '2 days'
      AND e.starts_at < now() + interval '8 days'
    ORDER BY e.starts_at
    LIMIT 150
  ) rows;

  RETURN jsonb_build_object(
    'football_enabled', v_settings.football_enabled,
    'cricket_enabled', v_settings.cricket_enabled,
    'min_bet', v_settings.min_bet,
    'max_bet', v_settings.max_bet,
    'events', v_events
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_sport_events(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sport_events(text) TO authenticated;

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
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_side IS NULL OR p_side NOT IN ('yes', 'no') THEN RAISE EXCEPTION 'Choose Yes or No'; END IF;
  SELECT * INTO v_settings FROM public.sport_settings WHERE id = 1;
  IF p_amount IS NULL OR p_amount < v_settings.min_bet OR p_amount > v_settings.max_bet THEN
    RAISE EXCEPTION 'Each bet must be a whole number from % to %', v_settings.min_bet, v_settings.max_bet;
  END IF;

  -- Lock order: match first, then profile (settlement uses the same order).
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
  SET yes_total = yes_total + CASE WHEN p_side = 'yes' THEN p_amount ELSE 0 END,
      no_total = no_total + CASE WHEN p_side = 'no' THEN p_amount ELSE 0 END,
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
        'subject_side', e.subject_side, 'starts_at', e.starts_at,
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

-- ---------------------------------------------------------------------------
-- 5. Admin functions.
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
      'bettors', (SELECT count(DISTINCT b.user_id) FROM public.sport_bets b WHERE b.event_id = e.id)
    ) ORDER BY e.starts_at DESC), '[]'::jsonb)
  INTO v_events
  FROM public.sport_events e
  WHERE e.starts_at > now() - interval '7 days'
     OR e.state IN ('open', 'closed');

  RETURN jsonb_build_object('settings', v_settings, 'sync', v_sync, 'events', v_events);
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
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF COALESCE(jsonb_typeof(p_settings), 'null') <> 'object' THEN
    RAISE EXCEPTION 'Settings must be an object';
  END IF;

  SELECT * INTO v_row FROM public.sport_settings WHERE id = 1 FOR UPDATE;
  IF p_settings ? 'football_enabled' THEN v_row.football_enabled := (p_settings->>'football_enabled')::boolean; END IF;
  IF p_settings ? 'cricket_enabled' THEN v_row.cricket_enabled := (p_settings->>'cricket_enabled')::boolean; END IF;
  IF p_settings ? 'fee_percent' THEN v_row.fee_percent := (p_settings->>'fee_percent')::integer; END IF;
  IF p_settings ? 'min_bet' THEN v_row.min_bet := (p_settings->>'min_bet')::integer; END IF;
  IF p_settings ? 'max_bet' THEN v_row.max_bet := (p_settings->>'max_bet')::integer; END IF;
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
  IF v_row.fee_percent IS NULL OR v_row.fee_percent NOT BETWEEN 0 AND 30 THEN
    RAISE EXCEPTION 'Fee must be from 0 to 30 percent';
  END IF;
  IF v_row.min_bet IS NULL OR v_row.max_bet IS NULL OR v_row.min_bet < 1
     OR v_row.max_bet > 100000 OR v_row.min_bet > v_row.max_bet THEN
    RAISE EXCEPTION 'Bet limits must be whole numbers with minimum at most maximum (maximum up to 100000)';
  END IF;

  UPDATE public.sport_settings
  SET football_enabled = COALESCE(v_row.football_enabled, false),
      cricket_enabled = COALESCE(v_row.cricket_enabled, false),
      fee_percent = v_row.fee_percent,
      football_competitions = v_row.football_competitions,
      min_bet = v_row.min_bet, max_bet = v_row.max_bet,
      updated_at = now(), updated_by = v_uid
  WHERE id = 1;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'set_sport_settings', p_settings);

  RETURN (SELECT to_jsonb(s) - 'id' FROM public.sport_settings s WHERE id = 1);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_set_sport_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_sport_settings(jsonb) TO authenticated;

-- Cancel a match and refund every bet.
CREATE OR REPLACE FUNCTION public.admin_void_sport_event(p_event_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 OR length(v_reason) > 200 THEN
    RAISE EXCEPTION 'Give a reason of 3 to 200 characters';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sport_events
             WHERE id = p_event_id AND state IN ('settled', 'void')) THEN
    RAISE EXCEPTION 'This match is already paid out or refunded.';
  END IF;
  v_result := public.sport_settle_internal(p_event_id, 'void', 'admin: ' || v_reason);
  UPDATE public.sport_events SET hidden = true WHERE id = p_event_id;
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'void_sport_event', jsonb_build_object('event_id', p_event_id, 'reason', v_reason));
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_void_sport_event(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_void_sport_event(uuid, text) TO authenticated;

-- Manual result, for when the automatic result is stuck or wrong before payout.
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
    p_event_id, CASE WHEN p_winner = v_event.subject_side THEN 'yes' ELSE 'no' END);
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'settle_sport_event', jsonb_build_object('event_id', p_event_id, 'winner', p_winner));
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_settle_sport_event(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_settle_sport_event(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Automation (service role only, called by the sports-sync Edge Function).
-- ---------------------------------------------------------------------------
-- p_events: array of {provider, provider_event_id, sport, competition,
--   competition_name, home_team, away_team, subject_side, starts_at,
--   status ('scheduled'|'live'|'finished'|'cancelled'),
--   home_score, away_score, winner ('home'|'away'|'draw'|null)}
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
        home_team, away_team, subject_side, starts_at, provider_status, fee_percent
      ) VALUES (
        v_item->>'sport', v_item->>'provider', v_item->>'provider_event_id',
        left(v_item->>'competition', 20), left(v_item->>'competition_name', 80),
        left(v_item->>'home_team', 80), left(v_item->>'away_team', 80),
        COALESCE(NULLIF(v_item->>'subject_side', ''), 'home'), v_starts, 'scheduled', v_fee
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
      ELSIF v_existing.result_seen_at <= now() - interval '30 minutes' THEN
        PERFORM public.sport_settle_internal(
          v_event_id, CASE WHEN v_winner = v_existing.subject_side THEN 'yes' ELSE 'no' END);
        v_settled := v_settled + 1;
      END IF;
    END IF;
  END LOOP;

  -- Close betting on matches that have started.
  UPDATE public.sport_events SET state = 'closed', updated_at = now()
  WHERE state = 'open' AND starts_at <= now();

  -- No result within 3 days: refund.
  FOR v_event_id IN
    SELECT id FROM public.sport_events
    WHERE state IN ('open', 'closed') AND starts_at < now() - interval '3 days'
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

CREATE OR REPLACE FUNCTION public.sports_sync_record(
  p_sport text, p_ok boolean, p_error text, p_events_seen integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.sport_sync_status (sport, last_run_at, last_success_at, last_error, events_seen)
  VALUES (p_sport, now(), CASE WHEN p_ok THEN now() END,
          CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END, COALESCE(p_events_seen, 0))
  ON CONFLICT (sport) DO UPDATE SET
    last_run_at = now(),
    last_success_at = CASE WHEN p_ok THEN now() ELSE sport_sync_status.last_success_at END,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    events_seen = COALESCE(p_events_seen, sport_sync_status.events_seen);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sports_sync_record(text, boolean, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sports_sync_record(text, boolean, text, integer) TO service_role;

-- The Edge Function reads the settings table with the service role.
GRANT SELECT ON TABLE public.sport_settings TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Refunds are not spending or house revenue.
-- ---------------------------------------------------------------------------
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
  WHERE user_id = v_uid AND reason IN ('signup_bonus', 'first_deposit_bonus');

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

CREATE OR REPLACE FUNCTION public.admin_daily_report(p_date date)
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
  IF p_date IS NULL THEN RAISE EXCEPTION 'Report date is required'; END IF;
  WITH games AS (
    SELECT game FROM public.game_schedule
    UNION SELECT 'football' UNION SELECT 'cricket'
  ), activity AS (
    SELECT metadata->>'game' AS game,
      SUM(CASE WHEN reason = 'selection_submit' THEN -delta::bigint
               WHEN reason = 'bet_refund' THEN -delta::bigint ELSE 0 END) AS staked,
      SUM(CASE WHEN reason = 'winning_payout' THEN delta::bigint ELSE 0 END) AS paid
    FROM public.point_ledger
    WHERE reason IN ('selection_submit', 'winning_payout', 'bet_refund')
      AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = p_date
      AND metadata->>'game' IS NOT NULL
    GROUP BY metadata->>'game'
  ), flows AS (
    SELECT
      COALESCE((SELECT SUM(amount::bigint) FROM public.add_funds_requests
        WHERE status = 'approved' AND processed_at IS NOT NULL
          AND (processed_at AT TIME ZONE 'Asia/Kolkata')::date = p_date), 0) AS deposits,
      COALESCE((SELECT SUM(amount::bigint) FROM public.withdrawals
        WHERE status = 'approved' AND processed_at IS NOT NULL
          AND (processed_at AT TIME ZONE 'Asia/Kolkata')::date = p_date), 0) AS withdrawals
  ), per_game AS (
    SELECT g.game, COALESCE(a.staked, 0) AS total_staked,
      COALESCE(a.paid, 0) AS total_paid_out,
      COALESCE(a.staked, 0) - COALESCE(a.paid, 0) AS gaming_revenue,
      NULL::bigint AS approved_deposits, NULL::bigint AS approved_withdrawals,
      NULL::bigint AS net_cash
    FROM games g LEFT JOIN activity a ON a.game = g.game
  ), overall AS (
    SELECT 'ALL'::text AS game, SUM(total_staked)::bigint AS total_staked,
      SUM(total_paid_out)::bigint AS total_paid_out,
      SUM(gaming_revenue)::bigint AS gaming_revenue,
      f.deposits AS approved_deposits,
      f.withdrawals AS approved_withdrawals,
      f.deposits - f.withdrawals AS net_cash
    FROM per_game CROSS JOIN flows f GROUP BY f.deposits, f.withdrawals
  )
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'game', game,
    'total_staked', total_staked,
    'total_paid_out', total_paid_out,
    'gaming_revenue', gaming_revenue,
    'approved_deposits', approved_deposits,
    'approved_withdrawals', approved_withdrawals,
    'net_cash', net_cash
  )) ORDER BY CASE WHEN game = 'ALL' THEN 1 ELSE 0 END, game), '[]'::jsonb)
  INTO v_result FROM (SELECT * FROM per_game UNION ALL SELECT * FROM overall) report_rows;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_daily_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_daily_report(date) TO authenticated;
