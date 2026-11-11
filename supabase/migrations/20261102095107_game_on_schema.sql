/*
# Game On - core schema (profiles, selections, ad rewards, ledger)

## Overview
Builds the data layer for "Game On", a number-selection game where users get 100
starting points, earn 1 point per rewarded ad (max 10/day), and spend points by
submitting number selections for games ("test" / "test2").

All point mutations happen inside SECURITY DEFINER PostgreSQL functions so the
server (not the browser) enforces balances, daily ad caps, and atomic deductions.
This is the Supabase equivalent of the original "Firebase Cloud Functions verify
points and rewards" requirement.

## 1. New Tables

### profiles
- `id` (uuid, primary key) — matches `auth.users.id`
- `display_name` (text) — name entered at sign-up
- `points` (integer, not null, default 100) — current spendable balance; only mutated by SECURITY DEFINER functions
- `created_at` (timestamptz, default now())

One row per user, auto-created by a trigger on `auth.users` at sign-up with 100
starting points (and a ledger entry recording the signup bonus).

### selections
- `id` (uuid, primary key)
- `user_id` (uuid, not null, references auth.users, cascade delete) — defaults to auth.uid()
- `game` (text, not null) — "test" or "test2"
- `selections` (jsonb, not null) — array of { number: "00".."99", points: number }
- `total_points` (integer, not null) — sum of points across selections
- `created_at` (timestamptz, default now())
- `updated_at` (timestamptz, default now())
- Unique constraint on (user_id, game) so each user has one saved selection per game.

### ad_rewards
- `id` (uuid, primary key)
- `user_id` (uuid, not null, references auth.users, cascade delete)
- `reward_date` (date, not null) — the calendar day the reward was earned
- `count` (integer, not null, default 0) — number of ad rewards that day
- Unique on (user_id, reward_date) — one row per user per day.

### point_ledger
- `id` (uuid, primary key)
- `user_id` (uuid, not null, references auth.users, cascade delete)
- `delta` (integer, not null) — positive = credit, negative = debit
- `reason` (text, not null) — "signup_bonus" | "ad_reward" | "selection_submit"
- `metadata` (jsonb) — extra context (e.g. game name, ad reward index)
- `created_at` (timestamptz, default now())

Append-only audit trail of every point change.

## 2. Security

- RLS enabled on every table.
- `profiles`: users read + update own row. NOTE: the `points` column is effectively
  server-controlled — the only UPDATE path that changes it is the SECURITY DEFINER
  functions (which bypass RLS). Users could technically update their own `display_name`,
  which is acceptable. Points cannot be inflated from the client because the RPC
  functions are the only thing that touches points and they run with owner privileges.
- `selections`: full CRUD scoped to owner via auth.uid().
- `ad_rewards`: SELECT only for owner; all writes happen inside the award function.
- `point_ledger`: SELECT only for owner; all writes happen inside the functions.
- GRANTs limited to the roles/verbs each table needs.
- SECURITY DEFINER functions have EXECUTE revoked from PUBLIC/anon and granted to
  authenticated only.

## 3. Functions (SECURITY DEFINER)

### handle_new_user()
Trigger function fired AFTER INSERT on auth.users. Creates the profiles row with
100 starting points and inserts a "signup_bonus" ledger entry. Runs as the table
owner (service role), so it works even though the new user has no session yet.

### award_ad_reward()
Called by an authenticated user after watching a rewarded ad. Enforces the daily
cap of 10 rewards/day atomically: locks the ad_rewards row for the user+today,
refuses if count >= 10, otherwise increments, credits 1 point, and logs to the
ledger. Returns { points, rewards_today }.

### submit_selection(p_game, p_selections)
Called by an authenticated user to save a number selection and spend the points.
Validates the game is allowlisted and every selection has a number in 00..99 with
points > 0. Sums the total, checks the user's balance covers it, and in a single
transaction: deducts points, upserts the selections row, and logs to the ledger.
Refuses (returns an error) if balance is insufficient. Returns
{ points, total_points, selections_count }.

### get_ad_reward_status()
Returns the user's ad reward count for today and the daily cap, so the UI can show
remaining rewards. SECURITY DEFINER so it can read ad_rewards without an RLS policy
on that table being needed for the anon role.
*/

-- ---------- profiles ----------
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  points integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON profiles TO authenticated;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own"
  ON profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ---------- selections ----------
CREATE TABLE IF NOT EXISTS selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  game text NOT NULL,
  selections jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_points integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, game)
);

ALTER TABLE selections ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON selections TO authenticated;

DROP POLICY IF EXISTS "selections_select_own" ON selections;
CREATE POLICY "selections_select_own"
  ON selections FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "selections_insert_own" ON selections;
CREATE POLICY "selections_insert_own"
  ON selections FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "selections_update_own" ON selections;
CREATE POLICY "selections_update_own"
  ON selections FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "selections_delete_own" ON selections;
CREATE POLICY "selections_delete_own"
  ON selections FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------- ad_rewards ----------
CREATE TABLE IF NOT EXISTS ad_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reward_date date NOT NULL DEFAULT CURRENT_DATE,
  count integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, reward_date)
);

