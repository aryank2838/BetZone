/*
Cricket feed support.

1. sport_feed_series: cricket series the sync follows (India senior series
   and the IPL), with when each was last fetched, so the sync stays within
   cricketdata.org's 100 calls a day. sport_feed_state: last discovery run.
2. sports_sync_upsert(): refunds a match with no result after 7 days instead
   of 3 (a Test lasts up to 5 days), and keeps up to 40 characters of the
   competition code (cricket stores the series id there).
3. get_sport_events(): matches still in progress stay on the list even when
   they started more than 2 days ago (Tests).
*/

CREATE TABLE public.sport_feed_series (
  provider text NOT NULL,
  series_id text NOT NULL,
  name text NOT NULL,
  start_date date,
  end_date date,
  last_fetched_at timestamptz,
  PRIMARY KEY (provider, series_id)
);
CREATE TABLE public.sport_feed_state (
  key text PRIMARY KEY,
  at timestamptz NOT NULL
);
ALTER TABLE public.sport_feed_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sport_feed_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sport_feed_series, public.sport_feed_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sport_feed_series, public.sport_feed_state TO service_role;
-- The sync checks which series have matches in progress.
GRANT SELECT ON TABLE public.sport_events TO service_role;

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
        left(v_item->>'competition', 40), left(v_item->>'competition_name', 80),
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
    'events', v_events
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_sport_events(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sport_events(text) TO authenticated;
