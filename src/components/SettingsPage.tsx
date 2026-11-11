import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import HelpButton from '@/components/HelpButton';
import LanguageSelector from '@/components/LanguageSelector';
import { useT } from '@/i18n/useT';

export default function SettingsPage({ onBack, onPlayLimits }: { onBack: () => void; onPlayLimits: () => void }) {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const [name, setName] = useState(profile?.display_name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; okay?: boolean } | null>(null);
  const { t } = useT();

  const saveName = async () => {
    if (!user || !name.trim() || name.trim().length > 50) { setNotice({ text: 'Name must be between 1 and 50 characters.' }); return; }
    setBusy(true);
    const { error } = await supabase.from('profiles').update({ display_name: name.trim() }).eq('id', user.id);
    if (error) {
      const friendly = friendlyErrorDetails(error);
      setNotice({ text: friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message });
    } else {
      await refreshProfile();
      setNotice({ text: t('settings.nameUpdated'), okay: true });
    }
    setBusy(false);
  };

  const changePassword = async () => {
    if (!user?.email || !currentPassword) { setNotice({ text: 'Enter your current password.' }); return; }
    if (newPassword.length < 8) { setNotice({ text: 'New password must be at least 8 characters.' }); return; }
    setBusy(true);
    setNotice(null);
    try {
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
      if (verifyError) throw verifyError;
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setCurrentPassword('');
      setNewPassword('');
      setNotice({ text: t('settings.passwordUpdated'), okay: true });
    } catch (error) {
      const friendly = friendlyErrorDetails(error);
      setNotice({ text: friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message });
    } finally { setBusy(false); }
  };

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100">
      <div className="mx-auto max-w-xl space-y-5">
        <div className="flex items-center justify-between"><button type="button" onClick={onBack} className="flex items-center gap-2 text-sm text-slate-400"><ArrowLeft className="h-4 w-4" /> {t('common.back')}</button><HelpButton /></div>
        <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">{t('settings.displayName')}</h2>
          <input value={name} maxLength={50} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm" />
          <button type="button" disabled={busy} onClick={() => void saveName()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium disabled:opacity-40">{t('settings.saveName')}</button>
        </section>
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">{t('settings.password')}</h2>
          <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder={t('settings.currentPassword')} className="w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm" />
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={t('settings.newPassword')} className="w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm" />
          <button type="button" disabled={busy} onClick={() => void changePassword()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('settings.password')}</button>
        </section>
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">{t('settings.preferences')}</h2>
          <LanguageSelector />
          <button type="button" onClick={onPlayLimits} className="w-full rounded-lg border border-slate-700 py-2.5 text-sm text-slate-200">{t('settings.playLimits')}</button>
        </section>
        {notice && <p role="status" className={notice.okay ? 'text-sm text-emerald-300' : 'text-sm text-rose-300'}>{notice.text}</p>}
        <button type="button" onClick={() => void signOut()} className="w-full rounded-lg border border-rose-900 py-3 text-sm text-rose-300">Log out</button>
      </div>
    </main>
  );
}
