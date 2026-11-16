/*
Cricket leagues the admin can switch on: India senior matches ('india'),
the IPL ('ipl'), Women's Big Bash League ('wbbl'), Big Bash League ('bbl')
and Women's Premier League ('wpl'). India, IPL and WBBL start on.
The next sync searches again so newly switched-on leagues are found.
*/
ALTER TABLE public.sport_settings
  ADD COLUMN IF NOT EXISTS cricket_leagues text[] NOT NULL DEFAULT ARRAY['india', 'ipl', 'wbbl'];
UPDATE public.sport_settings SET cricket_leagues = ARRAY['india', 'ipl', 'wbbl'] WHERE id = 1;
GRANT SELECT ON TABLE public.sport_settings TO service_role;
DELETE FROM public.sport_feed_state WHERE key = 'cricket_discovery';

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

  UPDATE public.sport_settings
  SET football_enabled = COALESCE(v_row.football_enabled, false),
      cricket_enabled = COALESCE(v_row.cricket_enabled, false),
      fee_percent = v_row.fee_percent,
      football_competitions = v_row.football_competitions,
      cricket_leagues = v_row.cricket_leagues,
      min_bet = v_row.min_bet, max_bet = v_row.max_bet,
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
