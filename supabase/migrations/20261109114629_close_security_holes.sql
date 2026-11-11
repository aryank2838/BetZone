-- Users must submit selections through the validated RPC, not direct table writes.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.selections FROM authenticated;
DROP POLICY IF EXISTS selections_insert_own ON public.selections;
DROP POLICY IF EXISTS selections_update_own ON public.selections;
DROP POLICY IF EXISTS selections_delete_own ON public.selections;

-- Remove obsolete rewards, overloads, and payout paths.
DROP FUNCTION IF EXISTS public.award_ad_reward();
DROP FUNCTION IF EXISTS public.get_ad_reward_status();
DROP FUNCTION IF EXISTS public.submit_selection(text, jsonb);
DROP FUNCTION IF EXISTS public.request_add_funds(integer, text);
DROP FUNCTION IF EXISTS public.post_winning_number(text, text);
DROP FUNCTION IF EXISTS public.process_payouts(text, date);

-- Payout processing is for internal use only.
REVOKE EXECUTE ON FUNCTION public.process_open_payouts(text, date) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.process_close_payouts(text, date) FROM authenticated;

-- Check for duplicate non-rejected references before applying this migration:
-- SELECT lower(payment_ref), count(*) FROM public.add_funds_requests
-- WHERE status <> 'rejected' GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_add_funds_payment_ref
  ON public.add_funds_requests (lower(payment_ref))
  WHERE status <> 'rejected';
