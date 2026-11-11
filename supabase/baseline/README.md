# Intended Supabase schema

This describes the intended schema after applying the ordered migrations in `supabase/migrations/`. It is documentation, not a replacement for the migration history. Do not edit applied migrations or apply an unreviewed baseline dump over an existing project.

## Core tables

- `profiles`: Auth-linked profile, play balance, withdrawable wallet balance, admin and ban flags.
- `selections`: one user's picks for a game, bet type, and IST round date; rows are protected by RLS and written through `submit_selection`.
- `point_ledger`: append-only balance ledger with user-readable own rows.
- `withdrawals` and `add_funds_requests`: user-owned financial requests, processed only through admin RPCs.
- `winning_results` and `game_schedule`: round results and server-side IST game schedule.
- `app_settings`: server-controlled configuration; clients read only the explicitly allow-listed public settings through an RPC.
- `admin_action_log`: admin audit trail for money, result, role, and settings changes.
- `blocked_email_domains`: private disposable-email domain blocklist, read only by signup protection and admin routines.
- `selections_backup`: private migration backup, not exposed to clients.

Legacy `winning_numbers` and `ad_rewards` are removed. `ad_rewards` and `winning_numbers` must not be reintroduced as active application data.

## Database-enforced operations

User RPCs handle submitting selections, reading status/balances/results/settings, and requesting deposits or withdrawals. Admin RPCs handle results and payouts, requests, users, settings, and balance adjustments. Direct client writes to money-sensitive tables are not part of the application contract.

`submit_selection` enforces server-side IST betting windows, duplicate pick locking, balance spending order, per-bet and per-submit limits, per-user round exposure, and per-number liability. Bet submissions and settlement are serialized with a shared round lock. Withdrawals require an approved deposit and the configured wagering turnover, and reserve funds from the wallet immediately.

All public `SECURITY DEFINER` functions must use `search_path = public, pg_temp`. Authenticated user functions reject unauthenticated callers and have explicit execution grants; internal payout and locking functions are not client-callable.

Signup email addresses are normalized and checked against the existing profiles and blocked-domain list before an Auth user is inserted. New profiles start with zero play balance; the 10-unit signup bonus is recorded exactly once after email confirmation.

## Storage

The `payment-screenshots` bucket is private, limits uploads to JPEG, PNG, and WebP files up to 5 MiB, and scopes user upload/read/delete access to that user's folder. Admins may inspect uploaded screenshots for request review.

## Baseline dump

The repository's migration sequence remains authoritative. Create a fresh-environment squashed baseline only after the migration history is stable, using a reviewed `supabase db dump`; keep it separate from and never use it to rewrite already-applied migration history.
