/*
# Winners ticker on the home screen

1. get_recent_winners(): the latest real wins (Matka and sports) for the
   scrolling strip on Home. One row per player per payout, so several winning
   bets settled by the same result show as one total.
   - Names are hidden: only the first letter of the display name, e.g. "A***".
   - Admin accounts are left out, so test bets never appear.
   - Only the last 3 days, at most 20 rows.
   - Returns nothing when the admin has turned the ticker off.

2. New admin setting 'winners_ticker' ('on' or 'off', default on), saved with
   admin_set_app_setting and listed by admin_get_settings. Both functions are
   re-created from their latest versions with only that key added.
*/

-- 1. Recent winners ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_recent_winners()
RETURNS TABLE(
  player text,
  game text,
  game_label text,
  amount bigint,
  won_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF COALESCE((SELECT value FROM public.app_settings WHERE key = 'winners_ticker'), 'on') <> 'on' THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH wins AS (
    SELECT l.user_id, l.metadata->>'game' AS game, l.created_at, SUM(l.delta)::bigint AS amount
    FROM public.point_ledger l
    WHERE l.reason = 'winning_payout'
      AND l.delta > 0
      AND l.created_at >= now() - interval '3 days'
    GROUP BY l.user_id, l.metadata->>'game', l.created_at
  )
  SELECT
    upper(left(COALESCE(NULLIF(btrim(split_part(p.display_name, '@', 1)), ''), 'P'), 1)) || '***',
    w.game,
    COALESCE(s.label, initcap(w.game)),
    w.amount,
    w.created_at
  FROM wins w
  JOIN public.profiles p ON p.id = w.user_id
  LEFT JOIN public.game_schedule s ON s.game = w.game
  WHERE NOT p.is_admin
  ORDER BY w.created_at DESC
  LIMIT 20;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_recent_winners() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recent_winners() TO authenticated;

CREATE INDEX IF NOT EXISTS idx_point_ledger_winning_payout_created
  ON public.point_ledger (created_at DESC)
  WHERE reason = 'winning_payout';

-- 2. Admin setting ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_app_setting(p_key text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_numeric numeric;
  v_value text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can update settings'; END IF;
  IF p_key IS NULL OR p_key NOT IN (
    'merchant_upi_id', 'merchant_name', 'approval_time_note',
    'support_whatsapp', 'support_email',
    'max_user_round_points', 'max_number_liability',
    'winners_ticker'
  ) THEN RAISE EXCEPTION 'Unknown setting'; END IF;
  IF p_value IS NULL THEN RAISE EXCEPTION 'Setting value is required'; END IF;
  v_value := trim(p_value);
  IF p_key NOT IN ('approval_time_note', 'support_whatsapp', 'support_email') AND length(v_value) = 0 THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;
  IF p_key = 'approval_time_note' AND char_length(v_value) > 120 THEN
    RAISE EXCEPTION 'Approval time note cannot exceed 120 characters';
  END IF;
  IF p_key = 'merchant_upi_id' AND v_value !~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$' THEN
    RAISE EXCEPTION 'UPI ID must use the format username@provider';
  END IF;
  IF p_key = 'support_whatsapp' AND length(v_value) > 32 THEN
    RAISE EXCEPTION 'Support WhatsApp number is invalid';
  END IF;
  IF p_key = 'support_whatsapp' AND length(v_value) > 0
     AND v_value !~ '^\+?[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Support WhatsApp must be an international phone number';
  END IF;
  IF p_key = 'support_email' AND length(v_value) > 254 THEN
    RAISE EXCEPTION 'Support email is invalid';
  END IF;
  IF p_key = 'support_email' AND length(v_value) > 0
     AND v_value !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
    RAISE EXCEPTION 'Support email is invalid';
  END IF;
  IF p_key IN ('max_user_round_points', 'max_number_liability') THEN
    IF v_value !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'Exposure limits must be positive whole numbers'; END IF;
    v_numeric := v_value::numeric;
    IF v_numeric > 2147483647 THEN RAISE EXCEPTION 'Exposure limit is too large'; END IF;
  END IF;
  IF p_key = 'winners_ticker' AND v_value NOT IN ('on', 'off') THEN
    RAISE EXCEPTION 'Winners ticker must be on or off';
  END IF;
  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES (p_key, v_value, v_uid)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = v_uid, updated_at = now();
  INSERT INTO public.admin_action_log (actor_id, action, metadata)
  VALUES (v_uid, 'set_setting', jsonb_build_object('key', p_key, 'value', v_value));
  RETURN jsonb_build_object('key', p_key, 'value', v_value);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_set_app_setting(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_app_setting(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_settings()
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
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'key', settings.setting_key,
    'value', app.value,
    'updated_at', app.updated_at,
    'updated_by', app.updated_by,
    'updated_by_display_name', profile.display_name
  ) ORDER BY settings.setting_key), '[]'::jsonb)
  INTO v_result
  FROM (VALUES
    ('approval_time_note'),
    ('max_number_liability'),
    ('max_user_round_points'),
    ('merchant_name'),
    ('merchant_upi_id'),
    ('support_email'),
    ('support_whatsapp'),
    ('winners_ticker')
  ) AS settings(setting_key)
  LEFT JOIN public.app_settings app ON app.key = settings.setting_key
  LEFT JOIN public.profiles profile ON profile.id = app.updated_by;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_get_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_settings() TO authenticated;
