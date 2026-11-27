/*
# Totals for the admin Requests tab

admin_request_totals(kind, from, to, search) sums add-money requests
(kind = 'add_funds') or withdrawals (kind = 'withdrawals') created between
the two IST dates, split by status. It uses the same date and search rules as
admin_list_add_funds / admin_list_withdrawals, so the totals match the list,
but it ignores the status filter and always returns every status.
*/

CREATE OR REPLACE FUNCTION public.admin_request_totals(
  p_kind text,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_search text := lower(trim(COALESCE(p_search, '')));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can see request totals'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('add_funds', 'withdrawals') THEN
    RAISE EXCEPTION 'Invalid request kind';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;

  WITH rows AS (
    SELECT a.status, a.amount::bigint AS amount
    FROM public.add_funds_requests a
    JOIN public.profiles p ON p.id = a.user_id
    WHERE p_kind = 'add_funds'
      AND (p_from IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
      AND (v_search = '' OR lower(p.display_name) LIKE '%' || v_search || '%'
           OR lower(a.payment_ref) LIKE '%' || v_search || '%')
    UNION ALL
    SELECT w.status, w.amount::bigint
    FROM public.withdrawals w
    JOIN public.profiles p ON p.id = w.user_id
    WHERE p_kind = 'withdrawals'
      AND (p_from IS NULL OR (w.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (w.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
      AND (v_search = '' OR lower(p.display_name) LIKE '%' || v_search || '%')
  )
  SELECT jsonb_build_object(
    'approved_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0),
    'approved_count', COUNT(*) FILTER (WHERE status = 'approved'),
    'pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'pending_count', COUNT(*) FILTER (WHERE status = 'pending'),
    'rejected_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'rejected'), 0),
    'rejected_count', COUNT(*) FILTER (WHERE status = 'rejected')
  )
  INTO v_result
  FROM rows;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_request_totals(text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_request_totals(text, date, date, text) TO authenticated;
