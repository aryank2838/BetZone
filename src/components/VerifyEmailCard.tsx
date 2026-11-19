import { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, MailCheck, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { cleanCode } from '@/lib/verifyCode';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { useToast } from '@/components/ui/toastContext';
import { interpolate, useT } from '@/i18n/useT';

const RESEND_SECONDS = 60;
const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-4 py-3 text-center text-xl font-bold tracking-[0.4em] tabular-nums text-ink-strong focus:border-brand-400 focus:outline-none';

/**
 * One-time email check before the first withdrawal: we email a code, the
 * player types it here. verifyOtp() starts a session "from the email", and
 * mark_email_verified() only accepts such a session.
 */
export default function VerifyEmailCard({ onVerified }: { onVerified?: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const { user, refreshProfile } = useAuth();
  const email = user?.email ?? '';
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const inFlight = useRef(false);
  // Older browsers have no clipboard reading; typing or long-press paste still works there.
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

  const pasteCode = async () => {
    try {
      const digits = cleanCode(await navigator.clipboard.readText());
      if (digits.length >= 6) {
        setCode(digits);
        setError(null);
      } else {
        setError({ text: t('verify.pasteEmpty') });
      }
    } catch {
      // The player said no to "Allow paste?", or the browser blocked it.
      setError({ text: t('verify.pasteBlocked') });
    }
  };

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const showError = (caught: unknown) => {
    const friendly = friendlyError(caught);
    setError({ text: friendly.message, raw: friendly.key === 'errors.generic' ? rawErrorMessage(caught) : undefined });
  };

  const sendCode = async () => {
    if (!email || inFlight.current || cooldown > 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error: sendError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      if (sendError) throw sendError;
      setCodeSent(true);
      setCode('');
      setCooldown(RESEND_SECONDS);
    } catch (caught) {
      showError(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!email || code.length < 6 || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
      if (verifyError) throw verifyError;
      const { error: markError } = await supabase.rpc('mark_email_verified');
      if (markError) throw markError;
      await refreshProfile();
      toast.show(t('verify.done'), 'success');
      onVerified?.();
    } catch (caught) {
      showError(caught);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="verify-email-title" className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-950 text-brand-300" aria-hidden="true">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 id="verify-email-title" className="text-base font-semibold text-ink-strong">{t('verify.title')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('verify.why')}</p>
        </div>
      </div>

      <p className="rounded-control border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-200">
        {t('verify.oneTime')}
      </p>

      {!codeSent ? (
        <Button
          size="lg"
          fullWidth
          loading={busy}
          disabled={!email}
          icon={<MailCheck className="h-4 w-4" />}
          onClick={() => void sendCode()}
        >
          {t('verify.send')}
        </Button>
      ) : (
        <div className="space-y-3">
          <p className="break-words text-sm text-ink-soft">{interpolate(t('verify.sentTo'), { email })}</p>
          <p className="text-xs text-amber-300">{t('verify.spamHint')}</p>
          <div>
            <label htmlFor="verify-code" className="mb-1.5 block text-sm font-medium text-ink-soft">{t('verify.codeLabel')}</label>
            <div className="flex gap-2">
              <input
                id="verify-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => { setCode(cleanCode(event.target.value)); setError(null); }}
                onKeyDown={(event) => { if (event.key === 'Enter') void verify(); }}
                placeholder="••••••"
                className={`${INPUT} min-w-0 flex-1`}
              />
              {canPaste && (
                <button
                  type="button"
                  onClick={() => void pasteCode()}
                  disabled={busy}
                  className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-control border border-surface-strong bg-surface-raised px-3 text-sm font-semibold text-ink-strong hover:border-brand-400 disabled:opacity-50"
                >
                  <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
                  {t('verify.paste')}
                </button>
              )}
            </div>
          </div>
          <Button size="lg" fullWidth loading={busy} disabled={code.length < 6} onClick={() => void verify()}>
            {t('verify.confirm')}
          </Button>
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={busy || cooldown > 0}
            className="min-h-[44px] w-full text-sm text-brand-300 hover:text-brand-200 disabled:cursor-not-allowed disabled:text-ink-muted"
          >
            {cooldown > 0 ? interpolate(t('verify.resendIn'), { seconds: cooldown }) : t('verify.resend')}
          </button>
        </div>
      )}

      {error && <Alert details={error.raw}>{error.text}</Alert>}
    </section>
  );
}
