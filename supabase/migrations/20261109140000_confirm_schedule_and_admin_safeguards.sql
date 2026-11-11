UPDATE game_schedule
SET close_result_at = '00:10',
    close_result_next_day = true
WHERE game = 'test2';

CREATE TABLE IF NOT EXISTS admin_action_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('ban', 'unban', 'grant_admin', 'revoke_admin')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_action_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_action_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON admin_action_log TO authenticated;

DROP POLICY IF EXISTS admin_action_log_read ON admin_action_log;
CREATE POLICY admin_action_log_read ON admin_action_log
  FOR SELECT TO authenticated
  USING (is_current_user_admin());

CREATE OR REPLACE FUNCTION admin_toggle_ban(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_was_banned boolean;
  v_name text;
  v_new_ban boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;
  IF p_user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot ban yourself';
  END IF;

  PERFORM pg_advisory_xact_lock(724102, 1);
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can ban users';
  END IF;

  SELECT is_admin, is_banned, display_name
  INTO v_is_admin, v_was_banned, v_name
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  IF v_is_admin THEN
    RAISE EXCEPTION 'Administrators cannot be banned';
  END IF;

  v_new_ban := NOT v_was_banned;
  UPDATE profiles
  SET is_banned = v_new_ban
  WHERE id = p_user_id;

  INSERT INTO admin_action_log (actor_id, target_user_id, action, metadata)
  VALUES (
    v_uid,
    p_user_id,
    CASE WHEN v_new_ban THEN 'ban' ELSE 'unban' END,
    jsonb_build_object('display_name', v_name, 'was_banned', v_was_banned)
  );

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_banned', v_new_ban,
    'display_name', v_name
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_toggle_ban(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_toggle_ban(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION admin_set_admin(p_user_id uuid, p_is_admin boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_was_admin boolean;
  v_name text;
  v_admin_count bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_user_id IS NULL OR p_is_admin IS NULL THEN
    RAISE EXCEPTION 'User ID and admin status are required';
  END IF;

  PERFORM pg_advisory_xact_lock(724102, 1);
  IF NOT is_current_user_admin() THEN
    RAISE EXCEPTION 'Only the admin can manage admin roles';
  END IF;

  SELECT is_admin, display_name
  INTO v_was_admin, v_name
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  IF v_was_admin AND NOT p_is_admin THEN
    SELECT count(*) INTO v_admin_count
    FROM profiles
    WHERE is_admin;
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot remove the last administrator';
    END IF;
  END IF;

  UPDATE profiles
  SET is_admin = p_is_admin
  WHERE id = p_user_id;

  IF v_was_admin IS DISTINCT FROM p_is_admin THEN
    INSERT INTO admin_action_log (actor_id, target_user_id, action, metadata)
    VALUES (
      v_uid,
      p_user_id,
      CASE WHEN p_is_admin THEN 'grant_admin' ELSE 'revoke_admin' END,
      jsonb_build_object('display_name', v_name, 'was_admin', v_was_admin)
    );
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'is_admin', p_is_admin,
    'display_name', v_name
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_set_admin(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_admin(uuid, boolean) TO authenticated;
