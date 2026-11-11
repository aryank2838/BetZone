CREATE OR REPLACE FUNCTION get_app_setting(p_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value text;
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('merchant_upi_id', 'merchant_name') THEN
    RAISE EXCEPTION 'Unknown setting';
  END IF;

  SELECT value INTO v_value
  FROM app_settings
  WHERE key = p_key;
  RETURN v_value;
END
$$;

REVOKE EXECUTE ON FUNCTION get_app_setting(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_app_setting(text) TO authenticated;

-- Players must use get_app_setting, which allowlists the readable keys.
REVOKE SELECT ON TABLE app_settings FROM anon, authenticated;
DROP POLICY IF EXISTS "select_app_settings" ON app_settings;

ALTER TABLE profiles
  ADD CONSTRAINT display_name_len
  CHECK (char_length(display_name) <= 50) NOT VALID;

-- Remove the unclaimed seeded payment destination. Configure it through the
-- admin panel; settings already saved by an admin are preserved.
DELETE FROM app_settings
WHERE key = 'merchant_upi_id'
  AND updated_by IS NULL;
