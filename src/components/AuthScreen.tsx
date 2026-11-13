import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { Loader2, Zap, ArrowRight, Trophy, Wallet, TrendingUp } from 'lucide-react';
import LegalPage, { type LegalDocument } from '@/components/LegalPage';
import LanguageSelector from '@/components/LanguageSelector';
import { useT } from '@/i18n/useT';

type Mode = 'signup' | 'login';
import { TERMS_VERSION } from '@/lib/terms';

export default function AuthScreen() {
  const { t } = useT();
  const [mode, setMode] = useState<Mode>('signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null);
  const nextConfirmationEmailAt = useRef(0);
  const requestInFlight = useRef(false);

  const isSignup = mode === 'signup';

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setTimeout(() => setResendCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendCooldown]);

  if (legalDocument) {
    return <LegalPage document={legalDocument} onBack={() => setLegalDocument(null)} />;
  }

  const startResendCooldown = () => {
    nextConfirmationEmailAt.current = Date.now() + 60_000;
    setResendCooldown(60);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (requestInFlight.current) return;
    setError('');
    setErrorDetails('');
    setNotice('');

    if (!email.trim() || !password) {
      setError(t('auth.errorCredentials'));
      return;
    }
    if (isSignup && !name.trim()) {
      setError(t('auth.errorName'));
      return;
    }
    if (isSignup && !acceptedTerms) {
      setError(t('auth.errorTerms'));
      return;
    }
    if (isSignup && password.length < 8) {
      setError(t('auth.errorPassword'));
      return;
    }
    if (isSignup && Date.now() < nextConfirmationEmailAt.current) {
      setError(`Please wait ${resendCooldown} seconds before requesting another confirmation email.`);
      return;
    }

    requestInFlight.current = true;
    setBusy(true);
    try {
      if (isSignup) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim(), accepted_terms: true, terms_version: TERMS_VERSION } },
        });
        if (signUpError) throw signUpError;
        if (!data.session) {
          setConfirmationPending(true);
          setConfirmationEmail(email.trim());
          startResendCooldown();
          setNotice(t('auth.checkEmail'));
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      }
    } catch (err) {
      const friendly = friendlyError(err);
      setError(friendly.message);
      setErrorDetails(friendly.key === 'errors.generic' ? rawErrorMessage(err) : '');
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setErrorDetails('');
    setNotice('');
    if (!email.trim()) {
      setError(t('auth.enterEmail'));
      return;
    }
    setBusy(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: import.meta.env.VITE_SITE_URL || window.location.origin,
      });
      if (resetError) throw resetError;
    } catch {
      setError('');
    } finally {
      setNotice(t('auth.resetSent'));
      setBusy(false);
    }
  };

  const handleResendEmail = async () => {
    if (!confirmationEmail || requestInFlight.current || Date.now() < nextConfirmationEmailAt.current) return;
    setError('');
    setErrorDetails('');
    setNotice('');
    startResendCooldown();
    requestInFlight.current = true;
    setBusy(true);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: confirmationEmail,
      });
      if (resendError) throw resendError;
      setNotice(t('auth.confirmationResent'));
    } catch (err) {
      const friendly = friendlyError(err);
      setError(friendly.message);
      setErrorDetails(friendly.key === 'errors.generic' ? rawErrorMessage(err) : '');
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  };

  const changeMode = (nextMode: Mode) => {
    setMode(nextMode);
    setError('');
    setErrorDetails('');
    setNotice('');
    setConfirmationPending(false);
    setAcceptedTerms(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-5 py-10 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-[300px] h-[300px] bg-cyan-500/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-full max-w-sm relative z-10">
        <div className="mb-4 flex justify-end"><LanguageSelector compact /></div>
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center mb-3 shadow-lg shadow-emerald-500/20">
            <Zap className="w-6 h-6 text-white" fill="white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">BetZone</h1>
          <p className="text-slate-400 text-sm mt-1">{t('auth.tagline')}</p>
        </div>

        {/* Feature pills */}
        <div className="flex justify-center gap-2 mb-7">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700">
            <Trophy className="w-3 h-3 text-amber-400" />
            <span className="text-xs text-slate-300 font-medium">120x Patti</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700">
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            <span className="text-xs text-slate-300 font-medium">90x Jodi</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700">
            <Wallet className="w-3 h-3 text-cyan-400" />
            <span className="text-xs text-slate-300 font-medium">UPI Add</span>
          </div>
        </div>

        <div className="flex border-b border-slate-800 mb-7">
          <button
            type="button"
            onClick={() => changeMode('signup')}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              isSignup
                ? 'text-emerald-400 border-b-2 border-emerald-400 -mb-px'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {t('auth.signup')}
          </button>
          <button
            type="button"
            onClick={() => changeMode('login')}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
              !isSignup
                ? 'text-emerald-400 border-b-2 border-emerald-400 -mb-px'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            {t('auth.login')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {isSignup && (
            <div className="animate-fade-in">
              <label htmlFor="name" className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                {t('auth.name')}
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('auth.yourName')}
                autoComplete="name"
                className="w-full px-4 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-white placeholder-slate-500 focus:border-emerald-400 focus:ring-0 focus:outline-none transition-colors"
              />
            </div>
          )}
          {isSignup && (
            <label className="flex items-start gap-2.5 py-1 text-xs leading-5 text-slate-300">
              <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500" />
              <span>
                {t('auth.acceptPrefix')}{' '}
                <button type="button" className="text-cyan-300 underline" onClick={() => setLegalDocument('terms')}>{t('auth.terms')}</button>
                {' '}{t('auth.and')}{' '}
                <button type="button" className="text-cyan-300 underline" onClick={() => setLegalDocument('privacy')}>{t('auth.privacyPolicy')}</button>.
              </span>
            </label>
          )}

          <div>
            <label htmlFor="email" className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
              {t('auth.email')}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              readOnly={confirmationPending}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-4 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-white placeholder-slate-500 focus:border-emerald-400 focus:ring-0 focus:outline-none transition-colors"
            />
          </div>
          {!isSignup && (
            <button type="button" disabled={busy} onClick={() => { void handleForgotPassword(); }} className="text-xs text-cyan-300 underline disabled:opacity-50">
              {t('auth.forgotPassword')}
            </button>
          )}

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
              {t('auth.password')}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder=              {isSignup ? t('settings.newPassword') : t('auth.password')}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              className="w-full px-4 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-white placeholder-slate-500 focus:border-emerald-400 focus:ring-0 focus:outline-none transition-colors"
            />
          </div>

          {error && (
            <div role="alert" className="text-sm text-rose-400 bg-rose-950/40 border border-rose-900 rounded-lg px-3 py-2">
              <p>{error}</p>
              {errorDetails && <p className="mt-1 text-xs text-rose-400/70">{errorDetails}</p>}
            </div>
          )}
          {notice && (
            <p className="text-sm text-emerald-400 bg-emerald-950/40 border border-emerald-900 rounded-lg px-3 py-2">{notice}</p>
          )}

          <button
            type="submit"
            disabled={busy || (isSignup && confirmationPending)}
            className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-sm font-semibold hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                {isSignup ? t('auth.createAccount') : t('auth.login')}
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
          {confirmationPending && isSignup && (
            <button
              type="button"
              onClick={() => { void handleResendEmail(); }}
              disabled={busy || resendCooldown > 0 || !confirmationEmail}
              className="min-h-[44px] w-full text-sm text-cyan-400 hover:text-cyan-300 disabled:text-slate-400 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {resendCooldown > 0 ? `Resend email (${resendCooldown}s)` : 'Resend email'}
            </button>
          )}
        </form>

        <p className="text-xs text-slate-400 text-center mt-7">
          Confirm your email to receive 10 starter points.
        </p>
        <nav className="mt-4 flex justify-center gap-4 text-xs text-slate-400">
          <button type="button" onClick={() => setLegalDocument('terms')} className="underline hover:text-slate-300">{t('auth.terms')}</button>
          <button type="button" onClick={() => setLegalDocument('privacy')} className="underline hover:text-slate-300">{t('auth.privacy')}</button>
          <button type="button" onClick={() => setLegalDocument('contact')} className="underline hover:text-slate-300">{t('auth.contact')}</button>
        </nav>
      </div>
    </div>
  );
}
