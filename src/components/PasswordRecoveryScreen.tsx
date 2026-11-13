import { useState, type FormEvent } from 'react';
import { LockKeyhole } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { useAuth } from '@/lib/auth';
import { useT } from '@/i18n/useT';
import PasswordInput from '@/components/ui/PasswordInput';
import Button from '@/components/ui/Button';
import Alert from '@/components/ui/Alert';

const INPUT = 'min-h-tap w-full rounded-control border border-surface-strong bg-surface-raised px-4 text-base text-ink-strong focus:border-brand-400 focus:outline-none';

export default function PasswordRecoveryScreen() {
  const { clearPasswordRecovery, refreshProfile } = useAuth();
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; raw?: string } | null>(null);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (password.length < 8) { setError({ message: t('recovery.tooShort') }); return; }
    if (password !== confirm) { setError({ message: t('recovery.mismatch') }); return; }
    setBusy(true);
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      const friendly = friendlyErrorDetails(updateError);
      setError({ message: friendly.message, raw: friendly.raw });
      setBusy(false);
      return;
    }
    clearPasswordRecovery();
    await refreshProfile();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-page px-4 text-ink">
      <form onSubmit={(event) => { void submit(event); }} className="w-full max-w-sm space-y-4 rounded-card border border-surface-border bg-surface p-6">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-5 w-5 text-brand-400" aria-hidden="true" />
          <h1 className="text-lg font-bold text-ink-strong">{t('recovery.title')}</h1>
        </div>
        <p className="text-sm text-ink-muted">{t('recovery.hint')}</p>
        <label className="block text-sm text-ink-soft">
          {t('recovery.newPassword')}
          <div className="mt-1">
            <PasswordInput autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={INPUT} />
          </div>
        </label>
        <label className="block text-sm text-ink-soft">
          {t('recovery.confirmPassword')}
          <div className="mt-1">
            <PasswordInput autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} className={INPUT} />
          </div>
        </label>
        {error && <Alert details={error.raw}>{error.message}</Alert>}
        <Button type="submit" size="lg" fullWidth loading={busy}>{t('recovery.submit')}</Button>
      </form>
    </main>
  );
}
