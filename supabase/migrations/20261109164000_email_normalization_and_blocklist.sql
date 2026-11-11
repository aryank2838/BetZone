CREATE OR REPLACE FUNCTION public.normalize_email(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text;
  v_local text;
  v_domain text;
BEGIN
  IF p_email IS NULL THEN
    RETURN NULL;
  END IF;

  v_email := lower(btrim(p_email));
  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RETURN NULLIF(v_email, '');
  END IF;

  v_local := split_part(v_email, '@', 1);
  v_domain := split_part(v_email, '@', 2);
  IF v_domain = 'googlemail.com' THEN
    v_domain := 'gmail.com';
  END IF;

  v_local := split_part(v_local, '+', 1);
  IF v_domain = 'gmail.com' THEN
    v_local := replace(v_local, '.', '');
  END IF;

  RETURN v_local || '@' || v_domain;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.normalize_email(text)
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_normalized text;

UPDATE public.profiles p
SET email_normalized = public.normalize_email(u.email)
FROM auth.users u
WHERE u.id = p.id
  AND p.email_normalized IS NULL;

DO $$
DECLARE
  v_duplicates text;
BEGIN
  SELECT string_agg(
    format('%s (count=%s)', email_normalized, duplicate_count),
    ', ' ORDER BY email_normalized
  )
  INTO v_duplicates
  FROM (
    SELECT email_normalized, count(*) AS duplicate_count
    FROM public.profiles
    WHERE email_normalized IS NOT NULL
    GROUP BY email_normalized
    HAVING count(*) > 1
  ) duplicates;

  IF v_duplicates IS NULL THEN
    CREATE UNIQUE INDEX uq_profiles_email_normalized
      ON public.profiles (email_normalized);
  ELSE
    RAISE NOTICE 'Review existing normalized email duplicates before cleanup: %', v_duplicates;
    CREATE UNIQUE INDEX uq_profiles_email_normalized
      ON public.profiles (email_normalized)
      WHERE created_at >= timestamptz '2026-11-09 16:40:00+05:30'
        AND email_normalized IS NOT NULL;
  END IF;
END;
$$;

CREATE TABLE public.blocked_email_domains (
  domain text PRIMARY KEY
);

ALTER TABLE public.blocked_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.blocked_email_domains FROM PUBLIC, anon, authenticated;

INSERT INTO public.blocked_email_domains (domain)
VALUES
  ('mailinator.com'),
  ('guerrillamail.com'),
  ('sharklasers.com'),
  ('10minutemail.com'),
  ('tempmail.com'),
  ('temp-mail.org'),
  ('yopmail.com'),
  ('trashmail.com'),
  ('getnada.com'),
  ('dispostable.com'),
  ('maildrop.cc'),
  ('throwawaymail.com'),
  ('fakeinbox.com'),
  ('mintemail.com')
ON CONFLICT (domain) DO NOTHING;

CREATE OR REPLACE FUNCTION public.check_signup_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email_normalized text;
  v_domain text;
BEGIN
  v_email_normalized := public.normalize_email(NEW.email);
  IF v_email_normalized IS NULL THEN
    RAISE EXCEPTION 'Invalid signup email';
  END IF;

  v_domain := split_part(v_email_normalized, '@', 2);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_email_normalized, 0));

  IF EXISTS (
    SELECT 1
    FROM public.blocked_email_domains d
    WHERE v_domain = d.domain
       OR right(v_domain, length(d.domain) + 1) = '.' || d.domain
  ) THEN
    RAISE EXCEPTION 'EMAIL_DOMAIN_BLOCKED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.email_normalized = v_email_normalized
  ) THEN
    RAISE EXCEPTION 'EMAIL_ALREADY_USED';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_signup_email()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_email_check ON auth.users;
CREATE TRIGGER on_auth_user_email_check
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.check_signup_email();

CREATE OR REPLACE FUNCTION public.admin_add_blocked_domain(p_domain text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domain text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_current_user_admin() THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  v_domain := lower(btrim(p_domain));
  IF v_domain IS NULL
     OR v_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$' THEN
    RAISE EXCEPTION 'Invalid email domain';
  END IF;

  INSERT INTO public.blocked_email_domains (domain)
  VALUES (v_domain)
  ON CONFLICT (domain) DO NOTHING;

  RETURN jsonb_build_object('domain', v_domain);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_add_blocked_domain(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_blocked_domain(text)
  TO authenticated;
