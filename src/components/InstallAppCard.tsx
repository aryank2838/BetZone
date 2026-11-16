import { Download, MoreVertical, Share } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/toastContext';
import { useT } from '@/i18n/useT';
import { useInstallOptions } from '@/lib/installPrompt';

/**
 * "Get the app" on the Account page. Unlike the Home banner it cannot be
 * dismissed, so players who closed the banner can still install. Hidden
 * inside the installed app.
 */
export default function InstallAppCard() {
  const { t } = useT();
  const toast = useToast();
  const { mode, install } = useInstallOptions();
  if (mode === 'installed') return null;

  const onInstall = async () => {
    if (await install() === 'accepted') toast.show(t('install.done'), 'success');
  };

  return (
    <Card className="flex items-start gap-3 border-accent-800/60 bg-accent-950/30 p-4">
      <img src="/icon-192.png" alt="" className="h-11 w-11 shrink-0 rounded-control" />
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold text-ink-strong">{t('install.accountTitle')}</h2>
        <p className="mt-0.5 text-sm text-ink-soft">
          {mode === 'prompt' && t('install.body')}
          {mode === 'ios' && (
            <><Share className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden="true" />{t('install.iosBody')}</>
          )}
          {mode === 'in-app' && t('install.inAppBody')}
          {mode === 'manual' && (
            <><MoreVertical className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden="true" />{t('install.manualBody')}</>
          )}
        </p>
        {mode === 'prompt' && (
          <Button className="mt-3" icon={<Download className="h-4 w-4" aria-hidden="true" />} onClick={() => { void onInstall(); }}>
            {t('install.button')}
          </Button>
        )}
      </div>
    </Card>
  );
}
