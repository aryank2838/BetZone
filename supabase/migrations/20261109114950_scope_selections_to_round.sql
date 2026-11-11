-- Keep a private copy before changing the selections schema.
CREATE TABLE IF NOT EXISTS public.selections_backup AS
SELECT * FROM public.selections;

ALTER TABLE public.selections_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.selections_backup FROM anon, authenticated;

-- Existing selections are assigned a sentinel date so they cannot settle again.
ALTER TABLE public.selections
  ADD COLUMN IF NOT EXISTS round_date date NOT NULL DEFAULT DATE '2000-01-01';
ALTER TABLE public.selections
  ALTER COLUMN round_date DROP DEFAULT;

-- Remove unique keys that would prevent a user from placing bets in later rounds.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT i.indexrelid::regclass AS idx, c.conname
    FROM pg_index i
    LEFT JOIN pg_constraint c
      ON c.conindid = i.indexrelid AND c.contype = 'u'
    WHERE i.indrelid = 'public.selections'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
  LOOP
    IF r.conname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.selections DROP CONSTRAINT %I', r.conname);
    ELSE
      EXECUTE format('DROP INDEX %s', r.idx);
    END IF;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_selections_round
  ON public.selections (user_id, game, bet_type, round_date);
CREATE INDEX IF NOT EXISTS idx_selections_settle
  ON public.selections (game, bet_type, round_date);
