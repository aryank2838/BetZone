/*
1. Push notifications for admins.

Until now admins only heard about new requests while BetZone was open in a
tab (Realtime + a page notification). These now go out as real Web Push, the
same way player notifications do, so they reach an admin's phone with the app
closed:
  - admin_deposit     a player sent an add-money request
  - admin_withdrawal  a player asked to withdraw
  - admin_waiting     requests have been waiting 10+ minutes (repeats every
                      30 minutes while anything is still waiting)
  - admin_test        "Send a test" from the admin alert controls
Rows go to push_outbox for every admin with notifications on, and the
existing send-push cron delivers them within a minute.

A failure while queueing never blocks the player's request.

2. get_my_sport_bet_totals(): open bets and results for the My Bets page.
*/

-- ---------------------------------------------------------------------------
-- 1. Admin push
-- ---------------------------------------------------------------------------
ALTER TABLE public.push_outbox DROP CONSTRAINT IF EXISTS push_outbox_kind_check;
ALTER TABLE public.push_outbox
  ADD CONSTRAINT push_outbox_kind_check CHECK (kind IN (
    'deposit_approved', 'deposit_rejected', 'withdrawal_approved', 'withdrawal_rejected', 'winnings',
    'match_starting', 'referral_bonus',
    'admin_deposit', 'admin_withdrawal', 'admin_waiting', 'admin_test'
  ));

-- When the last "still waiting" reminder went out.
CREATE TABLE IF NOT EXISTS public.admin_push_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  waiting_reminded_at timestamptz
);
INSERT INTO public.admin_push_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.admin_push_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_push_state FROM PUBLIC, anon, authenticated;

-- Queues one notification for each admin who has notifications on.
CREATE OR REPLACE FUNCTION public.push_enqueue_admins(p_kind text, p_amount integer, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_kind NOT LIKE 'admin\_%' OR p_amount IS NULL OR p_amount < 0 THEN RETURN 0; END IF;
  INSERT INTO public.push_outbox (user_id, kind, amount, reason)
  SELECT p.id, p_kind, p_amount, NULLIF(left(btrim(COALESCE(p_reason, '')), 200), '')
  FROM public.profiles p
  WHERE p.is_admin
    AND NOT p.is_banned
    AND EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = p.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_enqueue_admins(text, integer, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.push_on_request_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  IF NEW.status <> 'pending' THEN RETURN NULL; END IF;
  BEGIN
    SELECT display_name INTO v_name FROM public.profiles WHERE id = NEW.user_id;
    PERFORM public.push_enqueue_admins(
      CASE TG_TABLE_NAME WHEN 'withdrawals' THEN 'admin_withdrawal' ELSE 'admin_deposit' END,
      NEW.amount,
      v_name
    );
  EXCEPTION WHEN OTHERS THEN
    -- A notification is never worth failing the player's request over.
    RAISE WARNING 'admin push not queued: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_on_request_created() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS push_admin_add_funds_created ON public.add_funds_requests;
CREATE TRIGGER push_admin_add_funds_created
  AFTER INSERT ON public.add_funds_requests
  FOR EACH ROW EXECUTE FUNCTION public.push_on_request_created();

DROP TRIGGER IF EXISTS push_admin_withdrawal_created ON public.withdrawals;
CREATE TRIGGER push_admin_withdrawal_created
  AFTER INSERT ON public.withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.push_on_request_created();

/** First reminder after a request has waited this long, then every 30 minutes. */
CREATE OR REPLACE FUNCTION public.admin_waiting_reminder_minutes()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 10 $$;
REVOKE EXECUTE ON FUNCTION public.admin_waiting_reminder_minutes() FROM PUBLIC, anon, authenticated;

-- Run by cron every 5 minutes. amount = how many requests are waiting,
-- reason = minutes the oldest one has waited.
CREATE OR REPLACE FUNCTION public.push_enqueue_admin_waiting_reminder()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
  v_oldest timestamptz;
  v_reminded_at timestamptz;
BEGIN
  SELECT count(*)::integer, min(created_at) INTO v_count, v_oldest
  FROM (
    SELECT created_at FROM public.add_funds_requests WHERE status = 'pending'
    UNION ALL
    SELECT created_at FROM public.withdrawals WHERE status = 'pending'
  ) waiting;

  SELECT waiting_reminded_at INTO v_reminded_at FROM public.admin_push_state WHERE id = 1 FOR UPDATE;

  IF v_count = 0 THEN
    -- All clear: the next request gets its first reminder on time.
    IF v_reminded_at IS NOT NULL THEN
      UPDATE public.admin_push_state SET waiting_reminded_at = NULL WHERE id = 1;
    END IF;
    RETURN 0;
  END IF;
  IF v_oldest > now() - make_interval(mins => public.admin_waiting_reminder_minutes()) THEN RETURN 0; END IF;
  IF v_reminded_at IS NOT NULL AND v_reminded_at > now() - interval '30 minutes' THEN RETURN 0; END IF;

  UPDATE public.admin_push_state SET waiting_reminded_at = now() WHERE id = 1;
  RETURN public.push_enqueue_admins(
    'admin_waiting',
    v_count,
    floor(extract(epoch FROM now() - v_oldest) / 60)::bigint::text
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_enqueue_admin_waiting_reminder() FROM PUBLIC, anon, authenticated;

-- Sends a test notification to the calling admin's devices.
CREATE OR REPLACE FUNCTION public.admin_send_test_push()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_devices integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  SELECT count(*)::integer INTO v_devices FROM public.push_subscriptions WHERE user_id = v_uid;
  IF v_devices = 0 THEN RAISE EXCEPTION 'Turn on notifications on this device first.'; END IF;
  -- At most one waiting test, so the button cannot flood the queue.
  IF NOT EXISTS (
    SELECT 1 FROM public.push_outbox WHERE user_id = v_uid AND kind = 'admin_test' AND sent_at IS NULL
  ) THEN
    INSERT INTO public.push_outbox (user_id, kind, amount) VALUES (v_uid, 'admin_test', 0);
  END IF;
  RETURN v_devices;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_send_test_push() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_send_test_push() TO authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-waiting-reminder') THEN
    PERFORM cron.unschedule('admin-waiting-reminder');
  END IF;
  PERFORM cron.schedule(
    'admin-waiting-reminder',
    '*/5 * * * *',
    $job$ SELECT public.push_enqueue_admin_waiting_reminder(); $job$
  );
END;
$cron$;

-- ---------------------------------------------------------------------------
-- 2. Sports bet totals for My Bets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_sport_bet_totals()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT jsonb_build_object(
    'bet_count', count(*),
    'open_count', count(*) FILTER (WHERE status = 'open'),
    'open_stake', COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0),
    'won_count', count(*) FILTER (WHERE status = 'won'),
    'settled_stake', COALESCE(sum(amount) FILTER (WHERE status IN ('won', 'lost')), 0),
    'returned', COALESCE(sum(payout) FILTER (WHERE status = 'won'), 0)
  ) INTO v_result
  FROM public.sport_bets
  WHERE user_id = v_uid;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_sport_bet_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_sport_bet_totals() TO authenticated;
