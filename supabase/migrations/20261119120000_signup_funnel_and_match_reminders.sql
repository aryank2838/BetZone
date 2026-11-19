/*
# Admin sign-up funnel, and "your match starts soon" push reminders

1. admin_signup_funnel(p_days): for players who signed up in the last p_days
   days (NULL = all time, admins left out), how many reached each step:
   signed up -> asked to add money -> money approved -> placed a bet ->
   verified email -> asked to withdraw. Each step counts players who did it
   at any time, as a share of everyone who signed up in that period.

2. Match reminders: about 30 minutes before a football or cricket match, each
   player with an open bet on it (and notifications turned on) gets a push:
   "Arsenal vs Chelsea starts in about 30 minutes. You have Rs 200 on it."
   pg_cron runs push_enqueue_match_reminders() every 5 minutes; each match is
   reminded once (sport_events.reminder_sent_at). The existing send-push job
   delivers the queued rows.
*/

-- 1. Funnel -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_signup_funnel(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_days IS NOT NULL AND (p_days < 1 OR p_days > 3650) THEN RAISE EXCEPTION 'Invalid period'; END IF;

  WITH cohort AS (
    SELECT p.id, p.email_verified_at
    FROM public.profiles p
    WHERE NOT p.is_admin
      AND (p_days IS NULL OR p.created_at >= now() - make_interval(days => p_days))
  )
  SELECT jsonb_build_object(
    'days', p_days,
    'signed_up', count(*),
    'requested_deposit', count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.add_funds_requests a WHERE a.user_id = c.id)),
    'deposit_approved', count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.add_funds_requests a WHERE a.user_id = c.id AND a.status = 'approved')),
    'placed_bet', count(*) FILTER (WHERE
      EXISTS (SELECT 1 FROM public.selections s WHERE s.user_id = c.id)
      OR EXISTS (SELECT 1 FROM public.sport_bets b WHERE b.user_id = c.id)),
    'verified_email', count(*) FILTER (WHERE c.email_verified_at IS NOT NULL),
    'requested_withdrawal', count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.withdrawals w WHERE w.user_id = c.id))
  ) INTO v_result
  FROM cohort c;

  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_signup_funnel(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_signup_funnel(integer) TO authenticated;

-- 2. Match reminders ----------------------------------------------------------
ALTER TABLE public.sport_events
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

ALTER TABLE public.push_outbox DROP CONSTRAINT IF EXISTS push_outbox_kind_check;
ALTER TABLE public.push_outbox
  ADD CONSTRAINT push_outbox_kind_check CHECK (kind IN (
    'deposit_approved', 'deposit_rejected', 'withdrawal_approved', 'withdrawal_rejected', 'winnings',
    'match_starting'
  ));

/** How long before kick-off the reminder goes out. */
CREATE OR REPLACE FUNCTION public.match_reminder_minutes()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 30 $$;
REVOKE EXECUTE ON FUNCTION public.match_reminder_minutes() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.push_enqueue_match_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event record;
  v_player record;
  v_queued integer := 0;
BEGIN
  FOR v_event IN
    SELECT e.id, e.home_team, e.away_team
    FROM public.sport_events e
    WHERE e.reminder_sent_at IS NULL
      AND e.state = 'open'
      AND e.provider_status = 'scheduled'
      AND NOT e.hidden
      AND e.starts_at > now()
      AND e.starts_at <= now() + make_interval(mins => public.match_reminder_minutes())
    ORDER BY e.starts_at
    FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_player IN
      SELECT b.user_id, SUM(b.amount)::bigint AS staked
      FROM public.sport_bets b
      WHERE b.event_id = v_event.id AND b.status = 'open'
      GROUP BY b.user_id
    LOOP
      -- push_enqueue skips players without notifications turned on.
      PERFORM public.push_enqueue(
        v_player.user_id,
        'match_starting',
        LEAST(v_player.staked, 2147483647)::integer,
        left(v_event.home_team || ' vs ' || v_event.away_team, 200)
      );
      v_queued := v_queued + 1;
    END LOOP;
    UPDATE public.sport_events SET reminder_sent_at = now() WHERE id = v_event.id;
  END LOOP;
  RETURN v_queued;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_enqueue_match_reminders() FROM PUBLIC, anon, authenticated;

-- Matches already under way or finished never get a late reminder.
UPDATE public.sport_events
SET reminder_sent_at = now()
WHERE reminder_sent_at IS NULL AND starts_at <= now();

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'match-reminders') THEN
    PERFORM cron.unschedule('match-reminders');
  END IF;
  PERFORM cron.schedule(
    'match-reminders',
    '*/5 * * * *',
    $job$ SELECT public.push_enqueue_match_reminders(); $job$
  );
END;
$cron$;
