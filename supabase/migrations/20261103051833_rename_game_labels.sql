/*
# Rename game display labels: Test → Kalyan, Test2 → Main Bazaar

## Overview
Updates the server-side display labels returned by get_game_status() so the
dashboard shows "Kalyan" and "Main Bazaar" instead of "Test" and "Test2".
Internal game IDs ('test', 'test2') stay unchanged — only user-facing labels
change. Also updates the closed-game error message to reference the new name.

## Changes
- get_game_status(): label 'Test' → 'Kalyan', label 'Test2' → 'Main Bazaar'
- submit_selection(): error message now says "Kalyan" instead of "Test"
*/

CREATE OR REPLACE FUNCTION get_game_status()
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

  RETURN jsonb_build_array(
    jsonb_build_object(
      'game', 'test',
      'label', 'Kalyan',
      'open', is_game_open('test'),
      'opens_at', '08:00',
      'closes_at', '16:00'
    ),
    jsonb_build_object(
      'game', 'test2',
      'label', 'Main Bazaar',
      'open', true,
      'opens_at', null,
      'closes_at', null
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION get_game_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_game_status() TO authenticated;