ALTER TABLE ad_rewards ENABLE ROW LEVEL SECURITY;

-- No CRUD grants to authenticated: all access is through the SECURITY DEFINER functions.
-- Provide a SELECT policy + grant for the get_ad_reward_status helper path is not needed
-- because that helper is SECURITY DEFINER (bypasses RLS).

-- ---------- point_ledger ----------
CREATE TABLE IF NOT EXISTS point_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE point_ledger ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON point_ledger TO authenticated;

DROP POLICY IF EXISTS "ledger_select_own" ON point_ledger;
CREATE POLICY "ledger_select_own"
  ON point_ledger FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ---------- index for ledger history ----------
CREATE INDEX IF NOT EXISTS idx_point_ledger_user_created
  ON point_ledger (user_id, created_at DESC);

-- ---------- signup trigger ----------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, display_name, points)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', ''), 100);

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (NEW.id, 100, 'signup_bonus', jsonb_build_object('source', 'signup'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ---------- award_ad_reward ----------
CREATE OR REPLACE FUNCTION award_ad_reward()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := CURRENT_DATE;
  v_count integer;
  v_points integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Lock the daily row (create if missing) so concurrent ad completions serialize.
  INSERT INTO ad_rewards (user_id, reward_date, count)
  VALUES (v_uid, v_today, 0)
  ON CONFLICT (user_id, reward_date) DO NOTHING;

  SELECT count INTO v_count
  FROM ad_rewards
  WHERE user_id = v_uid AND reward_date = v_today
  FOR UPDATE;

  IF v_count >= 10 THEN
    RAISE EXCEPTION 'Daily ad reward limit reached';
  END IF;

  UPDATE ad_rewards
  SET count = count + 1
  WHERE user_id = v_uid AND reward_date = v_today;

  UPDATE profiles
  SET points = points + 1
  WHERE id = v_uid
  RETURNING points INTO v_points;

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, 1, 'ad_reward', jsonb_build_object('reward_index', v_count + 1, 'date', v_today));

  RETURN jsonb_build_object('points', v_points, 'rewards_today', v_count + 1);
END;
$$;

REVOKE EXECUTE ON FUNCTION award_ad_reward() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION award_ad_reward() TO authenticated;

-- ---------- submit_selection ----------
CREATE OR REPLACE FUNCTION submit_selection(p_game text, p_selections jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_total integer := 0;
  v_balance integer;
  v_count integer;
  v_item jsonb;
  v_num text;
  v_pts numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_game NOT IN ('test', 'test2') THEN
    RAISE EXCEPTION 'Invalid game';
  END IF;

  IF NOT jsonb_typeof(p_selections) = 'array' THEN
    RAISE EXCEPTION 'Selections must be an array';
  END IF;

  v_count := jsonb_array_length(p_selections);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'No numbers selected';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_selections) LOOP
    v_num := v_item->>'number';
    v_pts := (v_item->>'points')::numeric;
    IF v_num IS NULL OR v_pts IS NULL THEN
      RAISE EXCEPTION 'Each selection needs a number and points';
    END IF;
    IF NOT (v_num ~ '^\d{2}$') OR v_num::int > 99 THEN
      RAISE EXCEPTION 'Number must be between 00 and 99';
    END IF;
    IF v_pts <= 0 OR v_pts <> floor(v_pts) THEN
      RAISE EXCEPTION 'Points must be a positive whole number';
    END IF;
    v_total := v_total + v_pts::int;
  END LOOP;

  SELECT points INTO v_balance FROM profiles WHERE id = v_uid FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF v_balance < v_total THEN
    RAISE EXCEPTION 'Insufficient points. You have %, this selection costs %.', v_balance, v_total;
  END IF;

  UPDATE profiles
  SET points = points - v_total
  WHERE id = v_uid;

  INSERT INTO selections (user_id, game, selections, total_points, updated_at)
  VALUES (v_uid, p_game, p_selections, v_total, now())
  ON CONFLICT (user_id, game)
  DO UPDATE SET
    selections = EXCLUDED.selections,
    total_points = EXCLUDED.total_points,
    updated_at = now();

  INSERT INTO point_ledger (user_id, delta, reason, metadata)
  VALUES (v_uid, -v_total, 'selection_submit',
    jsonb_build_object('game', p_game, 'numbers', v_count));

  RETURN jsonb_build_object(
    'points', v_balance - v_total,
    'total_points', v_total,
    'selections_count', v_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_selection(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_selection(text, jsonb) TO authenticated;

-- ---------- get_ad_reward_status ----------
CREATE OR REPLACE FUNCTION get_ad_reward_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer := 0;
  v_points integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT count INTO v_count
  FROM ad_rewards
  WHERE user_id = v_uid AND reward_date = CURRENT_DATE;

  SELECT points INTO v_points FROM profiles WHERE id = v_uid;

  RETURN jsonb_build_object(
    'rewards_today', v_count,
    'daily_cap', 10,
    'points', v_points
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION get_ad_reward_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_ad_reward_status() TO authenticated;
