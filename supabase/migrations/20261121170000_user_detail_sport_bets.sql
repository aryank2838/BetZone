/*
Admin → Users → user details now include the player's sports bets
(newest 50): match, question, side, amount, status and payout. Added as a new
'sport_bets' key; everything else admin_get_user_detail returns is unchanged.
*/
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
        'home_team', e.home_team, 'away_team', e.away_team, 'subject_side', e.subject_side,
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

