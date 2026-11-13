import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import { Send } from 'lucide-react';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { useToast } from '@/components/ui/toastContext';

export interface WalletStatus {
  points: number;
  wallet: number;
  pending_withdrawals: number;
  is_banned: boolean;
  approved_deposits: number;
  wagered_turnover: number;
  turnover_remaining: number;
  min_withdrawal: number;
  max_withdrawal: number;
  withdrawal_eligible: boolean;
}

interface WithdrawalFormProps {
  status: WalletStatus | null;
  onSubmitted: () => Promise<void>;
  onSubmittingChange?: (submitting: boolean) => void;
}

const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,255}@[A-Za-z]{2,64}$/;
const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-4 py-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';

export default function WithdrawalForm({ status, onSubmitted, onSubmittingChange }: WithdrawalFormProps) {
  const { formatNumber } = useFormat();
  const { t } = useT();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [upiId, setUpiId] = useState('');
  const [prefilledUpi, setPrefilledUpi] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fill in the UPI ID from the player's last paid withdrawal, so they don't
  // retype it (and risk a typo) every time. Rejected requests are skipped in
  // case the UPI ID was the reason.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error: queryError } = await supabase
          .from('withdrawals')
          .select('upi_id')
          .eq('status', 'approved')
          .not('upi_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const saved = (data as { upi_id?: string | null } | null)?.upi_id ?? '';
        if (!active || queryError || !saved) return;
        setPrefilledUpi(saved);
        setUpiId((current) => current || saved);
      } catch {
        // Pre-filling is a convenience; the player can always type it.
      }
    })();
    return () => { active = false; };
  }, []);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const rupees = (value: number) => `₹${formatNumber(value)}`;

  const disabledReason = !status
    ? t('withdraw.loading')
    : status.is_banned
      ? t('withdraw.banned')
    : status.pending_withdrawals > 0
      ? t('withdraw.pending')
      : status.wallet < status.min_withdrawal
        ? interpolate(t('withdraw.walletMin'), { min: rupees(status.min_withdrawal) })
        : status.approved_deposits < status.min_withdrawal
          ? interpolate(t('withdraw.depositMin'), { min: rupees(status.min_withdrawal) })
          : status.turnover_remaining > 0
            ? interpolate(t('withdraw.turnover'), { amount: rupees(status.turnover_remaining) })
            : null;

  const parsedAmount = /^[0-9]+$/.test(amount) ? Number(amount) : NaN;
  const maxAllowed = status ? Math.min(status.wallet, status.max_withdrawal) : 0;
  const amountIsValid = !!status && Number.isSafeInteger(parsedAmount)
    && parsedAmount >= status.min_withdrawal
    && parsedAmount <= maxAllowed;

  const handleSubmit = async () => {
    if (!status || !status.withdrawal_eligible) return;
    if (!/^[0-9]+$/.test(amount)) {
      setError({ text: t('withdraw.digitsOnly') });
      return;
    }
    if (!amountIsValid) {
      setError({ text: interpolate(t('withdraw.range'), { min: rupees(status.min_withdrawal), max: rupees(maxAllowed) }) });
      return;
    }
    if (!UPI_ID_PATTERN.test(upiId.trim())) {
      setError({ text: t('withdraw.upiInvalid') });
      return;
    }

    setSubmitting(true);
    onSubmittingChange?.(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('request_withdrawal', {
        p_amount: parsedAmount,
        p_upi_id: upiId.trim(),
      });
      if (rpcError) throw rpcError;
      setAmount('');
      toast.show(t('withdraw.sent'));
      await onSubmitted();
    } catch (caught) {
      const friendly = friendlyError(caught);
      setError({
        text: friendly.message,
        raw: friendly.key === 'errors.generic' ? rawErrorMessage(caught) : undefined,
      });
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
    <div className="space-y-4">
      {status && (
        <p className="text-sm text-ink-muted">
          {interpolate(t('withdraw.available'), { amount: rupees(status.wallet), min: rupees(status.min_withdrawal), max: rupees(status.max_withdrawal) })}
        </p>
      )}
      {disabledReason && <Alert tone="warning">{disabledReason}</Alert>}
      <div>
        <label htmlFor="withdraw-amount" className="mb-1.5 block text-sm font-medium text-ink-soft">{t('withdraw.amount')}</label>
        <input
          id="withdraw-amount"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={amount}
          onChange={(event) => { setAmount(event.target.value); setError(null); }}
          placeholder="e.g. 900"
          className={INPUT}
        />
      </div>
      <div>
        <label htmlFor="withdraw-upi-id" className="mb-1.5 block text-sm font-medium text-ink-soft">{t('withdraw.upi')}</label>
        <input
          id="withdraw-upi-id"
          type="text"
          value={upiId}
          onChange={(event) => { setUpiId(event.target.value); setError(null); }}
          placeholder="yourname@upi"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={INPUT}
        />
        {prefilledUpi && upiId === prefilledUpi && (
          <p className="mt-1.5 text-xs text-ink-muted">{t('withdraw.upiSaved')}</p>
        )}
      </div>
      {error && <Alert details={error.raw}>{error.text}</Alert>}
      <Button
        size="lg"
        fullWidth
        loading={submitting}
        disabled={!status?.withdrawal_eligible || !amountIsValid}
        icon={<Send className="h-4 w-4" />}
        onClick={() => void handleSubmit()}
      >
        {t('withdraw.submit')}
      </Button>
    </div>
  );
}
