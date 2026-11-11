CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, display_name, points)
  VALUES (
    NEW.id,
    left(COALESCE(NEW.raw_user_meta_data->>'display_name', ''), 50),
    10
  );

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (NEW.id, 10, 'signup_bonus', jsonb_build_object('source', 'signup'));

  RETURN NEW;
END;
$$;

ALTER TABLE profiles
  ALTER COLUMN points SET DEFAULT 10;
