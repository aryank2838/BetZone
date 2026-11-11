import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import ConfirmDialog from '@/components/admin/ConfirmDialog';
import { CHANGE_UPI_CONFIRM_TEXT, MAKE_ADMIN_CONFIRM_TEXT, confirmationContent, type AdminConfirmation } from '@/components/admin/confirmations';
import { useDialogA11y } from '@/lib/useDialogA11y';
import type { AdminUser } from '@/components/admin/UsersTab';
import type { AddFundsRequest } from '@/components/admin/RequestsTab';

const user: AdminUser = {
  id: 'u1', display_name: 'Asha', email: 'asha@example.invalid', points: 20, wallet: 500,
  is_admin: false, is_banned: false, created_at: '2026-11-01T00:00:00Z',
};
const request: AddFundsRequest = {
  id: 'r1', user_id: 'u1', amount: 750, status: 'pending', payment_ref: 'UTR123456789',
  screenshot_path: 'u1/proof.png', created_at: '2026-11-11T05:00:00Z', processed_at: null, reject_reason: null, user_name: 'Asha',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('admin confirmation content', () => {
  it('shows user, amount, UTR and whether the screenshot was opened before crediting', () => {
    const notOpened = confirmationContent({ kind: 'approve_add_funds', request, screenshotOpened: false });
    expect(notOpened.rows).toEqual([
      ['User', 'Asha'], ['Amount', '750'], ['UTR / reference', 'UTR123456789'], ['Screenshot', 'Not opened yet'],
    ]);
    expect(notOpened.warning).toMatch(/not opened the payment screenshot/);
    const opened = confirmationContent({ kind: 'approve_add_funds', request, screenshotOpened: true });
    expect(opened.rows).toContainEqual(['Screenshot', 'Opened']);
  });

  it('requires typing ADMIN only when granting admin rights', () => {
    expect(confirmationContent({ kind: 'set_admin', user, isAdmin: true }).requiredText).toBe(MAKE_ADMIN_CONFIRM_TEXT);
    expect(confirmationContent({ kind: 'set_admin', user, isAdmin: false }).requiredText).toBeUndefined();
    expect(confirmationContent({ kind: 'toggle_ban', user }).confirmLabel).toBe('Ban user');
    expect(confirmationContent({ kind: 'toggle_ban', user: { ...user, is_banned: true } }).confirmLabel).toBe('Unban');
  });

  it('summarises a balance adjustment before it is sent', () => {
    const content = confirmationContent({ kind: 'adjust', user, target: 'wallet', delta: -200, reason: 'Duplicate credit' });
    expect(content.rows).toEqual([
      ['User', 'Asha (asha@example.invalid)'], ['Balance', 'Wallet'], ['Change', '-200'],
      ['Balance after', '500 → 300'], ['Reason', 'Duplicate credit'],
    ]);
    expect(content.danger).toBe(true);
  });

  it('shows old and new merchant UPI IDs and requires typing CHANGE UPI', () => {
    const content = confirmationContent({ kind: 'merchant_upi', oldValue: 'old@okaxis', newValue: 'new@okhdfc' });
    expect(content.rows).toEqual([['Current', 'old@okaxis'], ['New', 'new@okhdfc']]);
    expect(content.requiredText).toBe(CHANGE_UPI_CONFIRM_TEXT);
  });
});

function Harness({ confirmation, onConfirm }: { confirmation: AdminConfirmation; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open confirm</button>
      {open && (
        <ConfirmDialog
          content={confirmationContent(confirmation)}
          busy={false}
          onConfirm={onConfirm}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('ConfirmDialog', () => {
  it('blocks the action until the required text is typed', () => {
    const onConfirm = vi.fn();
    render(<Harness confirmation={{ kind: 'merchant_upi', oldValue: 'old@okaxis', newValue: 'new@okhdfc' }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open confirm' }));
    const confirm = screen.getByRole('button', { name: 'Change UPI ID' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'change upi' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'CHANGE UPI' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape without confirming and restores focus to the trigger', () => {
    const onConfirm = vi.fn();
    render(<Harness confirmation={{ kind: 'toggle_ban', user }} onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Open confirm' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Asha (asha@example.invalid)');
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('only closes the topmost dialog when nested in another dialog', () => {
    const outerClose = vi.fn();
    function Outer() {
      const ref = useRef<HTMLElement>(null);
      const close = useCallback(() => outerClose(), []);
      useDialogA11y(true, ref, close);
      return <section ref={ref} role="dialog" aria-label="Outer"><Harness confirmation={{ kind: 'toggle_ban', user }} onConfirm={vi.fn()} /></section>;
    }
    render(<Outer />);
    fireEvent.click(screen.getByRole('button', { name: 'Open confirm' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(outerClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outerClose).toHaveBeenCalledTimes(1);
  });
});
