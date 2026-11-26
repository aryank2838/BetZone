-- The partner admin functions (20261127090000_partners.sql) write
-- 'save_partner', 'pause_partner', 'assign_player_partner' and
-- 'partner_week_paid' to admin_action_log, but the CHECK constraint was never
-- widened, so "Make partner" failed with admin_action_log_action_check.

ALTER TABLE public.admin_action_log
  DROP CONSTRAINT IF EXISTS admin_action_log_action_check;
ALTER TABLE public.admin_action_log
  ADD CONSTRAINT admin_action_log_action_check
  CHECK (action IN (
    'ban', 'unban', 'grant_admin', 'revoke_admin',
    'adjust_points', 'adjust_wallet',
    'approve_withdrawal', 'reject_withdrawal',
    'approve_add_funds', 'reject_add_funds',
    'post_open_result', 'post_close_result', 'set_setting',
    'close_support_ticket', 'add_blocked_domain',
    'set_holiday', 'end_holiday',
    'set_sport_settings', 'void_sport_event', 'settle_sport_event',
    'verify_email',
    'save_partner', 'pause_partner', 'assign_player_partner', 'partner_week_paid'
  ));
