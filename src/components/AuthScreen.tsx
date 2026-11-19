import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { Loader2, Zap, ArrowRight, Trophy, Wallet, TrendingUp, MailCheck } from 'lucide-react';
import { authRedirectUrl, consumeAuthRedirect, isEmailNotConfirmedError } from '@/lib/authRedirect';
import LegalPage, { type LegalDocument } from '@/components/LegalPage';
import LanguageSelector from '@/components/LanguageSelector';
import InstallBanner from '@/components/InstallBanner';
import PasswordInput from '@/components/ui/PasswordInput';
import { interpolate, useT } from '@/i18n/useT';

type Mode = 'signup' | 'login';
import { TERMS_VERSION } from '@/lib/terms';
import { suggestEmail } from '@/lib/emailTypo';
import { clearStoredReferralCode, normalizeReferralCode, storedReferralCode } from '@/lib/referral';

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
  // Show "Resend email" (on either tab) for confirmationEmail or the typed email.
  const [canResend, setCanResend] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Filled in from an invite link (?ref=CODE); optional otherwise.
  const [inviteCode, setInviteCode] = useState(() => storedReferralCode() ?? '');
  const [showInvite, setShowInvite] = useState(() => storedReferralCode() !== null);
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null);
  const nextConfirmationEmailAt = useRef(0);
  const requestInFlight = useRef(false);

  const isSignup = mode === 'signup';
  // "Did you mean …@gmail.com?" once the player leaves the email box (or submits).
  const [emailChecked, setEmailChecked] = useState(false);
  const emailSuggestion = emailChecked ? suggestEmail(email) : null;
  const [didYouMeanBefore, didYouMeanAfter = ''] = t('auth.didYouMean').split('{email}');

  // Back from an email link: say what happened instead of failing silently.
  useEffect(() => {
    const redirect = consumeAuthRedirect();
    if (redirect.error) {
      setMode('login');
      setCanResend(true);
      setError(t('auth.linkExpired'));
      setErrorDetails(redirect.error.description);
      return;
    }
    if (redirect.tokenHash) {
      setMode('login');
      setBusy(true);
      void supabase.auth.verifyOtp(redirect.tokenHash).then(({ error: verifyError }) => {
        if (verifyError) {
          setCanResend(true);
          setError(t('auth.linkExpired'));
          setErrorDetails(rawErrorMessage(verifyError));
        } else {
          setNotice(t('auth.emailConfirmed'));
        }
      }).finally(() => setBusy(false));
    }
    // Runs once on mount; `t` only picks the message language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (isSignup && inviteCode.trim() && !normalizeReferralCode(inviteCode)) {
      setError(t('auth.inviteInvalid'));
      return;
    }
    if (isSignup && password.length < 8) {
      setError(t('auth.errorPassword'));
      return;
    }
    // Show a likely typo once before creating the account; a second tap goes ahead.
    if (isSignup && !emailChecked && suggestEmail(email)) {
      setEmailChecked(true);
      return;
    }
    if (isSignup && Date.now() < nextConfirmationEmailAt.current) {
      setError(interpolate(t('auth.resendWait'), { seconds: resendCooldown }));
      return;
    }

    requestInFlight.current = true;
    setBusy(true);
    try {
      if (isSignup) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: authRedirectUrl(),
            data: {
              display_name: name.trim(),
              accepted_terms: true,
              terms_version: TERMS_VERSION,
              ...(normalizeReferralCode(inviteCode) ? { referral_code: normalizeReferralCode(inviteCode) } : {}),
            },
          },
        });
        if (signUpError) throw signUpError;
        clearStoredReferralCode();
        if (!data.session) {
          setConfirmationPending(true);
          setConfirmationEmail(email.trim());
          setCanResend(true);
          startResendCooldown();
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      }
    } catch (err) {
      if (!isSignup && isEmailNotConfirmedError(err)) {
        setConfirmationEmail(email.trim());
        setCanResend(true);
        setError(t('auth.emailNotConfirmed'));
        return;
      }
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
        redirectTo: authRedirectUrl(),
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
    const target = confirmationEmail || email.trim();
    if (!target) {
      setError(t('auth.enterEmail'));
      return;
    }
    if (requestInFlight.current || Date.now() < nextConfirmationEmailAt.current) return;
    setConfirmationEmail(target);
    setError('');
    setErrorDetails('');
    setNotice('');
    startResendCooldown();
    requestInFlight.current = true;
    setBusy(true);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: target,
        options: { emailRedirectTo: authRedirectUrl() },
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
    setCanResend(false);
    setAcceptedTerms(false);
  };

  const goToLoginAfterSignup = () => {
    changeMode('login');
    setEmail(confirmationEmail);
    setPassword('');
  };

  const resendButton = canResend && (
    <button
      type="button"
      onClick={() => { void handleResendEmail(); }}
      disabled={busy || resendCooldown > 0}
      className="min-h-[44px] w-full text-sm text-cyan-400 hover:text-cyan-300 disabled:text-slate-400 disabled:opacity-70 disabled:cursor-not-allowed"
    >
      {resendCooldown > 0 ? interpolate(t('auth.resendIn'), { seconds: resendCooldown }) : t('auth.resend')}
    </button>
  );

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

        <div className="mb-7 empty:hidden"><InstallBanner /></div>

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

        {confirmationPending && isSignup ? (
          <div className="space-y-5 animate-fade-in" role="status">
            <div className="rounded-xl border border-emerald-900 bg-emerald-950/40 p-4">
              <div className="flex items-center gap-2 text-emerald-300">
                <MailCheck className="h-5 w-5 shrink-0" />
                <h2 className="text-base font-semibold">{t('auth.confirmTitle')}</h2>
              </div>
              <p className="mt-2 text-sm text-slate-300 break-words">
                {interpolate(t('auth.confirmSentTo'), { email: confirmationEmail })}
              </p>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-200">
                <li>{t('auth.confirmStep1')}</li>
                <li>{t('auth.confirmStep2')}</li>
                <li>{t('auth.confirmStep3')}</li>
              </ol>
              <p className="mt-3 text-xs text-amber-300">{t('auth.confirmLatestOnly')}</p>
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
              type="button"
              onClick={goToLoginAfterSignup}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-sm font-semibold hover:from-emerald-400 hover:to-cyan-400 transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
            >
              {t('auth.confirmedGoLogin')}
              <ArrowRight className="w-4 h-4" />
            </button>
            {resendButton}
          </div>
        ) : (
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
              onChange={(e) => { setEmail(e.target.value); setConfirmationEmail(''); }}
              onBlur={() => setEmailChecked(true)}
              readOnly={confirmationPending}
              placeholder="you@example.com"
              autoComplete="email"
              aria-describedby={isSignup ? 'email-hint' : undefined}
              className="w-full px-4 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-white placeholder-slate-500 focus:border-emerald-400 focus:ring-0 focus:outline-none transition-colors"
            />
            {isSignup && (
              <p id="email-hint" className="mt-1.5 text-xs text-slate-400">{t('auth.emailHint')}</p>
            )}
            {isSignup && emailSuggestion && (
              <p role="status" className="mt-1.5 text-xs text-amber-300">
                {didYouMeanBefore}
                <button
                  type="button"
                  onClick={() => { setEmail(emailSuggestion); setEmailChecked(false); }}
                  className="font-semibold text-cyan-300 underline break-all"
                >
                  {emailSuggestion}
                </button>
                {didYouMeanAfter}
              </p>
            )}
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
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder=              {isSignup ? t('settings.newPassword') : t('auth.password')}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              className="w-full px-4 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-white placeholder-slate-500 focus:border-emerald-400 focus:ring-0 focus:outline-none transition-colors"
            />
          </div>

          {isSignup && (showInvite ? (
            <div className="animate-fade-in">
              <label htmlFor="invite-code" className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                {t('auth.inviteCode')}
              </label>
              <input
                id="invite-code"
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                placeholder="ABC234"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="w-full px-4 py-3 rounded-xl bg-slate-800/60 border border-slate-700 text-white tracking-[0.3em] placeholder-slate-500 focus:border-emerald-400 focus:ring-0 focus:outline-none transition-colors"
              />
              <p className="mt-1.5 text-xs text-slate-400">{t('auth.inviteHint')}</p>
            </div>
          ) : (
            <button type="button" onClick={() => setShowInvite(true)} className="text-xs text-cyan-300 underline">
              {t('auth.haveInvite')}
            </button>
          ))}

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
            disabled={busy}
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
          {resendButton}
        </form>
        )}

        <p className="text-xs text-slate-400 text-center mt-7">
          {t('auth.starterBonus')}
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
