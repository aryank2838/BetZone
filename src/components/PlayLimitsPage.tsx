import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { activePlayRestriction, formatLimitEnd, useMyLimits } from '@/lib/useMyLimits';
import { friendlyErrorDetails } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import HelpButton from '@/components/HelpButton';
import { useDialogA11y } from '@/lib/useDialogA11y';

export default function PlayLimitsPage({ onBack }: { onBack: () => void }) {
  const { refreshProfile } = useAuth();
  const { limits, error, refresh } = useMyLimits();
  const [deposit, setDeposit] = useState('');
  const [loss, setLoss] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; raw?: string; okay?: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  useDialogA11y(confirmation !== null, confirmationRef, closeConfirmation);
  const initialized = useRef(false);

  useEffect(() => {
    if (!limits || initialized.current) return;
    const scheduled = !!limits.pending_effective_at;
    const depositValue = scheduled ? limits.pending_deposit_limit : limits.daily_deposit_limit;
    const lossValue = scheduled ? limits.pending_loss_limit : limits.daily_loss_limit;
    setDeposit(depositValue === null ? '' : String(depositValue));
    setLoss(lossValue === null ? '' : String(lossValue));
    initialized.current = true;
  }, [limits]);

  const saveLimits = async () => {
    const validValue = (value: string) => value === '' || (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
    if (!validValue(deposit) || !validValue(loss)) {
      setNotice({ message: 'Enter a positive whole number or leave a limit empty to remove it.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { error: rpcError } = await supabase.rpc('set_my_limits', {
        p_daily_deposit: deposit === '' ? null : Number(deposit),
        p_daily_loss: loss === '' ? null : Number(loss),
      });
      if (rpcError) throw rpcError;
      await refresh();
      setNotice({ message: 'Play limits updated. Raises and removals take effect after 24 hours.', okay: true });
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setNotice({ message: friendly.message, raw: friendly.raw });
    } finally {
      setBusy(false);
    }
  };

  const startRestriction = async (kind: 'cooldown' | 'self_exclusion', duration: number) => {
    setBusy(true);
    setNotice(null);
    try {
      const { error: rpcError } = await supabase.rpc(kind === 'cooldown' ? 'start_cooldown' : 'self_exclude',
        kind === 'cooldown' ? { p_hours: duration } : { p_days: duration });
      if (rpcError) throw rpcError;
      await refresh();
      await refreshProfile();
      setConfirmation(null);
      setNotice({ message: kind === 'cooldown' ? 'Your break has started.' : 'Self-exclusion has started.', okay: true });
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setNotice({ message: friendly.message, raw: friendly.raw });
    } finally {
      setBusy(false);
    }
  };

  const restriction = activePlayRestriction(limits);
  const pendingLimit = limits?.pending_effective_at
    ? `A scheduled limit change takes effect ${formatLimitEnd(limits.pending_effective_at)}.`
    : '';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 px-5 py-4">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <button type="button" onClick={onBack} aria-label="Back" className="tap-target"><ArrowLeft className="h-5 w-5 text-slate-400" /></button>
          <div className="flex-1"><h1 className="font-bold">Play limits</h1><p className="text-xs text-slate-400">Set boundaries that work for you</p></div>
          <HelpButton />
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 px-5 py-8">
        {error && <Notice message={error.message} raw={error.raw} />}
        {restriction && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-4 text-sm text-amber-200">
            {restriction.kind === 'cooldown' ? 'Your betting break is active' : 'Self-exclusion is active'} until {formatLimitEnd(restriction.until)}. Deposits are available except during self-exclusion; withdrawals remain available.
          </div>
        )}
        {limits ? (
          <>
            <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">Daily limits</h2>
              <p className="text-xs text-slate-400">Deposit limit counts approved and pending deposits today (IST). Loss limit counts today's stakes minus winnings (IST). Lowering applies immediately; raising or removing a limit takes 24 hours.</p>
              <LimitInput label="Daily deposit limit (balance)" value={deposit} current={limits.daily_deposit_limit} setValue={setDeposit} />
              <LimitInput label="Daily net-loss limit (balance)" value={loss} current={limits.daily_loss_limit} setValue={setLoss} />
              {pendingLimit && <p className="text-xs text-amber-300">{pendingLimit}</p>}
              {limits.pending_effective_at && (
                <p className="text-xs text-slate-400">
                  Scheduled values: deposits {limits.pending_deposit_limit ?? 'no limit'} · losses {limits.pending_loss_limit ?? 'no limit'}
                </p>
              )}
              <button type="button" disabled={busy} onClick={() => void saveLimits()} className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-40">
                {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Save limits'}
              </button>
            </section>
            <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">Take a break</h2>
              <p className="text-xs text-slate-400">Betting is blocked during a cooldown. You can still withdraw.</p>
              <div className="grid grid-cols-2 gap-2">
                {[1, 6, 24, 72].map((hours) => (
                  <button key={hours} type="button" disabled={busy} onClick={() => void startRestriction('cooldown', hours)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40">
                    {hours < 24 ? `${hours} hour${hours > 1 ? 's' : ''}` : `${hours / 24} day${hours > 24 ? 's' : ''}`}
                  </button>
                ))}
              </div>
            </section>
            <section className="space-y-4 rounded-2xl border border-rose-900/70 bg-rose-950/20 p-5">
              <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-rose-400" /><h2 className="font-semibold">Self-exclusion</h2></div>
              <p className="text-xs text-slate-300">Self-exclusion blocks betting and deposits. It cannot be undone before the end date. Withdrawals remain available. For help lifting a restriction after it ends, contact support.</p>
              <div className="grid grid-cols-2 gap-2">
                {[7, 30, 90, 180].map((days) => (
                  <button key={days} type="button" disabled={busy} onClick={() => setConfirmation(days)} className="rounded-lg border border-rose-900 px-3 py-2 text-sm text-rose-200 hover:bg-rose-950 disabled:opacity-40">
                    {days} days
                  </button>
                ))}
              </div>
            </section>
          </>
        ) : !error ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" /> : null}
        {notice && <Notice {...notice} />}
      </main>
      {confirmation !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5">
          <div ref={confirmationRef} role="dialog" aria-modal="true" className="w-full max-w-sm space-y-4 rounded-2xl border border-rose-900 bg-slate-900 p-5">
            <h2 className="font-semibold text-white">Confirm {confirmation}-day self-exclusion</h2>
            <p className="text-sm text-slate-300">This blocks betting and deposits until the end date. <strong>This cannot be undone before the end date.</strong></p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmation(null)} className="flex-1 rounded-lg border border-slate-700 py-2 text-sm">Go back</button>
              <button type="button" disabled={busy} onClick={() => void startRestriction('self_exclusion', confirmation)} className="flex-1 rounded-lg bg-rose-700 py-2 text-sm font-semibold disabled:opacity-40">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LimitInput({ label, value, current, setValue }: {
  label: string;
  value: string;
  current: number | null;
  setValue: (value: string) => void;
}) {
  return (
    <label className="block text-xs text-slate-300">{label} <span className="text-slate-400">Current: {current ?? 'No limit'}</span>
      <input type="text" inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} placeholder="No limit" className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white focus:border-emerald-400 focus:outline-none" />
    </label>
  );
}

function Notice({ message, raw, okay }: { message: string; raw?: string; okay?: boolean }) {
  return <div className={`rounded-xl border px-4 py-3 text-sm ${okay ? 'border-emerald-900 bg-emerald-950/30 text-emerald-300' : 'border-rose-900 bg-rose-950/30 text-rose-300'}`}><p>{message}</p>{raw && <p className="mt-1 text-xs">{raw}</p>}</div>;
}
