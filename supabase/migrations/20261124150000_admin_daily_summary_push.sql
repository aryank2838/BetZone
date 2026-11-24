/*
# Nightly summary push for admins

Every night at 00:30 IST each admin with notifications on gets one push
summing up the IST day that just ended, counted the same way as the Reports
tab (admin_daily_report): Matka and sports together.

  amount = total staked (bets minus refunds)
  reason = 'p=<paid out>;d=<approved deposits>;w=<approved withdrawals>;n=<new players>'
The send-push function turns these into "Profit ₹X" / "Loss ₹X" text in the
admin's language.

Results that land just after midnight (Main Bazaar close) count towards the
next day, as they do in the Reports tab.
*/

ALTER TABLE public.push_outbox DROP CONSTRAINT IF EXISTS push_outbox_kind_check;
ALTER TABLE public.push_outbox
  ADD CONSTRAINT push_outbox_kind_check CHECK (kind IN (
    'deposit_approved', 'deposit_rejected', 'withdrawal_approved', 'withdrawal_rejected', 'winnings',
    'match_starting', 'referral_bonus',
    'admin_deposit', 'admin_withdrawal', 'admin_waiting', 'admin_test',
    'admin_daily_summary'
  ));

-- Queues the summary for p_date (default: yesterday in IST). Run by cron.
CREATE OR REPLACE FUNCTION public.push_enqueue_admin_daily_summary(p_date date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_date date := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Kolkata')::date - 1);
  v_staked bigint;
  v_paid bigint;
  v_deposits bigint;
  v_withdrawals bigint;
  v_new_players bigint;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN reason IN ('selection_submit', 'bet_refund') THEN -delta::bigint ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN reason = 'winning_payout' THEN delta::bigint ELSE 0 END), 0)
  INTO v_staked, v_paid
  FROM public.point_ledger
  WHERE reason IN ('selection_submit', 'winning_payout', 'bet_refund')
    AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = v_date
    AND metadata->>'game' IS NOT NULL;

  SELECT COALESCE(SUM(amount::bigint), 0) INTO v_deposits
  FROM public.add_funds_requests
  WHERE status = 'approved' AND processed_at IS NOT NULL
    AND (processed_at AT TIME ZONE 'Asia/Kolkata')::date = v_date;

  SELECT COALESCE(SUM(amount::bigint), 0) INTO v_withdrawals
  FROM public.withdrawals
  WHERE status = 'approved' AND processed_at IS NOT NULL
    AND (processed_at AT TIME ZONE 'Asia/Kolkata')::date = v_date;

  SELECT count(*) INTO v_new_players
  FROM public.profiles
  WHERE NOT is_admin AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = v_date;

  RETURN public.push_enqueue_admins(
    'admin_daily_summary',
    LEAST(GREATEST(v_staked, 0), 2147483647)::integer,
    format('p=%s;d=%s;w=%s;n=%s', v_paid, v_deposits, v_withdrawals, v_new_players)
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.push_enqueue_admin_daily_summary(date) FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-daily-summary') THEN
    PERFORM cron.unschedule('admin-daily-summary');
  END IF;
  -- 19:00 UTC = 00:30 IST.
  PERFORM cron.schedule(
    'admin-daily-summary',
    '0 19 * * *',
    $job$ SELECT public.push_enqueue_admin_daily_summary(); $job$
  );
END;
$cron$;
