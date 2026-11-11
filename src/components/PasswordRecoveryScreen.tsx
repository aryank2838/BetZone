import { useState } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { useAuth } from '@/lib/auth';

export default function PasswordRecoveryScreen() {
  const { clearPasswordRecovery, refreshProfile } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    setError('');
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      const friendly = friendlyErrorDetails(updateError);
      setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      setBusy(false);
      return;
    }
    clearPasswordRecovery();
    await refreshProfile();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-slate-100">
      <section className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-emerald-400" /><h1 className="text-lg font-bold">Set new password</h1></div>
        <p className="text-xs text-slate-400">Choose a password with at least 8 characters.</p>
        <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New password" className="w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm" />
        <input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="Confirm new password" className="w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm" />
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void submit()} className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold disabled:opacity-40">{busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Update password'}</button>
      </section>
    </main>
  );
}
