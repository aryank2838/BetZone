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
import ToastProvider from '@/components/ui/ToastProvider';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { interpolate, useT } from '@/i18n/useT';

export function Gate() {
  const { user, profile, profileError, profileErrorDetails, loading, refreshProfile, passwordRecovery, inactivityWarning, signOut } = useAuth();
  const { t } = useT();

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-page flex flex-col items-center justify-center gap-5">
        <div className="w-14 h-14 rounded-card bg-gradient-to-br from-brand-400 to-accent-500 flex items-center justify-center shadow-lg shadow-brand-500/20 animate-pulse-glow">
          <Zap className="w-6 h-6 text-white" fill="white" />
        </div>
        <div className="flex items-center gap-2 text-ink-muted text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('app.loading')}
        </div>
      </div>
    );
  }

  if (user && (profileError || !profile)) {
    return (
      <div className="min-h-screen bg-surface-page flex items-center justify-center px-5">
        <div className="w-full max-w-sm space-y-4">
          <Alert details={profileErrorDetails}>{profileError || t('app.profileUnavailable')}</Alert>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => { void refreshProfile(); }}>{t('common.retry')}</Button>
            <Button variant="secondary" onClick={() => { void signOut(); }}>{t('common.logout')}</Button>
          </div>
        </div>
      </div>
    );
  }

  if (passwordRecovery) return <PasswordRecoveryScreen />;
  if (user && profile && needsTermsAcceptance(profile)) {
    return <TermsAcceptance onAccepted={refreshProfile} onSignOut={signOut} updated={!!profile.terms_accepted_at} />;
  }
  return <>{user ? <Dashboard /> : <AuthScreen />}{inactivityWarning !== null && (
    <div role="status" className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] left-1/2 z-[80] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-control border border-amber-700 bg-amber-950 px-4 py-3 text-sm text-amber-100 shadow-xl">
      {interpolate(t('app.inactivity'), { seconds: inactivityWarning })}
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
  const { t } = useT();
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-surface-page/95 p-4 text-ink">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="terms-required-title" className="my-auto w-full max-w-lg space-y-4 rounded-card border border-surface-strong bg-surface p-6">
        <h1 id="terms-required-title" className="text-xl font-bold text-ink-strong">{updated ? t('terms.updatedTitle') : t('terms.title')}</h1>
        {updated && <Alert tone="warning">{t('terms.updatedBody')}</Alert>}
        <p className="text-sm text-ink-soft">{t('terms.body')}</p>
        <nav className="flex gap-2 text-sm">
          <Button variant="ghost" className="text-accent-300 underline" onClick={() => setDocument('terms')}>{t('auth.terms')}</Button>
          <Button variant="ghost" className="text-accent-300 underline" onClick={() => setDocument('privacy')}>{t('auth.privacy')}</Button>
        </nav>
        <label className="flex min-h-tap cursor-pointer items-start gap-3 rounded-control border border-surface-strong bg-surface-raised/50 p-3 text-sm text-ink">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500" />
          <span>{t('terms.checkbox')}</span>
        </label>
        {error && <Alert>{error}</Alert>}
        <Button size="lg" fullWidth loading={busy} disabled={!checked} onClick={() => void accept()}>{t('terms.accept')}</Button>
        <div className="flex flex-col gap-3 border-t border-surface-border pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">{t('terms.decline')}</p>
          <div className="flex shrink-0 items-center gap-2">
            <HelpButton />
            <Button variant="secondary" onClick={() => void onSignOut()}>{t('common.logout')}</Button>
          </div>
        </div>
        <DeclinedTermsWithdrawal />
      </section>
    </div>
  );
}

// A8: withdrawals do not require accepted terms, so users who decline can still
// take out their own eligible balance (ban and limits still apply).
function DeclinedTermsWithdrawal() {
  const { t } = useT();
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
      <Button variant="ghost" className="text-accent-300 underline" onClick={() => { setOpen(true); void loadStatus(); }}>
        {t('terms.withdrawInstead')}
      </Button>
    );
  }
  return (
    <div className="space-y-3 border-t border-surface-border pt-4">
      <h2 className="text-sm font-semibold text-ink-strong">{t('terms.withdrawTitle')}</h2>
      {error && <Alert>{error}</Alert>}
      <WithdrawalForm status={status} onSubmitted={loadStatus} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </AuthProvider>
  );
}
