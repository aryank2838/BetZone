# Changelog

## 2026-11-09

- **P0-1:** Removed legacy result-posting entry points and unused reward/result tables.
- **P0-2:** Added database exposure caps, race-safe submissions, and admin exposure reporting.
- **P0-3:** Required approved deposits and wagering turnover before withdrawals.
- **P0-4:** Audited admin money/result/settings actions; blocked self-adjustment and validated settings.
- **P0-5:** Restricted payment screenshots by type, size, ownership, and request state.
- **P0-6:** Serialized accepted bets with settlement using per-round advisory locks.
- **P0-7:** Tightened table/function grants, input bounds, UPI validation, and profile constraint validation.
- **P1-1:** Displayed add-funds and withdrawal feedback inside the modal.
- **P1-2:** Corrected earnings breakdown and removed outdated ad-reward presentation.
- **P1-3:** Scoped admin stats and selections to a selected round.
- **P1-4:** Labeled results by their actual round date.
- **P1-5:** Refreshed shared game status periodically and on tab visibility.
- **P1-6:** Reused one withdrawal form and surfaced server-derived withdrawal eligibility.
- **P1-7:** Added profile-fetch failure handling and retry behavior.
- **P1-8:** Validated amounts, UPI IDs, and password requirements consistently.
- **P1-9:** Replaced unsupported Tailwind utility classes.
- **P1-10:** Paginated admin lists and added supporting indexes.
- **P2:** Added server IST metadata and aggregate latest-results RPC; split/lazy-loaded admin UI; added shared RPC error formatting, deployment metadata, CSP/social metadata, and setup/schema documentation.
- **T7:** Added Vitest/Testing Library coverage and SQL regression/concurrency test instructions.
- **DoD-9:** Added a function execute allow-list and information-schema privilege assertions.
- **P0-8:** Normalized signup emails, blocked disposable domains and duplicate inboxes, gated the one-time signup bonus on email confirmation, and added confirmation-email resend cooldowns and rate-limit guidance.

Database migrations still require a fresh local `supabase db reset` and explicit review/application in the intended hosted project.

## 2026-11-10

- **A6–A9:** Locked down default function privileges, added an allowlist-based execute audit, validated games against `game_schedule`, centralized internal rule constants, logged blocked-domain additions, added admin settings metadata, and paginated bet history by complete round with round-level totals.
- **A8 decision:** Users who have not accepted terms may request withdrawal of their own eligible balance; terms checks remain for betting and deposits. Ban, deposit turnover, and withdrawal limits still apply. Counsel should confirm this policy.

## 2026-11-11

No git repository exists in this working copy, so the per-task commits could not be made; the entries below list each task ID instead.

### Phase A — Database

