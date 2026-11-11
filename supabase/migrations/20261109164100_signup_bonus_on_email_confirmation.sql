ALTER TABLE public.profiles
  ALTER COLUMN points SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, points, email_normalized)
  VALUES (
    NEW.id,
    left(COALESCE(NEW.raw_user_meta_data->>'display_name', ''), 50),
    0,
    public.normalize_email(NEW.email)
  );

  IF NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE public.profiles
    SET points = points + 10
    WHERE id = NEW.id;

    INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
    VALUES (NEW.id, 10, 'signup_bonus', jsonb_build_object('source', 'signup'));
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_user_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL
     AND NEW.email_confirmed_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.point_ledger
       WHERE user_id = NEW.id
         AND reason = 'signup_bonus'
     ) THEN
    UPDATE public.profiles
    SET points = points + 10
    WHERE id = NEW.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Profile missing while granting signup bonus';
    END IF;

    INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
    VALUES (
      NEW.id,
      10,
      'signup_bonus',
      jsonb_build_object('source', 'email_confirmed')
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_user_confirmed()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_confirmed();
