# BetZone

BetZone is a Vite + React + TypeScript frontend backed by Supabase Auth, Postgres, and private Storage.

## Local setup

1. Install Node.js and npm.
2. Install dependencies with `npm install`.
3. Create a local `.env` from `.env.example` and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_SITE_URL`. These are public frontend configuration values; never put a service-role key in the frontend.
4. Start the frontend with `npm run dev`.

Useful checks:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run build` is a production build and fails on purpose when:

- `VITE_SUPABASE_URL` or `VITE_SITE_URL` is empty, invalid, or a placeholder (`example.supabase.co`, `localhost`, `127.0.0.1`, `*.example`, `your-*`);
- a legal page still contains `[OWNER/LAWYER TO REPLACE]`. For a staging build only, set `ALLOW_PLACEHOLDER_LEGAL=1`; the build then prints a warning. Never deploy such a build to production.

For a local check without real values, use clearly named dummy values, for example `ALLOW_PLACEHOLDER_LEGAL=1 VITE_SUPABASE_URL=https://dummy-project-ref.supabase.co VITE_SUPABASE_ANON_KEY=dummy-anon-key VITE_SITE_URL=https://staging.betzone-dummy.test npm run build`, then rebuild with the real values before deploying. A build missing `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` at runtime shows a plain "App is not configured" page instead of crashing.

Database regression tests are in `supabase/tests/`. Start a disposable local Supabase stack, reset it to apply migrations, then run the SQL scripts with `psql` as the `postgres` role:

```sh
supabase start
supabase db reset
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/database_regressions.sql
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/signup_protection.sql
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/function_privilege_audit.sql
DATABASE_URL="$DB" bash supabase/tests/concurrency.sh
```

The database regression test is transactional and rolls back its fixture data; its user flows (bet, deposit request, withdrawal request, `get_my_bets`, storage uploads) also run under `SET LOCAL ROLE authenticated`. The function privilege audit must run as `postgres` (`information_schema.routines.routine_definition` is NULL for functions you do not own, so it checks catalog privileges). It fails if `anon` or `authenticated` can execute any public function missing from its explicit allowlist, if a default ACL still grants `EXECUTE` on new functions, or if a probe function created during the audit is client-executable; both of its result queries must return zero rows. `concurrency.sh` runs parallel sessions against the disposable database; see `supabase/tests/CONCURRENCY.md`.

## Betting history

The selection screen shows a confirmation slip before submitting. Per-pick and per-submit limits are enforced by the database; the interface reads the same values from `get_public_rules` (one internal `internal_rule_constants()` function feeds `submit_selection`, `request_withdrawal`, `request_add_funds` and `get_public_rules`, so they cannot drift). Game cutoffs use timestamps from the database, so countdowns do not depend on the device clock. Each bet window shows "Open · closes in H:MM:SS" while `open_bets_open`/`close_bets_open` is true and "Closed · opens at HH:MM IST" otherwise (the server's next cutoff already points at tomorrow once today's has passed).

Bets and settlement take locks in one order: round lock (shared for bets, exclusive for settlement) → bet-type lock (bets only) → profile row. The bet-type lock serializes the per-number liability check, so parallel bets on one number cannot exceed `max_number_liability`. A bet that straddles IST midnight between taking the round lock and resolving its round is rejected with "Please try again."

Signed-in users can open **My bets** from the dashboard, balance, or wallet pages to review their own submitted picks and outcomes. History pages by round, so each page contains every bet type of each round, with server-computed staked, won and pending-stake totals. "Net" counts only settled stakes; pending stakes are shown separately and are not counted as losses. Results remain pending until the relevant payout phase is processed. Past results are available under each game card and are shown without statistics or predictions.

## Deposits, requests, and statements