- **A1:** `admin_list_users(text, integer, integer)` dropped (`20261110160000`). No public function name is overloaded; `database_regressions.sql` asserts this.
- **A2:** `submit_selection` takes locks in the order round lock (shared) → bet-type lock → profile row, computing the IST date once from `clock_timestamp()`. A round that differs from the locked date (midnight crossing) raises `Please try again.` Settlement keeps its exclusive round lock and never takes the bet-type lock.
- **A3:** Internal `bet_type_lock_key()` serializes bets of one bet type per round for the liability check. `admin_get_exposure` also returns `phase_exposure` (open/close combined worst case, reporting only), shown in the Results tab.
- **A4:** `admin_daily_report` returns `total_staked`, `total_paid_out`, `gaming_revenue` per game; the `ALL` row adds separate `approved_deposits`, `approved_withdrawals`, `net_cash`. The mixed `net` field is gone. Reports tab, CSV, README and exact-number regression test updated.
- **A5:** `admin_list_ledger_opening_balances()`; the Reports tab always shows "Legacy opening balances: N users, total X". Regression test: users created after the migration have no opening-balance row. README no longer presents the baseline as clean.
- **A6:** Default privileges revoke `EXECUTE` on new functions from `anon`/`authenticated` (per schema) and, in `20261111090000`, from `PUBLIC` globally for `postgres` (and `supabase_admin` when permitted). A per-schema revoke cannot remove PostgreSQL's built-in global PUBLIC default, so before this fix `anon` could still execute any newly created public function. `function_privilege_audit.sql` is allowlist-based, checks `pg_default_acl` including the global entry, creates and checks a probe function, must run as `postgres`, and returns zero rows when clean.
- **A7:** `admin_get_stats`, `admin_list_selections`, `get_my_bets`, `get_result_history` validate games against `game_schedule`.
- **A8 — DECISION:** `request_withdrawal` does not require accepted terms; betting and deposits still do. Ban checks, deposit turnover and withdrawal limits still apply. Regression-tested. **Counsel should confirm this policy.**
- **A9:** `add_blocked_domain` audit action; `admin_get_settings()` (value, `updated_at`, updater name); `internal_rule_constants()` feeds `submit_selection`, `request_withdrawal`, `request_add_funds`, `get_wallet_status` and `get_public_rules`; `get_my_bets` pages by `(game, round_date)` and returns `staked`, `won`, `pending_stake` per round.
- **Follow-up fixes (`20261111090000_phase_a_followup_fixes.sql`)**, found by running the suites against a fresh PostgreSQL 17 database:
  - `get_my_bets` raised `column reference "game" is ambiguous` whenever a game filter was passed (the guard's unqualified `game` collided with the `RETURNS TABLE` column).
  - The UPI regex `{2,256}` exceeds PostgreSQL's maximum repetition count (255), so **every** `request_withdrawal` call and every merchant-UPI change raised `invalid regular expression`. Now `{2,255}` in the database and in `WithdrawalForm`.
  - `apply_pending_user_limits` is no longer executable by clients (internal helper).
  - Global default privileges (see A6).

### Phase B — Frontend core

- **B1:** Background profile refreshes and same-user `SIGNED_IN` events no longer set `loading`, so screens and half-filled forms stay mounted. RTL test.
- **B2:** CSV formula guard applies only to string cells (leading whitespace, then `=`, `+`, `-`, `@`, tab, CR); numbers stay numeric.
- **B3:** Every listed server message is mapped in English, Hindi and Marathi, with one test per message; unmapped messages fall back to generic text plus the raw detail.
- **B4:** Sentry scrubbing leaves exception stack frames intact (tested). The CSP is generated by a Vite plugin: production has no `ws://localhost`/`ws://127.0.0.1` and adds the Sentry ingest origin only when a DSN is set. Production builds fail on empty or placeholder `VITE_SUPABASE_URL`/`VITE_SITE_URL`.
- **B5:** Ledger lists and CSV export use a `(created_at desc, id desc)` keyset. Test: 120 rows with identical timestamps are returned exactly once.
- **B6:** Activity handling throttled to once per second and shared across tabs via `localStorage`; 30-minute timeout and 60-second warning kept. Fake-timer tests.
- **B7:** "Open · closes in H:MM:SS" vs "Closed · opens at HH:MM IST" from `open_bets_open`/`close_bets_open` on the dashboard, selection screen and screen-reader announcement. Fixed the half-finished selection-screen change that broke `typecheck` and `lint`. Tests.
- **B8:** My bets uses server round totals; Net counts settled stakes only and pending stake is shown separately. The Help form validates the related request ID as a UUID. The admin Results round date defaults from the selected game's schedule. "Database error saving new user" now shows "We couldn't create your account. Try a different email or contact support." Missing `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` renders "App is not configured" instead of throwing at import. `src/lib/terms.ts` holds `TERMS_VERSION`; the terms screen offers withdrawal, Log out and Help. Bet limits come from `get_public_rules`, with `quickStakes` kept local.

### Phase C — Admin

- **C1:** Confirmation dialog (`useDialogA11y`, Escape closes, focus restored, topmost dialog only) for Approve & credit (user, amount, UTR, screenshot opened or not), Ban/Unban, Make/Remove admin (typing `ADMIN` required to grant), balance adjustments (target, delta, resulting balance, reason) and merchant UPI changes (old → new, typing `CHANGE UPI` required). Tests.
- **C2:** The Settings tab loads through `admin_get_settings()` and shows "Last changed {time} by {name}". This also fixes settings load failing when the Results round date was empty, because limits were previously fetched through `admin_get_exposure`.
- **C3:** Stats, Selections and Results game lists, saved navigation state and My bets come from `useGameStatus()`; nothing assumes `test`/`test2`.
- **C4:** User detail renders readable rows; ledger metadata is allowlisted (game, bet type, round, number, balance), so UPI IDs and internal keys are omitted.

### Phase D — Polish

- **CSS:** Removed the global 44 px button rule and the `!important` grey override. Icon-only and standalone buttons use a `.tap-target` class; inline text-link buttons stay inline. Former `text-slate-500`/`600` text classes are now `text-slate-400` (same colour users saw before, without `!important`). Larger signup checkbox.
- **i18n:** Storage reads and writes are wrapped in `try/catch`; `<html lang>` follows the language; the `useFormat()` hook re-renders numbers and dates on language change; the sign-in screen, dashboard and bet slip are translated (machine-draft headers kept).
- **Icons:** PNG icons (192, 512, maskable 512), a 180 px Apple touch icon and a 1200×630 `og-image.png`, rendered from the existing SVG artwork. Manifest and `index.html` use the PNGs; `favicon.svg` remains the only SVG the page references.
- **Legal guard:** Production builds fail while `src/components/LegalPage.tsx` contains `[OWNER/LAWYER TO REPLACE]`; `ALLOW_PLACEHOLDER_LEGAL=1` opts out for staging builds, with a warning.
- **Docs:** Recommend 10–20 sign-ups/sign-ins per 5 minutes per IP; explain that Dashboard-created users fail the terms trigger.

### Phase E — Tests and documentation

- **E1:** Regression additions: overloads; exact daily report; opening balances; `admin_adjust_points` (self-adjustment, ±10000 cap, reason length); screenshot reuse and wrong-user path; storage bucket limits and owner-scoped upload/read/delete policies (checked by catalog and by inserting as `authenticated`); last-admin protection; bad blocked domains (no audit row) and a valid one (normalized, audited once); withdrawal without terms. Bet, deposit request, withdrawal request and `get_my_bets` also run under `SET LOCAL ROLE authenticated`. Fixed three pre-existing test bugs that stopped the script before its later checks: a hard-coded turnover remainder, an admin call made as a non-admin, and a leftover pending fixture.
- **E2:** `supabase/tests/concurrency.sh` (overspend, submit vs settlement, per-number liability). It passes on the current schema and fails on the pre-A2/A3 schema with `deadlock detected` and liability 1080 > 900.
- **E3:** Frontend tests for B1, B2, B3, B4, B5, B6, B7, C1, language-storage failure, the legal guard and the new helpers (89 tests in total).
- **E4:** README, `CONCURRENCY.md` and this changelog updated.

### Verified on hosted Supabase (throwaway project, since deleted)

- All 47 migrations, the three SQL suites and `concurrency.sh` pass on a fresh hosted Supabase project (Postgres 17.11) through the session pooler.
- **`20261110170000` edited before it was ever applied.** On hosted Supabase, `postgres` may not alter `supabase_admin`'s default privileges, so the migration failed. That statement now catches `insufficient_privilege`. The live project (`betzone-db`) has migrations only up to `20261110003000`, so no applied migration was changed.
- The default-privilege checks in `database_regressions.sql` and `function_privilege_audit.sql` are now strict for creator roles the test user can administer. On hosted projects, the platform role `supabase_admin` (never used by migrations) is reported as a notice instead of failing.
- `concurrency.sh` sessions set `application_name` with `SET`, because the Supavisor pooler replaces the connect-time name.
- **The live project currently has the `{2,256}` UPI regex bug** (from `20261110000715`), so withdrawals fail until `20261111090000` is applied.

### Decisions and defaults

- A8: withdrawals exempt from the terms check (counsel to confirm).
- A6: the global default-privilege revoke applies to every function `postgres` creates, in any schema, including future extensions; those need explicit grants.
- UPI ID local part is limited to 2–255 characters (PostgreSQL regex limit).
- Bet-limit fallback while `get_public_rules` loads: `FALLBACK_BET_LIMITS` = 5000 per pick, 20000 per submit (the server enforces the real values).
- Confirmation phrases: `MAKE_ADMIN_CONFIRM_TEXT = 'ADMIN'`, `CHANGE_UPI_CONFIRM_TEXT = 'CHANGE UPI'`.
- Concurrency fixture: `max_number_liability` is set to 900 during the run and restored afterwards.
- Opt-out variable for placeholder legal text: `ALLOW_PLACEHOLDER_LEGAL=1` (exact value `1`).
- Withdrawing without accepted terms is offered from the terms screen ("Withdraw my balance instead").
- Recommended Auth rate limit: start at 15 sign-ups/sign-ins per 5 minutes per IP.

## 2026-11-11 — Round 3 (external review)

Each item below is one git commit.

- **R1:** A fresh sign-in no longer logs the user straight out. `betzone_last_activity` is cleared on `signOut()`, on inactivity logout and on every `SIGNED_OUT` event; a real `SIGNED_IN` (user changed) writes the current time before the inactivity timer schedules, while a restored session (`INITIAL_SESSION`) keeps the stored time, so a tab idle for 30+ minutes is still signed out. All `localStorage` access goes through never-throwing helpers in `src/lib/inactivity.ts`, with an in-memory fallback when storage is blocked.
- **R2:** Concurrent settlements of different games no longer deadlock. `process_open_payouts` and `process_close_payouts` take a global settlement advisory lock (`settlement_lock_key()`, constant `724102000003`) before the exclusive round lock, and `settle_bets` pays winners in `user_id` order. Lock order: settlement lock → round lock (exclusive) → profiles; bets never take the settlement lock, so the A2 bet-vs-settlement order is unchanged. `settle_bets` now also has the standard `auth.uid()` check and `search_path = public, pg_temp`. Check 4 in `supabase/tests/concurrency.sh` reproduces the deadlock on the old schema and passes on the new one.
- **R3:** Database constraints for balances and money rows: `profiles` `points >= 0` and `wallet >= 0`; `withdrawals` and `add_funds_requests` `amount > 0` and `status IN ('pending','approved','rejected')`; `point_ledger` `delta <> 0` and `reason` limited to the reasons inserted by migrations (`signup_bonus`, `selection_submit`, `winning_payout`, `withdrawal_request`, `withdrawal_refund`, `add_funds`, `admin_adjust_points`, `admin_adjust_wallet`) plus legacy `ad_reward`. Each is added `NOT VALID`; the migration then lists any existing violating rows and stops instead of changing data, and otherwise runs `VALIDATE CONSTRAINT`. Two regression fixtures that used a made-up ledger reason / zero delta now use `admin_adjust_wallet` with a non-zero delta.
- **R4 (DECISION):** Deleting a user no longer erases financial history. The `user_id` → `auth.users` foreign keys of `point_ledger`, `withdrawals`, `add_funds_requests` and `selections` are now `ON DELETE RESTRICT` (same constraint names); `profiles`, `user_limits`, `support_tickets` and `user_ledger_opening_balances` keep `ON DELETE CASCADE`. **Assumption:** admins ban instead of deleting, and account deletion requests go through a manual owner/counsel process (README, "Deleting users and account deletion requests"). A regression test checks that deleting a user with ledger rows fails and a user without history can still be deleted. `concurrency.sh` now removes its fixture's money rows before deleting its Auth users.
- **R5:** Approving a withdrawal now opens the existing `ConfirmDialog` (`approve_withdrawal` in `confirmations.ts`) showing the user, amount and UPI ID with the warning "Only approve after you have sent this payment. Approving marks it as paid." (`APPROVE_WITHDRAWAL_WARNING`). Reject (refund) is unchanged.
- **R6:** Payout multipliers (9 / 90 / 120) now have one source of truth, `public.bet_multiplier(bet_type)`. `submit_selection` (liability check), `admin_get_exposure`, and `process_open_payouts` / `process_close_payouts` (arguments to `settle_bets`) call it; `settle_bets` rejects a multiplier that differs from it. Values are unchanged. A regression test compares settled payouts, exposure rows and the function definitions against `bet_multiplier()`.
- **R7:** Users are asked to accept the terms again when the version changes. The app shows `TermsAcceptance` when `profile.terms_version !== TERMS_VERSION` (`needsTermsAcceptance()` in `src/lib/terms.ts`), with an "Our terms have been updated" heading for users who accepted an older version. The server still accepts any non-null `terms_accepted_at` for betting and deposits, so a deploy locks nobody out. `internal_rule_constants()` gains `current_terms_version` (`'2026-11-10'`), which `get_public_rules()` exposes. Tests: a profile with an old version sees the terms screen (`src/App.test.tsx`), and the SQL suite checks `current_terms_version`.
- **R8:** Smaller items.
  - **Duplicate UTR:** `request_add_funds` rejects a payment reference already used by a pending or approved request (case-insensitive) with "This payment reference has already been used." before the unique index `uq_add_funds_payment_ref` (kept) would raise a raw error. Mapped to `errors.duplicateReference` (en/hi/mr). A rejected request's reference may be reused.
  - **Cooldown/self-exclusion dates:** `formatServerTimestamp()` in `errors.ts` parses the raw Postgres timestamp (e.g. `2026-11-11 04:30:00.123456+00`) and shows it in IST with the existing `formatDate` helper; unparseable text is shown unchanged.
  - **Deposit minimum:** the "Add at least N approved deposit points" matcher accepts any number and passes it into `errors.depositRequirement` as `{points}`.
  - **Countdown text:** "Open · closes in …" and "Closed · opens at … IST" are now the i18n keys `countdown.open` / `countdown.closed` (en/hi/mr; Hindi and Marathi still need native review). `formatBetWindow` takes an optional language; Dashboard and SelectionScreen pass the current one.
  - **Sentry:** `beforeSend` also scrubs `event.exception.values[].value` (message text only); `stacktrace` objects are passed through untouched.
  - **Privilege audit:** removed `award_ad_reward` and `get_ad_reward_status` (dropped functions) from the allowlist in `function_privilege_audit.sql`.
- **Legal:** Terms page replaced with the owner-supplied "Legal Disclaimer & Terms Summary" (5 sections). The Privacy Policy and Contact pages still contain placeholders, so production builds stay blocked until they are replaced. `TERMS_VERSION` stays `2026-11-10` (the site had not launched).
- **Legal:** Privacy Policy replaced with the owner-supplied text (effective 11 November 2026), and the Contact page now shows the support email (`SUPPORT_EMAIL` in `LegalPage.tsx`). No placeholders remain, so production builds pass without `ALLOW_PLACEHOLDER_LEGAL`.

## 2026-11-11 — Live feedback fixes

- **Admin "Something went wrong" on every tab:** the admin panel asked for stats before today's date had loaded, sending an empty date that Postgres rejects (`invalid input syntax for type date`). The shared error banner then stayed on the Results, Requests and Users tabs. `loadStats` now waits for a date, the banner clears when switching tabs, and every admin error names what failed and shows the technical detail (message, code, details, hint).
- **Payment screenshot required:** the Add money form needs a screenshot and a valid UTR before "Send for checking" is enabled. Migration `20261111140000_require_payment_screenshot.sql` makes `request_add_funds` reject requests without a screenshot ("Please upload a screenshot of your payment.") or whose file was never uploaded to the `payment-screenshots` bucket. Existing requests are unchanged.
- **Times with AM/PM:** schedule times show as "8:00 AM IST" (`formatClockTime` in `countdown.ts`) on game cards, the betting screen and screen-reader announcements.
- **Plainer wording:** balance page, Add money form, game cards, bet slip and common error messages rewritten in plain English, with amounts shown in ₹. Hindi and Marathi keep their meaning; the new countdown and screenshot strings still need native review.
