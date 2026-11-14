-- Free-plan storage is 1 GB, and payment screenshots were kept forever.
-- Screenshots of add-money requests that were approved or rejected more than
-- 30 days ago are now deleted. Supabase only allows deleting files through the
-- Storage API, so the admin's app does the deleting (once a day) using these
-- pieces:
--   1. admin_old_screenshot_paths  -> which files are old enough to delete
--   2. a storage DELETE policy      -> lets the admin delete only those files
--   3. admin_mark_screenshots_removed -> records that the file is gone
-- The request row (amount, UTR, status, screenshot_path) is kept for records.
-- Pending requests are never touched.

ALTER TABLE public.add_funds_requests
  ADD COLUMN IF NOT EXISTS screenshot_removed_at timestamptz;

-- How long a settled request keeps its screenshot.
CREATE OR REPLACE FUNCTION public.screenshot_retention_days()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 30 $$;

-- 1. Paths of screenshots that may be deleted.
CREATE OR REPLACE FUNCTION public.admin_old_screenshot_paths(p_limit integer DEFAULT 100)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_paths text[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can clean up screenshots'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'Invalid limit'; END IF;
  SELECT COALESCE(array_agg(screenshot_path), ARRAY[]::text[]) INTO v_paths
  FROM (
    SELECT a.screenshot_path
    FROM public.add_funds_requests a
    WHERE a.status IN ('approved', 'rejected')
      AND a.screenshot_path IS NOT NULL
      AND a.screenshot_removed_at IS NULL
      AND a.processed_at < now() - make_interval(days => public.screenshot_retention_days())
    ORDER BY a.processed_at
    LIMIT p_limit
  ) old;
  RETURN v_paths;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_old_screenshot_paths(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_old_screenshot_paths(integer) TO authenticated;

-- 2. The admin may delete a screenshot only once its request is settled and
-- past the retention period. Proof for pending or recent requests stays safe.
-- SECURITY DEFINER so the check sees every request regardless of row security.
CREATE OR REPLACE FUNCTION public.admin_can_delete_screenshot(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.is_current_user_admin()
    AND EXISTS (
      SELECT 1 FROM public.add_funds_requests a
      WHERE a.screenshot_path = p_name
        AND a.status IN ('approved', 'rejected')
        AND a.processed_at < now() - make_interval(days => public.screenshot_retention_days())
    )
    -- never delete a file that a newer, unsettled request also points to
    AND NOT EXISTS (
      SELECT 1 FROM public.add_funds_requests a
      WHERE a.screenshot_path = p_name AND a.status = 'pending'
    );
$$;
REVOKE EXECUTE ON FUNCTION public.admin_can_delete_screenshot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_can_delete_screenshot(text) TO authenticated;

DROP POLICY IF EXISTS "admins_delete_old_screenshots" ON storage.objects;
CREATE POLICY "admins_delete_old_screenshots"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'payment-screenshots'
  AND public.admin_can_delete_screenshot(name)
);

-- 3. Mark screenshots as removed, but only those whose file is really gone.
CREATE OR REPLACE FUNCTION public.admin_mark_screenshots_removed(p_paths text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can clean up screenshots'; END IF;
  IF p_paths IS NULL OR cardinality(p_paths) = 0 THEN RETURN 0; END IF;
  UPDATE public.add_funds_requests a
  SET screenshot_removed_at = now()
  WHERE a.screenshot_path = ANY (p_paths)
    AND a.screenshot_removed_at IS NULL
    AND a.status IN ('approved', 'rejected')
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'payment-screenshots' AND o.name = a.screenshot_path
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_mark_screenshots_removed(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_screenshots_removed(text[]) TO authenticated;

-- The admin request list now says when a screenshot was removed.
CREATE OR REPLACE FUNCTION public.admin_list_add_funds(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_status text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_search text := lower(trim(COALESCE(p_search, '')));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_current_user_admin() THEN RAISE EXCEPTION 'Only the admin can list add-funds requests'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid pagination arguments';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid add-funds status';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'Start date must not be after end date';
  END IF;
  SELECT COALESCE(jsonb_agg(request_row ORDER BY created_at DESC, request_id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', a.id, 'user_id', a.user_id, 'amount', a.amount, 'status', a.status,
      'payment_ref', a.payment_ref, 'screenshot_path', a.screenshot_path,
      'screenshot_removed_at', a.screenshot_removed_at,
      'created_at', a.created_at, 'processed_at', a.processed_at,
      'reject_reason', a.reject_reason, 'user_name', p.display_name
    ) AS request_row, a.created_at, a.id AS request_id
    FROM public.add_funds_requests a
    JOIN public.profiles p ON p.id = a.user_id
    WHERE (p_status IS NULL OR a.status = p_status)
      AND (p_from IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
      AND (v_search = '' OR lower(p.display_name) LIKE '%' || v_search || '%'
           OR lower(a.payment_ref) LIKE '%' || v_search || '%')
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT p_limit OFFSET p_offset
  ) page;
  RETURN v_result;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer, text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer, text, date, date, text) TO authenticated;