The add-funds form provides a UPI QR code and payment steps, then validates the payment reference before submitting. Deposit and withdrawal requests show their review status and rejection reasons; pending requests refresh periodically. Admins can configure an optional expected-approval note. The wallet page can download a CSV statement containing only the user's ledger date, transaction type, delta, game, bet type, and round date. Ledger lists and the CSV page with a keyset on `(created_at, id)`, so payouts that share a settlement timestamp are neither skipped nor duplicated. CSV number cells stay numeric (a delta of `-10` is written as `-10`); string cells that start with `=`, `+`, `-`, `@`, tab or carriage return (after leading whitespace) are prefixed with `'`.

## Responsible play, terms, and support

Signed-in users can set daily deposit and net-loss limits; reductions take effect immediately, while increases and removals are scheduled 24 hours later. Cooldowns and self-exclusions are database-enforced. Self-exclusion cannot be lifted by administrators in the normal UI; after the period expires, contact support for help. Betting and deposit requests are checked against active restrictions on the server.

Signup and existing accounts require age confirmation and acceptance of the Terms and Privacy Policy (current version: `TERMS_VERSION` in `src/lib/terms.ts`). Accepted terms are required for betting and deposits but **not** for withdrawing your own balance (ban, turnover and withdrawal limits still apply); the terms screen offers withdrawal, Log out and Help. Counsel should confirm this policy. The legal pages intentionally contain `[OWNER/LAWYER TO REPLACE]` placeholders and must be replaced with owner- and counsel-approved content before launch; production builds fail until they are.

The inactivity timeout is 30 minutes, with a warning during the final 60 seconds. Activity is handled at most once per second and shared across tabs through `localStorage`, so an idle tab does not sign out a session that is active in another tab. Profile refreshes (after a bet, a request status change, or supabase-js re-emitting `SIGNED_IN` when a tab regains focus) update data in the background and never unmount the current screen or clear half-filled forms.

English, Hindi, and Marathi dictionaries and selectors are included; Hindi and Marathi are machine-translated drafts requiring native-speaker review. The sign-in screen, dashboard and bet slip are translated; other screens still contain English strings. The language choice is stored in `localStorage` when available (the app still works if storage is blocked) and sets `<html lang>`. Numbers and dates re-render in the selected locale.

Users can contact configured support channels or create a problem report through Help. Admins review and close support tickets from the Support tab.

## Backups and restore drill

Enable the daily database backups offered by the Supabase plan in the project's **Database → Backups** settings and verify the retention window for that plan. Restrict backup access to the project owners and keep a separate record of the project reference and the latest successful backup time; never store database credentials in this repository.

Restore procedure:

1. Choose a recent backup in the Supabase Dashboard and restore it to a new, isolated recovery project (do not overwrite production during a drill).
2. Wait for the restore to finish, then verify the restored schema and migration history, sign-in, a read-only balance/profile query, and the database regression and privilege-audit scripts in `supabase/tests/`.
3. Confirm that Storage objects needed by the app are present or recover them from the separately managed Storage backup.
4. Record the backup timestamp, restore duration, test results, and any missing data. Only switch production traffic after an owner approves the recovery.

**Restore drill status:** this procedure has not yet been executed in this environment. Complete and record a drill in an isolated Supabase project before relying on it for production recovery. Database restore requires Supabase project-owner access and is not something the frontend build can test.

## Admin reports and reconciliation

The admin result form provides a read-only payout preview and requires typing the patti before posting. Posting pays winners immediately and cannot be undone. Round exposure shows the ten highest potential payouts per bet type, full stake totals, and reporting-only combined worst-case payouts for each settlement phase (open: `single_open` + `patti_open`; close: `single_close` + `patti_close` + `jodi`); these are not enforced. Game lists in the admin UI come from the configured schedule, and the Results round date defaults from the selected game's schedule. Request and user lists filter and paginate through admin RPCs. User details show readable rows (ledger, bets, deposits, withdrawals, tickets), omit email, hide internal ledger metadata such as UPI IDs, and cap each history section.

High-risk admin actions ask for confirmation first: **Approve & credit** (shows user, amount, UTR, and whether the screenshot was opened), **Ban/Unban**, **Make/Remove admin** (granting requires typing `ADMIN`), **balance adjustments** (target, change, resulting balance and reason), and **merchant UPI ID changes** (old → new; requires typing `CHANGE UPI`). The Settings tab shows "Last changed {time} by {name}" for each setting.

The Reports tab exports an injection-safe CSV. For each game it reports `total_staked`, `total_paid_out` and `gaming_revenue` (= staked − paid out). The `ALL` row also reports `approved_deposits`, `approved_withdrawals` and `net_cash` (= deposits − withdrawals) as separate fields; deposits are never added to gaming revenue. All report dates are interpreted in IST.

Ledger reconciliation compares each balance with its ledger. When it was introduced, any pre-existing difference per user was stored as a legacy opening balance (`user_ledger_opening_balances`). These rows are **not** evidence that balances were correct: they may hide historical errors and should be investigated. The Reports tab always shows "Legacy opening balances: N users, total X" and the per-user rows, separately from current mismatches; balances are never adjusted automatically. Users created after that migration never receive an opening-balance row (checked by the regression suite).

## Database migrations

The canonical schema changes are the ordered SQL files in `supabase/migrations/`. For a fresh local database, start Supabase locally and run `supabase db reset`. To apply pending migrations to a linked project, first verify the Supabase CLI is linked to the intended project and review its migration status, then run `supabase db push`. Applying migrations changes the target database; do not do so until the target is confirmed.

Do not edit migrations that may already have been applied. Add a new timestamped migration for future schema changes. `supabase/baseline/README.md` describes the intended current schema; a squashed baseline dump is intentionally deferred until the migration chain is stable.

Every client-callable function is `SECURITY DEFINER` with `SET search_path = public, pg_temp`, checks `auth.uid() IS NULL` first, revokes `EXECUTE` from `PUBLIC` and `anon`, and grants it to `authenticated` explicitly (admin functions also check `is_current_user_admin()`). Default privileges no longer grant `EXECUTE` on new functions to `PUBLIC`, `anon` or `authenticated`, so a function added later is not callable until a migration grants it. Note that the global `REVOKE ... FROM PUBLIC` default (migration `20261111090000`) also applies to functions the `postgres` role creates in other schemas, including extensions it installs later; grant `EXECUTE` explicitly where clients need one. No public function name is overloaded.

## First admin

Create every account, including admins, by signing up in the app. Users created in the Supabase Dashboard (**Authentication → Add user**) have no terms-acceptance metadata, so the signup trigger rejects them with "Database error saving new user". After the user has signed up and confirmed their email, get their Auth user UUID and run this once in the intended project's Supabase SQL Editor:

```sql
UPDATE public.profiles
SET is_admin = true
WHERE id = '<uuid>';
```

Only a trusted project owner should grant the first admin role. Use the user's verified Auth UUID, keep the SQL Editor session private, and confirm the expected profile before executing the statement.

## Support-only self-exclusion unlock

Self-exclusion must not be lifted through normal user or admin controls. It expires automatically at its stored end timestamp. If an early unlock is ever required for a documented legal/support exception, route it through the project owner and a restricted support-only operational process with identity verification and an audit record; do not expose an unlock action or direct table write in the application admin UI.

## Application settings

The admin settings allowlist includes `merchant_upi_id`, `merchant_name`, `approval_time_note`, `support_whatsapp`, `support_email`, `max_user_round_points`, and `max_number_liability`; `admin_get_settings()` returns each with its last change time and the changing admin. Fixed rule values (minimum withdrawal 100, maximum withdrawal 100000, approved-deposit minimum 100, maximum add-funds 100000, turnover multiplier 1×, maximum 5000 per pick and 20000 per submit) live in the internal `internal_rule_constants()` function and are exposed read-only through `get_public_rules`; the frontend reads its bet limits from there and only keeps the quick-stake buttons locally. User responsible-play values are stored per-user as `daily_deposit_limit` and `daily_loss_limit`.

## Deployment

Set the `VITE_` variables in the build environment. `VITE_SITE_URL` must be the canonical public site origin; it is used for absolute social preview image URLs. `VITE_SENTRY_DSN` is optional; error reporting remains disabled when it is empty. Events omit default PII and user identity; emails, UPI IDs, UTRs and image file names are redacted from the message, extra data, breadcrumbs and request data, while exception stack frames are kept intact. Deploy the contents of `dist/` to a static host. Configure any additional HTTP security headers at the host; CSP `frame-ancestors` is not supported in a CSP meta tag.

The Content-Security-Policy meta tag is generated at build time (`vite/securityCsp.ts`). Production builds allow `connect-src` only to the app itself, the Supabase origin and, when `VITE_SENTRY_DSN` is set, the Sentry ingest origin parsed from it; development builds additionally allow the Vite dev-server websocket on localhost.

The app includes an install manifest with PNG icons (192, 512, maskable 512), a 180 px Apple touch icon and a 1200×630 `og-image.png` for link previews; `favicon.svg` is the only SVG used by the page (the other SVGs in `public/` are the source artwork). It intentionally does not register a service worker or cache API or betting data for offline use.

## Signup protection

Signup protection uses email confirmation, normalized-email uniqueness, a disposable-domain blocklist, and Supabase Auth rate limits. The 10-balance signup bonus is credited once after email confirmation. The email-normalization migration emits a database `NOTICE` listing any pre-existing normalized duplicates and creates a post-migration partial unique index instead of failing; review that notice and resolve any existing duplicates before replacing the partial index with a full unique index.

In the Supabase Dashboard, open **Authentication → Rate Limits** and set:

- **Rate limit for sending emails:** 2 per hour. This is the built-in email provider's limit; use a configured SMTP provider for production delivery.
- **Rate limit for sign-ups and sign-ins:** 10–20 requests per 5 minutes per IP. Many mobile users in India share carrier IP addresses (CGNAT), so a lower value such as 5 locks out legitimate users; start at 15 and adjust from the Auth logs.
- **Rate limit for sending SMS/OTP:** 1 message per hour. SMS is unused by BetZone.
- **Email confirmation/OTP resend interval:** 60 seconds. The frontend also enforces a shared 60-second cooldown for signup confirmation and resend requests.

In **Authentication → URL Configuration**, verify the production site URL and allowed confirmation redirect URLs. In **Authentication → Providers → Email**, keep signups and email confirmations enabled, configure production SMTP, and review the confirmation email template before opening registration.

To block another domain, run as a signed-in admin through the `admin_add_blocked_domain` RPC, for example `supabase.rpc('admin_add_blocked_domain', { p_domain: 'example.test' })`. The helper lowercases and validates the domain; matching also blocks its subdomains. Do not grant clients direct access to the blocklist table.
