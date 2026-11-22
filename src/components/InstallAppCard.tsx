import { Download, MoreVertical, Share, Smartphone } from 'lucide-react';
import Button from '@/components/ui/Button';
import { buttonClasses } from '@/components/ui/buttonClasses';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/toastContext';
import { useT } from '@/i18n/useT';
import { ANDROID_APK_PATH, useAndroidApk, useInstallOptions } from '@/lib/installPrompt';

/**
 * "Get the app" on the Account page. Unlike the Home banner it cannot be
 * dismissed, so players who closed the banner can still install. Hidden
 * inside the installed app.
 *
 * On Android, when the APK is on the server, the main action is downloading
 * the Android app; installing from the browser stays as a second option.
 */
export default function InstallAppCard() {
  const { t } = useT();
  const toast = useToast();
  const { mode, install } = useInstallOptions();
  const apk = useAndroidApk();
  if (mode === 'installed') return null;

  const onInstall = async () => {
    if (await install() === 'accepted') toast.show(t('install.done'), 'success');
  };

  if (apk) {
    return (
      <Card className="flex items-start gap-3 border-accent-800/60 bg-accent-950/30 p-4">
        <img src="/icon-192.png" alt="" className="h-11 w-11 shrink-0 rounded-control" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink-strong">{t('install.androidTitle')}</h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            {mode === 'in-app' ? t('install.androidInApp') : t('install.androidBody')}
          </p>
          {mode !== 'in-app' && (
            <>
              <a
                href={ANDROID_APK_PATH}
                download="BetZone.apk"
                className={buttonClasses({ variant: 'primary', size: 'md', fullWidth: false, className: 'mt-3' })}
              >
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                {t('install.androidButton')}
              </a>
              <p className="mt-2 text-xs text-ink-muted">{t('install.androidSteps')}</p>
            </>
          )}
          {mode === 'prompt' && (
            <button
              type="button"
              onClick={() => { void onInstall(); }}
              className="mt-2 text-xs font-semibold text-brand-300 underline-offset-2 hover:underline"
            >
              {t('install.androidOrBrowser')}
            </button>
          )}
        </div>
      </Card>
    );
  }

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
