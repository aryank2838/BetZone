import { useState, type ReactNode } from 'react';
import { BookOpen, ChevronRight, FileText, LogOut, Mail, Shield, ShieldCheck, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import type { NavView } from '@/lib/useNav';
import HelpButton from '@/components/HelpButton';
import LanguageSelector from '@/components/LanguageSelector';
import PageHeader from '@/components/ui/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Alert from '@/components/ui/Alert';
import PasswordInput from '@/components/ui/PasswordInput';
import { useToast } from '@/components/ui/toastContext';
import { useT } from '@/i18n/useT';

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-3 py-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';

function LinkRow({ icon, label, onClick, tone = 'default' }: { icon: ReactNode; label: string; onClick: () => void; tone?: 'default' | 'admin' }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-sm hover:bg-surface-raised/50 ${tone === 'admin' ? 'text-amber-200' : 'text-ink-soft'}`}
      >
        <span className="text-ink-muted" aria-hidden="true">{icon}</span>
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
      </button>
    </li>
  );
}

export default function SettingsPage({ onNavigate }: { onNavigate: (view: NavView) => void }) {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const [name, setName] = useState(profile?.display_name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState<'name' | 'password' | null>(null);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const { t } = useT();
  const toast = useToast();

  const saveName = async () => {
    if (!user || !name.trim() || name.trim().length > 50) { setError({ text: t('settings.nameLength') }); return; }
    setBusy('name');
    setError(null);
    const { error: updateError } = await supabase.from('profiles').update({ display_name: name.trim() }).eq('id', user.id);
    if (updateError) {
      const friendly = friendlyErrorDetails(updateError);
      setError({ text: friendly.message, raw: friendly.raw });
    } else {
      await refreshProfile();
      toast.show(t('settings.nameUpdated'));
    }
    setBusy(null);
  };

  const changePassword = async () => {
    if (!user?.email || !currentPassword) { setError({ text: t('settings.enterCurrent') }); return; }
    if (newPassword.length < 8) { setError({ text: t('auth.errorPassword') }); return; }
    setBusy('password');
    setError(null);
    try {
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
      if (verifyError) throw verifyError;
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setCurrentPassword('');
      setNewPassword('');
      toast.show(t('settings.passwordUpdated'));
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setError({ text: friendly.message, raw: friendly.raw });
    } finally { setBusy(null); }
  };

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={t('account.title')} subtitle={user?.email} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-5">
        {error && <Alert details={error.raw}>{error.text}</Alert>}

        <Card className="space-y-3">
          <SectionTitle>{t('settings.displayName')}</SectionTitle>
          <label className="sr-only" htmlFor="account-name">{t('settings.displayName')}</label>
          <input id="account-name" value={name} maxLength={50} onChange={(event) => setName(event.target.value)} className={INPUT} />
          <Button variant="secondary" loading={busy === 'name'} disabled={busy !== null} onClick={() => void saveName()}>{t('settings.saveName')}</Button>
        </Card>

        <Card className="space-y-3">
          <SectionTitle>{t('settings.password')}</SectionTitle>
          <PasswordInput autoComplete="current-password" aria-label={t('settings.currentPassword')} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder={t('settings.currentPassword')} className={INPUT} />
          <PasswordInput autoComplete="new-password" aria-label={t('settings.newPassword')} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder={t('settings.newPassword')} className={INPUT} />
          <Button variant="secondary" loading={busy === 'password'} disabled={busy !== null} onClick={() => void changePassword()}>{t('settings.password')}</Button>
        </Card>

        <Card className="space-y-3">
          <SectionTitle>{t('settings.preferences')}</SectionTitle>
          <LanguageSelector />
        </Card>

        <section aria-label={t('account.more')} className="overflow-hidden rounded-card border border-surface-border bg-surface/80">
          <ul className="divide-y divide-surface-border">
            <LinkRow icon={<ShieldCheck className="h-4 w-4" />} label={t('settings.playLimits')} onClick={() => onNavigate('limits')} />
            <li><HelpButton variant="row" /></li>
            <LinkRow icon={<BookOpen className="h-4 w-4" />} label={t('dashboard.rules')} onClick={() => onNavigate('rules')} />
            <LinkRow icon={<FileText className="h-4 w-4" />} label={t('dashboard.terms')} onClick={() => onNavigate('terms')} />
            <LinkRow icon={<Lock className="h-4 w-4" />} label={t('dashboard.privacy')} onClick={() => onNavigate('privacy')} />
            <LinkRow icon={<Mail className="h-4 w-4" />} label={t('dashboard.contact')} onClick={() => onNavigate('contact')} />
            {profile?.is_admin && (
              <LinkRow icon={<Shield className="h-4 w-4 text-amber-400" />} label={t('dashboard.adminPanel')} onClick={() => onNavigate('admin')} tone="admin" />
            )}
          </ul>
        </section>

        <Button variant="danger" size="lg" fullWidth icon={<LogOut className="h-4 w-4" />} onClick={() => void signOut()}>
          {t('common.logout')}
        </Button>
      </main>
    </div>
  );
}
