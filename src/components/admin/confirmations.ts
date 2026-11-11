import type { AddFundsRequest, WithdrawalRequest } from './RequestsTab';
import type { AdminUser } from './UsersTab';

/** High-risk admin actions that need an explicit confirmation step (C1). */
export type AdminConfirmation =
  | { kind: 'approve_add_funds'; request: AddFundsRequest; screenshotOpened: boolean }
  | { kind: 'approve_withdrawal'; request: WithdrawalRequest }
  | { kind: 'toggle_ban'; user: AdminUser }
  | { kind: 'set_admin'; user: AdminUser; isAdmin: boolean }
  | { kind: 'adjust'; user: AdminUser; target: 'points' | 'wallet'; delta: number; reason: string }
  | { kind: 'merchant_upi'; oldValue: string; newValue: string };

export interface ConfirmationContent {
  title: string;
  rows: Array<[label: string, value: string]>;
  warning?: string;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  requiredText?: string;
  danger: boolean;
}

/** Shown before a withdrawal is marked as paid. */
export const APPROVE_WITHDRAWAL_WARNING = 'Only approve after you have sent this payment. Approving marks it as paid.';

/** Text typed to grant admin rights. */
export const MAKE_ADMIN_CONFIRM_TEXT = 'ADMIN';
/** Text typed to change the merchant UPI ID that receives deposits. */
export const CHANGE_UPI_CONFIRM_TEXT = 'CHANGE UPI';

const userLabel = (user: AdminUser) => `${user.display_name || 'Unnamed'}${user.email ? ` (${user.email})` : ''}`;
const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

export function confirmationContent(confirmation: AdminConfirmation): ConfirmationContent {
  switch (confirmation.kind) {
    case 'approve_add_funds': {
      const { request, screenshotOpened } = confirmation;
      return {
        title: 'Approve and credit this deposit?',
        rows: [
          ['User', request.user_name || request.user_id],
          ['Amount', String(request.amount)],
          ['UTR / reference', request.payment_ref],
          ['Screenshot', !request.screenshot_path ? 'No screenshot attached' : screenshotOpened ? 'Opened' : 'Not opened yet'],
        ],
        warning: request.screenshot_path && !screenshotOpened
          ? 'You have not opened the payment screenshot. Check it against your bank statement before crediting.'
          : 'Crediting cannot be undone from this screen. Confirm the UTR matches a received payment.',
        confirmLabel: 'Approve & credit',
        danger: false,
      };
    }
    case 'approve_withdrawal': {
      const { request } = confirmation;
      return {
        title: 'Mark this withdrawal as paid?',
        rows: [
          ['User', request.user_name || request.user_id],
          ['Amount', String(request.amount)],
          ['UPI ID', request.upi_id],
        ],
        warning: APPROVE_WITHDRAWAL_WARNING,
        confirmLabel: 'I have paid · Approve',
        danger: true,
      };
    }
    case 'toggle_ban': {
      const { user } = confirmation;
      return user.is_banned
        ? { title: 'Unban this user?', rows: [['User', userLabel(user)]], warning: 'The user will be able to bet, deposit and withdraw again.', confirmLabel: 'Unban', danger: false }
        : { title: 'Ban this user?', rows: [['User', userLabel(user)]], warning: 'The user will be blocked from betting, deposits and withdrawals.', confirmLabel: 'Ban user', danger: true };
    }
    case 'set_admin': {
      const { user, isAdmin } = confirmation;
      return isAdmin
        ? {
          title: 'Give this user admin rights?',
          rows: [['User', userLabel(user)]],
          warning: 'Admins can credit balances, approve payouts, post results and change settings.',
          confirmLabel: 'Make admin',
          requiredText: MAKE_ADMIN_CONFIRM_TEXT,
          danger: true,
        }
        : { title: 'Remove admin rights?', rows: [['User', userLabel(user)]], confirmLabel: 'Remove admin', danger: true };
    }
    case 'adjust': {
      const { user, target, delta, reason } = confirmation;
      const current = target === 'points' ? user.points : user.wallet;
      return {
        title: 'Apply this balance adjustment?',
        rows: [
          ['User', userLabel(user)],
          ['Balance', target === 'points' ? 'Play balance' : 'Wallet'],
          ['Change', signed(delta)],
          ['Balance after', `${current} → ${current + delta}`],
          ['Reason', reason],
        ],
        warning: 'The adjustment is written to the ledger and the admin audit log.',
        confirmLabel: 'Apply adjustment',
        danger: delta < 0,
      };
    }
    case 'merchant_upi':
      return {
        title: 'Change the merchant UPI ID?',
        rows: [
          ['Current', confirmation.oldValue || '(not set)'],
          ['New', confirmation.newValue],
        ],
        warning: 'All new deposits will be paid to the new UPI ID. Double-check every character.',
        confirmLabel: 'Change UPI ID',
        requiredText: CHANGE_UPI_CONFIRM_TEXT,
        danger: true,
      };
    default:
      return { title: 'Confirm', rows: [], confirmLabel: 'Confirm', danger: false };
  }
}
