-- 1. Live admin alerts (Supabase Realtime).
--    Realtime only sends a row change to a subscriber who could SELECT that
--    row, so admins get a read policy on both request tables. Admins can
--    already read every request through admin_list_* RPCs; this adds no new
--    data access. Players keep seeing only their own rows (existing policies),
--    which also lets the app show their own request updates live.
DROP POLICY IF EXISTS "withdrawals_select_admin" ON public.withdrawals;
CREATE POLICY "withdrawals_select_admin"
  ON public.withdrawals FOR SELECT TO authenticated
  USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "add_funds_select_admin" ON public.add_funds_requests;
CREATE POLICY "add_funds_select_admin"
  ON public.add_funds_requests FOR SELECT TO authenticated
  USING (public.is_current_user_admin());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'withdrawals'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.withdrawals;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'add_funds_requests'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.add_funds_requests;
    END IF;
  END IF;
END;
$$;

-- 2. Money notices for players ("₹500 added to your balance").
--    The app shows approved/rejected requests processed after this time, then
--    moves it forward. Existing users start from now so nobody is shown a
--    backlog of old requests.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS money_notices_seen_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.mark_money_notices_seen(p_until timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_seen timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_uid := auth.uid();
  IF p_until IS NULL THEN RAISE EXCEPTION 'A time is required'; END IF;
  -- Never move backwards, and never past the server clock.
  UPDATE public.profiles
  SET money_notices_seen_at = GREATEST(money_notices_seen_at, LEAST(p_until, now()))
  WHERE id = v_uid
  RETURNING money_notices_seen_at INTO v_seen;
  RETURN v_seen;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mark_money_notices_seen(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_money_notices_seen(timestamptz) TO authenticated;
