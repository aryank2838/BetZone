#!/usr/bin/env bash
# Automated concurrency checks for submit_selection and settlement (tasks A2, A3, E2).
#
# Run ONLY against a disposable local database with every migration applied,
# for example right after `supabase db reset`:
#
#   supabase db reset
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     bash supabase/tests/concurrency.sh
#
# The script connects as the database owner (it creates and deletes Auth
# fixtures). Every user/admin RPC runs under SET ROLE authenticated with a JWT
# subject, as PostgREST would. It resets its fixture first, cleans up on exit,
# and exits non-zero on any failed assertion.
#
# Checks:
#   1. Concurrent submits from one user cannot overspend the balance.
#   2. A submit racing a settlement: no deadlock, no lost or double-paid bet.
#   3. Parallel bets on one number cannot together exceed max_number_liability.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$DB_URL" in
  *@127.0.0.1:*|*@127.0.0.1/*|*@localhost:*|*@localhost/*|*@\[::1\]:*) ;;
  *)
    if [ "${CONCURRENCY_ALLOW_NONLOCAL:-}" != "1" ]; then
      echo "Refusing to run against a non-local database. Set CONCURRENCY_ALLOW_NONLOCAL=1 for a disposable remote test database." >&2
      exit 2
    fi
    ;;
esac
command -v psql >/dev/null || { echo "psql is required" >&2; exit 2; }

WORK="$(mktemp -d)"
FAILURES=0
BARRIER_KEY=7731001

ADMIN=c0000000-0000-4000-8000-00000000c001
USER_A=c0000000-0000-4000-8000-00000000c00a
USER_B=c0000000-0000-4000-8000-00000000c00b
USER_C=c0000000-0000-4000-8000-00000000c00c
USER_D=c0000000-0000-4000-8000-00000000c00d
FIXTURE_USERS="'$ADMIN','$USER_A','$USER_B','$USER_C','$USER_D'"
OPEN_GAME=cc_open
SETTLE_GAME=cc_settle
RUN_ID="$$$RANDOM"

q() { psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }

# Run SQL as an authenticated user in a new session; stdout/stderr go to files.
# Sessions name themselves with SET application_name because connection poolers
# (Supabase Supavisor) replace the name sent at connect time.
as_user() {
  local uid="$1" name="$2" sql="$3"
  PGAPPNAME="cc_$name" psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
    -c "SET application_name = 'cc_$name'; SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '$uid', false) IS NULL; $sql" \
    >"$WORK/$name.out" 2>"$WORK/$name.err" || true
}

fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "ok:   $*"; }

# Wait (max 20s) until a SQL condition returns 't'.
wait_for() {
  local sql="$1" what="$2" deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(q "$sql")" = "t" ] && return 0
    sleep 0.05
  done
  fail "timed out waiting for $what"
  return 1
}

# Hold an exclusive advisory "barrier" lock until N sessions are queued behind it,
# then release so they all start their RPCs at the same moment.
start_barrier() {
  local waiters="$1"
  PGAPPNAME=cc_barrier psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "
    SET application_name = 'cc_barrier';
    DO \$\$
    DECLARE i integer := 0;
    BEGIN
      PERFORM pg_advisory_lock($BARRIER_KEY);
      WHILE (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = $BARRIER_KEY AND NOT granted) < $waiters LOOP
        i := i + 1;
        IF i > 400 THEN RAISE EXCEPTION 'barrier timed out'; END IF;
        PERFORM pg_sleep(0.025);
      END LOOP;
      PERFORM pg_sleep(0.1);
      PERFORM pg_advisory_unlock($BARRIER_KEY);
    END \$\$;" >"$WORK/barrier.out" 2>"$WORK/barrier.err" &
  BARRIER_PID=$!
  wait_for "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = $BARRIER_KEY AND granted)" "barrier lock"
}
BARRIER_SQL="SELECT pg_advisory_lock_shared($BARRIER_KEY) IS NULL; SELECT pg_advisory_unlock_shared($BARRIER_KEY);"

reset_fixture() {
  q "
    DELETE FROM public.admin_action_log WHERE actor_id IN ($FIXTURE_USERS) OR target_user_id IN ($FIXTURE_USERS);
    DELETE FROM public.selections WHERE game IN ('$OPEN_GAME', '$SETTLE_GAME');
    DELETE FROM public.winning_results WHERE game IN ('$OPEN_GAME', '$SETTLE_GAME');
    DELETE FROM auth.users WHERE id IN ($FIXTURE_USERS);
    DELETE FROM public.game_schedule WHERE game IN ('$OPEN_GAME', '$SETTLE_GAME');
  " >/dev/null
}

ORIGINAL_LIABILITY=""
cleanup() {
  set +e
  [ -n "${BARRIER_PID:-}" ] && kill "$BARRIER_PID" 2>/dev/null
  reset_fixture
  if [ -n "$ORIGINAL_LIABILITY" ]; then
    if [ "$ORIGINAL_LIABILITY" = "__unset__" ]; then
      q "DELETE FROM public.app_settings WHERE key = 'max_number_liability';" >/dev/null
    else
      q "UPDATE public.app_settings SET value = '$ORIGINAL_LIABILITY' WHERE key = 'max_number_liability';" >/dev/null
    fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

no_deadlocks() {  # $1 = label, $2 = session-name glob
  if grep -il "deadlock" "$WORK"/$2.err >/dev/null 2>&1; then
    fail "$1: a session reported a deadlock: $(grep -ih deadlock "$WORK"/$2.err | head -1)"; return 1
  fi
}

echo "Resetting concurrency fixture..."
reset_fixture
TODAY="$(q "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date")"
q "
  INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
  SELECT u.id::uuid, 'authenticated', 'authenticated', 'cc-' || u.tag || '-$RUN_ID@example.invalid', '', now(), '{}',
         jsonb_build_object('display_name', 'Concurrency ' || u.tag, 'accepted_terms', true, 'terms_version', 'concurrency')
  FROM (VALUES ('$ADMIN', 'admin'), ('$USER_A', 'a'), ('$USER_B', 'b'), ('$USER_C', 'c'), ('$USER_D', 'd')) AS u(id, tag);
  UPDATE public.profiles SET is_admin = (id = '$ADMIN'), is_banned = false, points = 0, wallet = 0,
         terms_accepted_at = COALESCE(terms_accepted_at, now())
  WHERE id IN ($FIXTURE_USERS);
  -- cc_open: open and close bets accepted all day. cc_settle: open bets already closed today.
  INSERT INTO public.game_schedule (game, label, bets_open, open_bets_close, close_bets_close, open_result_at, close_result_at, close_result_next_day)
  VALUES ('$OPEN_GAME', 'Concurrency open', '00:00', '23:59:59', '23:59:59', '23:59:59', '23:59:59', false),
         ('$SETTLE_GAME', 'Concurrency settle', '00:00', '00:00:01', '23:59:59', '00:00:01', '23:59:59', false);
" >/dev/null

# ---------------------------------------------------------------------------
# 1. Concurrent submits cannot overspend (five bet types => five bet-type locks,
#    so the sessions genuinely contend for the same profile row).
# ---------------------------------------------------------------------------
q "UPDATE public.profiles SET points = 0, wallet = 100 WHERE id = '$USER_A';" >/dev/null
start_barrier 5
i=0
for spec in "single_open|1" "single_close|2" "jodi|12" "patti_open|123-6" "patti_close|124-7"; do
  i=$((i + 1))
  bet_type="${spec%%|*}"; number="${spec##*|}"
  as_user "$USER_A" "overspend_$i" "$BARRIER_SQL SELECT 'RESULT:' || public.submit_selection('$OPEN_GAME', '[{\"number\":\"$number\",\"points\":100}]'::jsonb, '$bet_type')::text;" &
done
wait
accepted=$(cat "$WORK"/overspend_*.out | grep -c '^RESULT:' || true)
balance=$(q "SELECT points + wallet FROM public.profiles WHERE id = '$USER_A'")
staked=$(q "SELECT COALESCE(-SUM(delta), 0) FROM public.point_ledger WHERE user_id = '$USER_A' AND reason = 'selection_submit'")
rows=$(q "SELECT COALESCE(SUM(total_points), 0) FROM public.selections WHERE user_id = '$USER_A'")
DEADLOCK_FREE=1; no_deadlocks "overspend" "overspend_*" || DEADLOCK_FREE=0
if [ "$DEADLOCK_FREE" = 1 ] && [ "$accepted" = "1" ] && [ "$balance" = "0" ] && [ "$staked" = "100" ] && [ "$rows" = "100" ]; then
  pass "1. concurrent submits: exactly one of five 100-point bets accepted on a 100-point balance"
else
  fail "1. overspend: accepted=$accepted balance=$balance staked=$staked selections=$rows; errors: $(cat "$WORK"/overspend_*.err | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 2. Submit racing a settlement. The admin session takes the exclusive round
#    lock first; user B (a winner of the round) submits while it is held; the
#    admin then posts the open result, which pays B. With the old lock order
#    (profile row before round lock) this is a guaranteed deadlock.
# ---------------------------------------------------------------------------
q "
  UPDATE public.profiles SET points = 0, wallet = 990 WHERE id = '$USER_B';
  INSERT INTO public.selections (user_id, game, bet_type, round_date, selections, total_points, updated_at)
  VALUES ('$USER_B', '$SETTLE_GAME', 'single_open', '$TODAY', '[{\"number\":\"5\",\"points\":10}]', 10, now());
  INSERT INTO public.point_ledger (user_id, delta, reason, metadata)
  VALUES ('$USER_B', -10, 'selection_submit', jsonb_build_object('game', '$SETTLE_GAME', 'bet_type', 'single_open', 'round_date', '$TODAY'));
" >/dev/null
# Balance minus ledger sum before the race (the signup bonus makes this non-zero).
BALANCE_GAP_B=$(q "SELECT (SELECT points + wallet FROM public.profiles WHERE id = '$USER_B') - (SELECT COALESCE(SUM(delta), 0) FROM public.point_ledger WHERE user_id = '$USER_B')")
PGAPPNAME=cc_settler psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -c "
  SET application_name = 'cc_settler';
  BEGIN;
  SELECT set_config('request.jwt.claim.sub', '$ADMIN', true) IS NULL;
  SELECT pg_advisory_xact_lock(public.round_lock_key('$SETTLE_GAME', '$TODAY'::date)) IS NULL;
  DO \$\$
  DECLARE i integer := 0;
  BEGIN
    WHILE NOT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE application_name = 'cc_racing_bet' AND wait_event_type = 'Lock'
    ) LOOP
      -- pg_stat_activity is snapshotted per transaction; refresh it each poll.
      PERFORM pg_stat_clear_snapshot();
      i := i + 1;
      IF i > 400 THEN RAISE EXCEPTION 'racing bet never blocked behind the settlement'; END IF;
      PERFORM pg_sleep(0.025);
    END LOOP;
  END \$\$;
  SET LOCAL ROLE authenticated;
  SELECT 'RESULT:' || public.admin_post_open_result('$SETTLE_GAME', '$TODAY'::date, '122', '5')::text;
  COMMIT;" >"$WORK/racing_settler.out" 2>"$WORK/racing_settler.err" &
SETTLER_PID=$!
wait_for "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'cc_settler' AND wait_event = 'PgSleep')" "settlement to hold the round lock"
as_user "$USER_B" "racing_bet" "SELECT 'RESULT:' || public.submit_selection('$SETTLE_GAME', '[{\"number\":\"3\",\"points\":20}]'::jsonb, 'single_close')::text;" &
RACER_PID=$!
wait "$SETTLER_PID" || true
wait "$RACER_PID" || true
DEADLOCK_FREE=1; no_deadlocks "settlement race" "racing_*" || DEADLOCK_FREE=0
settled=$(grep -c '^RESULT:' "$WORK/racing_settler.out" || true)
payouts=$(q "SELECT count(*) || ':' || COALESCE(SUM(delta), 0) FROM public.point_ledger WHERE user_id = '$USER_B' AND reason = 'winning_payout' AND metadata->>'game' = '$SETTLE_GAME'")
racing_rows=$(q "SELECT count(*) FROM public.selections WHERE user_id = '$USER_B' AND game = '$SETTLE_GAME' AND bet_type = 'single_close'")
racing_ledger=$(q "SELECT count(*) FROM public.point_ledger WHERE user_id = '$USER_B' AND reason = 'selection_submit' AND metadata->>'bet_type' = 'single_close'")
wallet_b=$(q "SELECT wallet + points FROM public.profiles WHERE id = '$USER_B'")
ledger_b=$(q "SELECT $BALANCE_GAP_B + COALESCE(SUM(delta), 0) FROM public.point_ledger WHERE user_id = '$USER_B'")
racer_ok=$(grep -c '^RESULT:' "$WORK/racing_bet.out" || true)
if [ "$DEADLOCK_FREE" = 1 ] && [ "$settled" = "1" ] && [ "$payouts" = "1:90" ] && [ "$wallet_b" = "$ledger_b" ] \
   && { { [ "$racer_ok" = "1" ] && [ "$racing_rows" = "1" ] && [ "$racing_ledger" = "1" ]; } \
        || { [ "$racer_ok" = "0" ] && [ "$racing_rows" = "0" ] && [ "$racing_ledger" = "0" ]; }; }; then
  pass "2. submit vs settlement: no deadlock, winner paid exactly once (90), racing bet $( [ "$racer_ok" = 1 ] && echo accepted once || echo rejected cleanly ), balance matches ledger"
else
  fail "2. settlement race: settled=$settled payouts=$payouts racer_ok=$racer_ok rows=$racing_rows ledger=$racing_ledger wallet=$wallet_b expected=$ledger_b; settler: $(cat "$WORK/racing_settler.err" | tr '\n' ' '); racer: $(cat "$WORK/racing_bet.err" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# 3. Parallel bets on one number cannot exceed max_number_liability.
#    Limit 900; each bet is 60 points on single_open (9x => 540). Only one of
#    each pair fits. Repeated for five numbers.
# ---------------------------------------------------------------------------
ORIGINAL_LIABILITY="$(q "SELECT COALESCE((SELECT value FROM public.app_settings WHERE key = 'max_number_liability'), '__unset__')")"
q "
  INSERT INTO public.app_settings (key, value) VALUES ('max_number_liability', '900')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  UPDATE public.profiles SET points = 0, wallet = 1000 WHERE id IN ('$USER_C', '$USER_D');
" >/dev/null
FAILURES_BEFORE_3=$FAILURES
# Numbers 5-9: check 1 only uses single_open number 1, so these start with no liability.
for number in 5 6 7 8 9; do
  start_barrier 2
  for user in "$USER_C:c" "$USER_D:d"; do
    as_user "${user%%:*}" "liability_${number}_${user##*:}" "$BARRIER_SQL SELECT 'RESULT:' || public.submit_selection('$OPEN_GAME', '[{\"number\":\"$number\",\"points\":60}]'::jsonb, 'single_open')::text;" &
  done
  wait
  accepted=$(cat "$WORK"/liability_"${number}"_*.out | grep -c '^RESULT:' || true)
  liability=$(q "SELECT COALESCE(SUM((e.item->>'points')::integer * 9), 0) FROM public.selections s CROSS JOIN LATERAL jsonb_array_elements(s.selections) e(item) WHERE s.game = '$OPEN_GAME' AND s.bet_type = 'single_open' AND s.round_date = '$TODAY' AND e.item->>'number' = '$number'")
  limit_errors=$(cat "$WORK"/liability_"${number}"_*.err | grep -c 'Number liability limit exceeded' || true)
  if [ "$accepted" != "1" ] || [ "$liability" -gt 900 ] || [ "$limit_errors" != "1" ]; then
    fail "3. liability for number $number: accepted=$accepted liability=$liability limit_errors=$limit_errors; errors: $(cat "$WORK"/liability_"${number}"_*.err | tr '\n' ' ')"
  fi
done
DEADLOCK_FREE=1; no_deadlocks "liability" "liability_*" || DEADLOCK_FREE=0
[ "$FAILURES" = "$FAILURES_BEFORE_3" ] && pass "3. per-number liability: 5 parallel pairs, one bet accepted per number, payout never above 900"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES concurrency check(s) failed." >&2
  exit 1
fi
echo "All concurrency checks passed."
