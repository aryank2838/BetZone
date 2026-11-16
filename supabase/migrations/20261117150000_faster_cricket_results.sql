/*
Faster cricket payouts.

1. sport_feed_series.next_check_at: when the sync should next fetch a
   series' fixtures. The sports-sync function sets it from the match formats
   and start times (every 15 minutes once a match could be finishing, rarely
   before that), instead of a fixed hourly check.
2. sports_sync_upsert(): a cricket result is paid once it has been seen for
   15 minutes (football stays at 30).
*/
ALTER TABLE public.sport_feed_series ADD COLUMN IF NOT EXISTS next_check_at timestamptz;

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
      ELSIF v_existing.result_seen_at <= now() - (CASE WHEN v_existing.sport = 'cricket'
                                              THEN interval '15 minutes' ELSE interval '30 minutes' END) THEN
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
