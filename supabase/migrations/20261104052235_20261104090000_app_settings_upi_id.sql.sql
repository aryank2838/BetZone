/*
# Admin-configurable UPI ID for payments

## Overview
Creates an app_settings table so the admin can update the merchant UPI ID
from the admin panel without code changes. The UPI ID is used when users
add funds — it generates a UPI deep link that opens their payment app.

## New Tables
- app_settings: key-value store for app-wide configuration
  - key (text, primary key)
  - value (text, not null)
  - updated_at (timestamptz)
  - updated_by (uuid, references auth.users)

## New Functions
- get_app_setting(p_key text): returns the value for any authenticated user
- admin_set_app_setting(p_key text, p_value text): admin-only update

## Security
- app_settings: SELECT to authenticated (they can read the UPI ID to build deep links)
- Only admin can UPDATE via the SECURITY DEFINER function
- INSERT is restricted to the admin function (no direct table INSERT grant for anon/authenticated)
*/

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON app_settings TO authenticated;

DROP POLICY IF EXISTS "select_app_settings" ON app_settings;
CREATE POLICY "select_app_settings"
  ON app_settings FOR SELECT TO authenticated
  USING (true);

INSERT INTO app_settings (key, value)
VALUES ('merchant_name', 'BetZone')
ON CONFLICT (key) DO NOTHING;

-- Function to read a setting (any authenticated user)
CREATE OR REPLACE FUNCTION get_app_setting(p_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value text;
BEGIN
  SELECT value INTO v_value FROM app_settings WHERE key = p_key;
  RETURN v_value;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_app_setting(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_app_setting(text) TO authenticated;

-- Function to update a setting (admin only)
CREATE OR REPLACE FUNCTION admin_set_app_setting(p_key text, p_value text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can update settings';
  END IF;

  IF p_key IS NULL OR length(trim(p_key)) = 0 THEN
    RAISE EXCEPTION 'Setting key is required';
  END IF;

  IF p_value IS NULL OR length(trim(p_value)) = 0 THEN
    RAISE EXCEPTION 'Setting value is required';
  END IF;

  INSERT INTO app_settings (key, value, updated_by)
  VALUES (trim(p_key), trim(p_value), v_uid)
  ON CONFLICT (key)
  DO UPDATE SET
    value = EXCLUDED.value,
    updated_by = v_uid,
    updated_at = now();

  RETURN jsonb_build_object('key', trim(p_key), 'value', trim(p_value));
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_set_app_setting(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_app_setting(text, text) TO authenticated;
