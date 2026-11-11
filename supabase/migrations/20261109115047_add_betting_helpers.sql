CREATE OR REPLACE FUNCTION is_valid_patti(p text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  a int;
  b int;
  c int;
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{3}$' THEN
    RETURN false;
  END IF;

  a := CASE substr(p, 1, 1) WHEN '0' THEN 10 ELSE substr(p, 1, 1)::int END;
  b := CASE substr(p, 2, 1) WHEN '0' THEN 10 ELSE substr(p, 2, 1)::int END;
  c := CASE substr(p, 3, 1) WHEN '0' THEN 10 ELSE substr(p, 3, 1)::int END;

  RETURN a <= b AND b <= c;
END
$$;

CREATE OR REPLACE FUNCTION patti_digit(p text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    substr(p, 1, 1)::int
    + substr(p, 2, 1)::int
    + substr(p, 3, 1)::int
  ) % 10
$$;

CREATE OR REPLACE FUNCTION is_valid_patti_combo(v text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF v IS NULL OR v !~ '^[0-9]{3}-[0-9]$' THEN
    RETURN false;
  END IF;

  RETURN is_valid_patti(split_part(v, '-', 1))
     AND patti_digit(split_part(v, '-', 1)) = split_part(v, '-', 2)::int;
END
$$;

CREATE OR REPLACE FUNCTION bet_round(p_game text, p_bet_type text)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date
  FROM game_schedule g
  WHERE g.game = p_game
    AND (now() AT TIME ZONE 'Asia/Kolkata')::time >= g.bets_open
    AND (now() AT TIME ZONE 'Asia/Kolkata')::time <
        CASE
          WHEN p_bet_type IN ('single_close', 'patti_close')
            THEN g.close_bets_close
          ELSE g.open_bets_close
        END
$$;

REVOKE EXECUTE ON FUNCTION bet_round(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION is_game_open(p_game text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN bet_round(p_game, 'jodi') IS NOT NULL
      OR bet_round(p_game, 'single_close') IS NOT NULL;
END
$$;
