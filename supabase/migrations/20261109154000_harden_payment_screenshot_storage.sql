UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'payment-screenshots';

DROP POLICY IF EXISTS "users_upload_own_screenshots" ON storage.objects;
CREATE POLICY "users_upload_own_screenshots"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'payment-screenshots'
  AND (storage.foldername(name))[1] = auth.uid()::text
  AND NOT EXISTS (
    SELECT 1
    FROM public.add_funds_requests
    WHERE user_id = auth.uid()
      AND status = 'pending'
  )
);

DROP POLICY IF EXISTS "users_delete_own_screenshots" ON storage.objects;
CREATE POLICY "users_delete_own_screenshots"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'payment-screenshots'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE OR REPLACE FUNCTION public.request_add_funds(
  p_amount integer,
  p_payment_ref text,
  p_screenshot_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_banned boolean;
  v_existing_pending integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_uid := auth.uid();

  PERFORM 1
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  SELECT is_banned INTO v_banned
  FROM public.profiles
  WHERE id = v_uid;
  IF COALESCE(v_banned, false) THEN
    RAISE EXCEPTION 'Your account is banned. Contact support.';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be a positive whole number';
  END IF;
  IF p_payment_ref IS NULL OR length(trim(p_payment_ref)) = 0 THEN
    RAISE EXCEPTION 'Payment reference is required';
  END IF;

  IF p_screenshot_path IS NOT NULL
     AND (
       p_screenshot_path NOT LIKE v_uid::text || '/%'
       OR (storage.foldername(p_screenshot_path))[1] IS DISTINCT FROM v_uid::text
     ) THEN
    RAISE EXCEPTION 'Invalid screenshot path';
  END IF;

  SELECT count(*) INTO v_existing_pending
  FROM public.add_funds_requests
  WHERE user_id = v_uid
    AND status = 'pending';
  IF v_existing_pending > 0 THEN
    RAISE EXCEPTION 'You already have a pending add-funds request. Wait for it to be processed.';
  END IF;

  IF p_screenshot_path IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.add_funds_requests
    WHERE screenshot_path = p_screenshot_path
  ) THEN
    RAISE EXCEPTION 'This screenshot has already been used for another request.';
  END IF;

  INSERT INTO public.add_funds_requests (
    user_id, amount, status, payment_ref, screenshot_path
  )
  VALUES (
    v_uid, p_amount, 'pending', trim(p_payment_ref), p_screenshot_path
  );

  RETURN jsonb_build_object('status', 'pending', 'amount', p_amount);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_add_funds(integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_add_funds(integer, text, text)
  TO authenticated;
