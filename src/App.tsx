import { AuthProvider, useAuth } from '@/lib/auth';
import AuthScreen from '@/components/AuthScreen';
import Dashboard from '@/components/Dashboard';
import { Loader2, Zap } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import PasswordRecoveryScreen from '@/components/PasswordRecoveryScreen';
import LegalPage, { type LegalDocument } from '@/components/LegalPage';
import { useDialogA11y } from '@/lib/useDialogA11y';
import { TERMS_VERSION, needsTermsAcceptance } from '@/lib/terms';
import HelpButton from '@/components/HelpButton';
import WithdrawalForm, { type WalletStatus } from '@/components/WithdrawalForm';

export function Gate() {
  const { user, profile, profileError, profileErrorDetails, loading, refreshProfile, passwordRecovery, inactivityWarning, signOut } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-5">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20 animate-pulse-glow">
          <Zap className="w-6 h-6 text-white" fill="white" />
        </div>
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading BetZone
        </div>
      </div>
    );
  }

  if (user && (profileError || !profile)) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-5">
        <div className="max-w-sm text-center space-y-4">
          <div className="text-sm text-rose-300">
            <p>{profileError || 'Your account profile is unavailable.'}</p>
            {profileErrorDetails && <p className="mt-1 text-xs text-rose-400/70">{profileErrorDetails}</p>}
          </div>
          <button
            onClick={() => { void refreshProfile(); }}
            className="px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (passwordRecovery) return <PasswordRecoveryScreen />;
  if (user && profile && needsTermsAcceptance(profile)) {
    return <TermsAcceptance onAccepted={refreshProfile} onSignOut={signOut} updated={!!profile.terms_accepted_at} />;
  }
  return <>{user ? <Dashboard /> : <AuthScreen />}{inactivityWarning !== null && (
    <div role="status" className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom))] left-1/2 z-[80] -translate-x-1/2 rounded-xl border border-amber-700 bg-amber-950 px-4 py-3 text-sm text-amber-100 shadow-xl">
      You will be signed out for inactivity in {inactivityWarning} seconds. Interact with the page to stay signed in.
    </div>
  )}</>;
}

export function TermsAcceptance({ onAccepted, onSignOut, updated = false }: {
  onAccepted: () => Promise<void>;
  onSignOut: () => Promise<void>;
  /** The user accepted an older version; explain why they are asked again. */
  updated?: boolean;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [document, setDocument] = useState<LegalDocument | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const keepOpen = useCallback(() => {}, []);
  useDialogA11y(!document, dialogRef, keepOpen);
  const accept = async () => {
    setBusy(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('accept_terms', { p_version: TERMS_VERSION });
    if (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      setBusy(false);
      return;
    }
    await onAccepted();
    setBusy(false);
  };
  if (document) return <LegalPage document={document} onBack={() => setDocument(null)} />;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/95 p-5 text-slate-100">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="terms-required-title" className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-6">
        <h1 id="terms-required-title" className="text-xl font-bold">{updated ? 'Our terms have been updated' : 'Confirm your age and accept the terms'}</h1>
        {updated && <p className="text-sm text-amber-200">The Terms and Privacy Policy have changed since you last accepted them. Please review and accept the new version to continue.</p>}
        <p className="text-sm text-slate-300">You must confirm that you are 18 or older and accept the Terms and Privacy Policy to continue using the app.</p>
        <nav className="flex gap-4 text-sm text-cyan-300 underline">
          <button type="button" onClick={() => setDocument('terms')}>Terms</button><button type="button" onClick={() => setDocument('privacy')}>Privacy Policy</button>
        </nav>
        <label className="flex items-start gap-2 text-sm text-slate-200">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} className="mt-1 accent-emerald-500" />
          <span>I am 18 or older and I accept the Terms and Privacy Policy.</span>
        </label>
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        <button type="button" disabled={!checked || busy} onClick={() => void accept()} className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold disabled:opacity-40">{busy ? 'Saving…' : 'Accept and continue'}</button>
        <div className="flex items-center justify-between gap-3 border-t border-slate-800 pt-4 text-sm">
          <p className="text-xs text-slate-400">Don't want to accept? You can still withdraw your own balance, sign out, or contact support.</p>
          <div className="flex shrink-0 items-center gap-2">
            <HelpButton />
            <button type="button" onClick={() => void onSignOut()} className="tap-target rounded-lg border border-slate-700 px-3 py-2 text-slate-200 hover:bg-slate-800">Log out</button>
          </div>
        </div>
        <DeclinedTermsWithdrawal />
      </section>
    </div>
  );
}

// A8: withdrawals do not require accepted terms, so users who decline can still
// take out their own eligible balance (ban, turnover and limits still apply).
function DeclinedTermsWithdrawal() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState('');
  const loadStatus = useCallback(async () => {
    setError('');
    const { data, error: rpcError } = await supabase.rpc('get_wallet_status');
    if (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      return;
    }
    setStatus(data as WalletStatus);
  }, []);
  if (!open) {
    return (
      <button type="button" onClick={() => { setOpen(true); void loadStatus(); }} className="text-sm text-cyan-300 underline">
        Withdraw my balance instead
      </button>
    );
  }
  return (
    <div className="space-y-2 border-t border-slate-800 pt-4">
      <h2 className="text-sm font-semibold">Withdraw your balance</h2>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      <WithdrawalForm status={status} onSubmitted={loadStatus} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
