import { Download, Share, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useInstallPrompt } from '@/lib/installPrompt';

/** "Add to home screen" prompt; hidden once installed or dismissed. */
export default function InstallBanner() {
  const { t } = useT();
  const { mode, install, dismiss } = useInstallPrompt();
  if (!mode) return null;
  return (
    <section aria-labelledby="install-title" className="flex items-start gap-3 rounded-card border border-accent-800/60 bg-accent-950/30 p-4">
      <img src="/icon-192.png" alt="" className="h-11 w-11 shrink-0 rounded-control" />
      <div className="min-w-0 flex-1">
        <h2 id="install-title" className="font-semibold text-ink-strong">{t('install.title')}</h2>
        <p className="mt-0.5 text-sm text-ink-soft">
          {mode === 'ios' ? (
            <><Share className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden="true" />{t('install.iosBody')}</>
          ) : t('install.body')}
        </p>
        {mode === 'prompt' && (
          <Button className="mt-3" icon={<Download className="h-4 w-4" aria-hidden="true" />} onClick={() => { void install(); }}>
            {t('install.button')}
          </Button>
        )}
      </div>
      <button type="button" onClick={dismiss} aria-label={t('install.dismiss')} className="tap-target -mr-2 -mt-2 rounded-lg text-ink-muted hover:text-ink-strong">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
