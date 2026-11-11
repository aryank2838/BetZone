import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { useFormat } from '@/i18n/useFormat';
import { Clock, Loader2, Send } from 'lucide-react';

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

export default function WithdrawalForm({ status, onSubmitted, onSubmittingChange }: WithdrawalFormProps) {
  const { formatNumber } = useFormat();
  const [amount, setAmount] = useState('');
  const [upiId, setUpiId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string; raw?: string } | null>(null);

  const disabledReason = !status
    ? 'Withdrawal availability is loading.'
    : status.is_banned
      ? 'Withdrawals are unavailable for this account.'
    : status.pending_withdrawals > 0
      ? 'A withdrawal is already pending. Wait for it to be processed.'
      : status.wallet < status.min_withdrawal
        ? `Your wallet balance must be at least ${status.min_withdrawal}.`
        : status.approved_deposits < status.min_withdrawal
          ? `You need at least ${status.min_withdrawal} in approved deposits before withdrawing.`
          : status.turnover_remaining > 0
            ? `Wager ${status.turnover_remaining} more to meet the 1× approved-deposit turnover requirement.`
            : null;

  const parsedAmount = /^[0-9]+$/.test(amount) ? Number(amount) : NaN;
  const amountIsValid = !!status && Number.isSafeInteger(parsedAmount)
    && parsedAmount >= status.min_withdrawal
    && parsedAmount <= Math.min(status.wallet, status.max_withdrawal);

  const handleSubmit = async () => {
    if (!status || !status.withdrawal_eligible) return;
    if (!/^[0-9]+$/.test(amount)) {
      setMessage({ kind: 'err', text: 'Enter a whole-number amount using digits only.' });
      return;
    }
    if (!amountIsValid) {
      setMessage({ kind: 'err', text: `Enter an amount from ${status.min_withdrawal} to ${Math.min(status.wallet, status.max_withdrawal)}.` });
      return;
    }
    if (!UPI_ID_PATTERN.test(upiId.trim())) {
      setMessage({ kind: 'err', text: 'Enter a valid UPI ID, such as name@bank.' });
      return;
    }

    setSubmitting(true);
    onSubmittingChange?.(true);
    setMessage(null);
    try {
      const { error } = await supabase.rpc('request_withdrawal', {
        p_amount: parsedAmount,
        p_upi_id: upiId.trim(),
      });
      if (error) throw error;
      setAmount('');
      setUpiId('');
      setMessage({ kind: 'ok', text: 'Withdrawal request sent. The admin will process it soon.' });
      await onSubmitted();
    } catch (error) {
      const friendly = friendlyError(error);
      setMessage({
        kind: 'err',
        text: friendly.message,
        raw: friendly.key === 'errors.generic' ? rawErrorMessage(error) : undefined,
      });
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  };

  return (
    <div className="space-y-4">
      {status && (
        <p className="text-xs text-slate-400">
          Available: {formatNumber(status.wallet)} · minimum {formatNumber(status.min_withdrawal)} · maximum {formatNumber(status.max_withdrawal)}
        </p>
      )}
      {disabledReason && (
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded-lg px-3 py-2">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>{disabledReason}</span>
        </div>
      )}
      <div>
        <label htmlFor="withdraw-amount" className="block text-xs text-slate-400 mb-1.5">Amount (balance)</label>
        <input
          id="withdraw-amount"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={amount}
          onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
          onChange={(event) => { setAmount(event.target.value); setMessage(null); }}
          placeholder="e.g. 900"
          className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
        />
      </div>
      <div>
        <label htmlFor="withdraw-upi-id" className="block text-xs text-slate-400 mb-1.5">UPI ID</label>
        <input
          id="withdraw-upi-id"
          type="text"
          value={upiId}
          onChange={(event) => { setUpiId(event.target.value); setMessage(null); }}
          placeholder="yourname@upi"
          className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
        />
      </div>
      {message && (
        <div className={`text-sm ${message.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`} role={message.kind === 'err' ? 'alert' : 'status'}>
          <p>{message.text}</p>
          {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
        </div>
      )}
      <button
        onClick={handleSubmit}
        disabled={submitting || !status?.withdrawal_eligible || !amountIsValid}
        className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-bold hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/15"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-4 h-4" /> Request withdrawal</>}
      </button>
    </div>
  );
}
