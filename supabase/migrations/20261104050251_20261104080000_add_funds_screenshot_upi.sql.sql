/*
# Add screenshot storage and UPI ID to add_funds_requests

## Overview
Enhances the add-funds flow to support UPI deep-link payments with screenshot proof.
Users will pay via a UPI deep link, then upload a screenshot of the payment
confirmation along with the transaction reference number. The admin can view
the screenshot when approving the request.

## Changes
1. add_funds_requests: add `screenshot_path` column (text, nullable) — stores the
   storage path to the uploaded screenshot image.
2. request_add_funds function: accept new `p_screenshot_path` parameter.
3. admin_list_add_funds function: include `screenshot_path` in the returned JSON.
4. Storage bucket `payment-screenshots` created for user-uploaded payment proof images.
5. Storage policies: users can upload/read only their own screenshots; admins can read all.

## Security
- Storage bucket `payment-screenshots` is private (not public).
- RLS on storage.objects: authenticated users can INSERT and SELECT only objects
  in their own user-id-prefixed folder. Admins can SELECT all.
- The `request_add_funds` function validates the screenshot path starts with the
  caller's user_id to prevent path traversal.
*/

-- ============================================================
-- 1. Add screenshot_path column to add_funds_requests
-- ============================================================
ALTER TABLE add_funds_requests ADD COLUMN IF NOT EXISTS screenshot_path text;

-- ============================================================
-- 2. Update request_add_funds to accept screenshot_path
-- ============================================================
CREATE OR REPLACE FUNCTION request_add_funds(p_amount integer, p_payment_ref text, p_screenshot_path text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing integer;
  v_banned boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT is_banned INTO v_banned FROM profiles WHERE id = v_uid;
  IF v_banned THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  IF p_amount <= 0 OR p_amount <> floor(p_amount) THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;

  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) = 0 THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  -- Validate screenshot path belongs to the user
  IF p_screenshot_path IS NOT NULL THEN
    IF NOT (p_screenshot_path LIKE v_uid::text || '/%') THEN
      RAISE EXCEPTION 'Invalid screenshot path';
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_existing
  FROM add_funds_requests WHERE user_id = v_uid AND status = 'pending';

  IF v_existing > 0 THEN
    RAISE EXCEPTION 'You already have a pending add-funds request. Wait for it to be processed.';
  END IF;

  INSERT INTO add_funds_requests (user_id, amount, status, payment_ref, screenshot_path)
  VALUES (v_uid, p_amount, 'pending', trim(p_payment_ref), p_screenshot_path);

  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount);
END;
$$;

REVOKE EXECUTE ON FUNCTION request_add_funds(integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION request_add_funds(integer, text, text) TO authenticated;

-- ============================================================
-- 3. Update admin_list_add_funds to include screenshot_path
-- ============================================================
CREATE OR REPLACE FUNCTION admin_list_add_funds()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can list add-funds requests';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'user_id', a.user_id,
      'amount', a.amount,
      'status', a.status,
      'payment_ref', a.payment_ref,
      'screenshot_path', a.screenshot_path,
      'created_at', a.created_at,
      'user_name', p.display_name
    ) ORDER BY a.created_at DESC
  ), '[]'::jsonb) INTO v_result
  FROM add_funds_requests a
  JOIN profiles p ON p.id = a.user_id;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_list_add_funds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_add_funds() TO authenticated;

-- ============================================================
-- 4. Create storage bucket for payment screenshots
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-screenshots', 'payment-screenshots', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 5. Storage policies for payment-screenshots
-- ============================================================
-- Users can upload to their own folder
DROP POLICY IF EXISTS "users_upload_own_screenshots" ON storage.objects;
CREATE POLICY "users_upload_own_screenshots"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'payment-screenshots'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can read their own screenshots
DROP POLICY IF EXISTS "users_read_own_screenshots" ON storage.objects;
CREATE POLICY "users_read_own_screenshots"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'payment-screenshots'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Admins can read all screenshots
DROP POLICY IF EXISTS "admins_read_all_screenshots" ON storage.objects;
CREATE POLICY "admins_read_all_screenshots"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'payment-screenshots'
  AND EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = true
  )
);
