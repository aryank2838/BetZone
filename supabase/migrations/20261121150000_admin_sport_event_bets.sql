/*
Admin Sports tab: every player's bet on one match.

admin_sport_event_bets(event_id) lists the real players' bets (house money is
not a bet and is not included), newest first, with the player's name, side,
amount, how it was paid for, status and payout.
*/
CREATE OR REPLACE FUNCTION public.admin_sport_event_bets(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_event_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.sport_events WHERE id = p_event_id) THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', b.id,
      'user_id', b.user_id,
      'user_name', p.display_name,
      'side', b.side,
      'amount', b.amount,
      'from_points', b.from_points,
      'from_wallet', b.from_wallet,
      'status', b.status,
      'payout', b.payout,
      'created_at', b.created_at
    ) ORDER BY b.created_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM public.sport_bets b
  JOIN public.profiles p ON p.id = b.user_id
  WHERE b.event_id = p_event_id;

  RETURN v_rows;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_sport_event_bets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_sport_event_bets(uuid) TO authenticated;
