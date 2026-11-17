/*
Push notifications for players.

A player turns notifications on per device (Account → Notifications). The
browser's push subscription is stored in push_subscriptions. These events put
a row in push_outbox, but only for players with at least one subscription:
  - add-money request approved or rejected
  - withdrawal approved (sent) or rejected
  - winnings paid (point_ledger 'winning_payout', Matka and sports)
Every minute, while push_outbox has unsent rows, pg_cron calls the send-push
Edge Function, which claims the rows, merges a player's winnings into one
"You won ₹X" message, and sends them in the language the device chose.

The cron job reads two Vault secrets, so nothing secret is stored here:
  push_send_url     https://<project-ref>.supabase.co/functions/v1/send-push
  push_cron_secret  the same value as the function's PUSH_CRON_SECRET
Until both exist, nothing is called and the queue just waits.
*/

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi', 'mr')),
  failure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON public.push_subscriptions (user_id);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.push_outbox (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'deposit_approved', 'deposit_rejected', 'withdrawal_approved', 'withdrawal_rejected', 'winnings'
  )),
  amount integer NOT NULL CHECK (amount >= 0),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS push_outbox_unsent_idx ON public.push_outbox (id) WHERE sent_at IS NULL;
ALTER TABLE public.push_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.push_outbox_id_seq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Player RPCs
-- ---------------------------------------------------------------------------

-- Saves (or moves to the current player) this device's subscription.
CREATE OR REPLACE FUNCTION public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_language text DEFAULT 'en'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR length(p_endpoint) > 1000 THEN
    RAISE EXCEPTION 'Invalid push endpoint';
  END IF;
  IF p_p256dh IS NULL OR p_p256dh !~ '^[A-Za-z0-9_-]{80,100}$' THEN RAISE EXCEPTION 'Invalid push key'; END IF;
  IF p_auth IS NULL OR p_auth !~ '^[A-Za-z0-9_-]{16,40}$' THEN RAISE EXCEPTION 'Invalid push key'; END IF;

  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, language)
  VALUES (
    v_uid, p_endpoint, p_p256dh, p_auth,
    CASE WHEN p_language IN ('en', 'hi', 'mr') THEN p_language ELSE 'en' END
  )
  ON CONFLICT (endpoint) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      language = EXCLUDED.language,
      failure_count = 0,
      updated_at = now();

  -- Keep at most 10 devices per player.
  DELETE FROM public.push_subscriptions
  WHERE id IN (
    SELECT id FROM public.push_subscriptions
    WHERE user_id = v_uid
    ORDER BY updated_at DESC
    OFFSET 10
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text) TO authenticated;

-- Turns notifications off for this device.
CREATE OR REPLACE FUNCTION public.delete_push_subscription(p_endpoint text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint AND user_id = auth.uid();
END;
$$;
REVOKE EXECUTE ON FUNCTION public.delete_push_subscription(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Queueing (triggers)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.push_enqueue(p_user_id uuid, p_kind text, p_amount integer, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_amount IS NULL OR p_amount < 0 THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = p_user_id) THEN RETURN; END IF;
  INSERT INTO public.push_outbox (user_id, kind, amount, reason)
  VALUES (p_user_id, p_kind, p_amount, NULLIF(left(btrim(COALESCE(p_reason, '')), 200), ''));
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_enqueue(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.push_on_add_funds_decided()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    PERFORM public.push_enqueue(
      NEW.user_id,
      CASE NEW.status WHEN 'approved' THEN 'deposit_approved' ELSE 'deposit_rejected' END,
      NEW.amount,
      CASE WHEN NEW.status = 'rejected' THEN NEW.reject_reason END
    );
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_on_add_funds_decided() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS push_add_funds_decided ON public.add_funds_requests;
CREATE TRIGGER push_add_funds_decided
  AFTER UPDATE OF status ON public.add_funds_requests
  FOR EACH ROW EXECUTE FUNCTION public.push_on_add_funds_decided();

CREATE OR REPLACE FUNCTION public.push_on_withdrawal_decided()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    PERFORM public.push_enqueue(
      NEW.user_id,
      CASE NEW.status WHEN 'approved' THEN 'withdrawal_approved' ELSE 'withdrawal_rejected' END,
      NEW.amount,
      CASE WHEN NEW.status = 'rejected' THEN NEW.reject_reason END
    );
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_on_withdrawal_decided() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS push_withdrawal_decided ON public.withdrawals;
CREATE TRIGGER push_withdrawal_decided
  AFTER UPDATE OF status ON public.withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.push_on_withdrawal_decided();

CREATE OR REPLACE FUNCTION public.push_on_winning_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.reason = 'winning_payout' AND NEW.delta > 0 THEN
    PERFORM public.push_enqueue(NEW.user_id, 'winnings', NEW.delta, NULL);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_on_winning_payout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS push_winning_payout ON public.point_ledger;
CREATE TRIGGER push_winning_payout
  AFTER INSERT ON public.point_ledger
  FOR EACH ROW EXECUTE FUNCTION public.push_on_winning_payout();

-- ---------------------------------------------------------------------------
-- Used by the send-push Edge Function (service role only)
-- ---------------------------------------------------------------------------

-- Marks up to p_limit unsent rows as sent and returns them. Rows older than
-- 6 hours are dropped unsent: a late "money added" is more confusing than none.
CREATE OR REPLACE FUNCTION public.push_claim_outbox(p_limit integer DEFAULT 500)
RETURNS TABLE (id bigint, user_id uuid, kind text, amount integer, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  DELETE FROM public.push_outbox o
  WHERE (o.sent_at IS NOT NULL AND o.sent_at < now() - interval '7 days')
     OR (o.sent_at IS NULL AND o.created_at < now() - interval '6 hours');

  RETURN QUERY
  UPDATE public.push_outbox o
  SET sent_at = now()
  WHERE o.id IN (
    SELECT q.id FROM public.push_outbox q
    WHERE q.sent_at IS NULL
    ORDER BY q.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))
    FOR UPDATE SKIP LOCKED
  )
  RETURNING o.id, o.user_id, o.kind, o.amount, o.reason;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_claim_outbox(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_claim_outbox(integer) TO service_role;

-- Deletes expired subscriptions, and ones that failed 5 runs in a row.
CREATE OR REPLACE FUNCTION public.push_record_results(p_gone uuid[], p_failed uuid[], p_delivered uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.push_subscriptions WHERE id = ANY (COALESCE(p_gone, ARRAY[]::uuid[]));
  UPDATE public.push_subscriptions SET failure_count = 0
  WHERE id = ANY (COALESCE(p_delivered, ARRAY[]::uuid[])) AND failure_count <> 0;
  UPDATE public.push_subscriptions SET failure_count = failure_count + 1
  WHERE id = ANY (COALESCE(p_failed, ARRAY[]::uuid[]));
  DELETE FROM public.push_subscriptions WHERE failure_count >= 5;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_record_results(uuid[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_record_results(uuid[], uuid[], uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Cron: call send-push every minute while there is something to send
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-push') THEN
    PERFORM cron.unschedule('send-push');
  END IF;
  PERFORM cron.schedule(
    'send-push',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'push_send_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'push_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      )
      WHERE EXISTS (SELECT 1 FROM public.push_outbox WHERE sent_at IS NULL)
        AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'push_send_url');
    $job$
  );
END;
$cron$;
