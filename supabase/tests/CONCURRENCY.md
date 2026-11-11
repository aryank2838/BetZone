# Concurrency regressions

## Automated script (E2)

`supabase/tests/concurrency.sh` starts parallel `psql` sessions against a **disposable** database and exits non-zero on any failure. It resets its own fixture first (seven fixed-UUID users and four games: `cc_open`, `cc_settle`, `cc_dl_a` and `cc_dl_b`), restores `max_number_liability` afterwards, and refuses to run against a non-local URL unless `CONCURRENCY_ALLOW_NONLOCAL=1` is set.

```sh
supabase start
supabase db reset
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  bash supabase/tests/concurrency.sh
```

Requirements: `bash` and `psql` on `PATH`; the database URL must connect as the owner role (`postgres`) because the script creates and deletes Auth fixtures. User and admin RPCs run under `SET ROLE authenticated` with a JWT subject, as PostgREST would call them.

What it checks:

1. **Concurrent submits cannot overspend.** One user with 100 points sends five 100-point bets of five different bet types at once (an advisory-lock barrier releases them together). Exactly one is accepted; balance, ledger and selections all show 100 spent.
2. **Submit racing settlement (A2).** The admin session takes the exclusive round lock, waits until the user's submit is blocked behind it, then posts the open result, which pays that same user's winning bet. Passes when no session reports `deadlock detected`, the winner is paid exactly once (90 = 10 × 9), the racing bet is either accepted once or rejected cleanly, and the user's balance matches the ledger.
3. **Per-number liability (A3).** With `max_number_liability = 900`, two users bet 60 points (payout 540 each) on the same `single_open` number in parallel, five times. Exactly one bet per number is accepted, the other fails with `Number liability limit exceeded`, and total liability never exceeds 900.
4. **Two settlements with shared winners (R2).** Users E and F both win `cc_dl_a` and `cc_dl_b`; their bet rows are inserted in opposite user order per game. A holder session locks E's profile, settlement A starts and blocks, settlement B starts, then the holder releases. Both settlements must succeed with no `deadlock detected`, and each user is paid exactly twice (2 × 90).

Expected output:

```
ok:   1. concurrent submits: exactly one of five 100-point bets accepted on a 100-point balance
ok:   2. submit vs settlement: no deadlock, winner paid exactly once (90), racing bet accepted once, balance matches ledger
ok:   3. per-number liability: 5 parallel pairs, one bet accepted per number, payout never above 900
ok:   4. two concurrent settlements with shared winners: both succeed, no deadlock, each winner paid exactly twice
All concurrency checks passed.
```

Against a schema built only up to the migrations before `20261110160000` (the old lock order and no bet-type lock), the script fails checks 2 and 3: the racing submit is aborted with `deadlock detected`, and both bets on each number are accepted (liability 1080 > 900).

Against a schema without `20261111120000_round3_fixes.sql`, check 4 fails: one settlement is aborted with `deadlock detected` and each user is paid once instead of twice. The fix takes a global settlement advisory lock (`settlement_lock_key()`) before the round lock and settles winners in `user_id` order.

## Manual two-session checks

Use these only to investigate a failure by hand. Run them against a disposable local database, with fixture users and a schedule set from a privileged SQL session.

### Settlement holding the round lock while a user submits

The user must already have a winning `single_open` selection for an unsettled round whose open-bet cutoff has passed. In the admin session:

```sql
BEGIN;
SELECT set_config('request.jwt.claim.sub', '<admin-user-uuid>', true);
SELECT pg_advisory_xact_lock(public.round_lock_key('<game>', '<round-date>'::date));
```

In the user session:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '<test-user-uuid>', true);
SELECT public.submit_selection('<game>', '[{"number":"3","points":1}]'::jsonb, 'single_close');
```

The user call waits on the shared round lock without holding its profile row. In the admin session:

```sql
SET LOCAL ROLE authenticated;
SELECT public.admin_post_open_result('<game>', '<round-date>'::date, '<winning-patti>', '<winning-digit>');
COMMIT;
```

The admin transaction must complete without a deadlock; the user call then finishes. Confirm `winning_results.open_processed_at` is set and the winner received exactly one payout.

### Parallel bets against the per-number liability cap

Set `max_number_liability` to 9 and give two users balance. In both sessions, start a transaction as a different user and submit `'[{"number":"6","points":1}]'` for `single_open` on the same game. Session two waits for the bet-type advisory lock until session one commits, then fails with `Number liability limit exceeded`.
