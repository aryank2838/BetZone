import { useState } from 'react';
import { Bell, BellOff, BellRing, ChevronDown, ChevronUp, Loader2, Send, Smartphone, Volume2, VolumeX } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useToast } from '@/components/ui/toastContext';
import { useAdminAlerts } from '@/lib/adminAlertsContext';
import { friendlyError } from '@/lib/errors';
import { useT } from '@/i18n/useT';

/**
 * Admin phone alerts. `card` (Home) shows the full controls; `banner`
 * (Requests tab) only appears while phone alerts are off and can be turned on.
 */
export default function AdminPushSetup({ variant = 'card' }: { variant?: 'card' | 'banner' }) {
  const { t } = useT();
  const toast = useToast();
  const alerts = useAdminAlerts();
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (!alerts) return null;
  const { push, pushBusy, enablePush, disablePush, sendTestPush, notifications, enableNotifications, soundEnabled, setSoundEnabled } = alerts;

  const sendTest = async (quiet = false) => {
    setTesting(true);
    try {
      await sendTestPush();
      if (!quiet) toast.show(t('admin.pushTestSent'), 'success');
    } catch (error) {
      if (!quiet) toast.show(friendlyError(error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const turnOn = async () => {
    try {
      const next = await enablePush();
      if (next === 'on') {
        toast.show(t('admin.pushEnabled'), 'success');
        // Prove it works straight away.
        await sendTest(true);
      } else if (next === 'blocked') {
        toast.show(t('admin.pushBlocked'), 'error');
      }
    } catch {
      toast.show(t('push.failed'), 'error');
    }
  };

  const turnOff = async () => {
    try {
      await disablePush();
      toast.show(t('push.disabled'));
    } catch {
      toast.show(t('errors.retry'), 'error');
    }
  };

  if (variant === 'banner') {
    if (push !== 'off') return null;
    return (
      <div role="status" className="flex flex-col gap-3 rounded-card border border-amber-700/70 bg-amber-950/40 px-4 py-3 sm:flex-row sm:items-center">
        <BellRing className="hidden h-5 w-5 shrink-0 text-amber-300 sm:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-100">{t('admin.pushBannerTitle')}</p>
          <p className="text-sm text-amber-100/80">{t('admin.pushOffBody')}</p>
        </div>
        <Button variant="admin" className="shrink-0" loading={pushBusy} disabled={pushBusy} icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => void turnOn()}>
          {t('admin.pushTurnOn')}
        </Button>
      </div>
    );
  }

  const on = push === 'on';
  const iconButton = 'grid h-9 w-9 shrink-0 place-items-center rounded-full border border-surface-strong text-ink-soft hover:bg-surface-raised disabled:opacity-50';
  const soundToggle = (
    <button
      type="button"
      aria-pressed={soundEnabled}
      aria-label={soundEnabled ? t('admin.soundOn') : t('admin.soundOff')}
      title={soundEnabled ? t('admin.soundOn') : t('admin.soundOff')}
      onClick={() => setSoundEnabled(!soundEnabled)}
      className={iconButton}
    >
      {soundEnabled ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <VolumeX className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
  const note = push === 'blocked' ? t('admin.pushBlocked')
    : push === 'ios-install' ? t('push.iosInstall')
      : push === 'unsupported' ? t('admin.pushTabOnly')
        : null;

  // One compact row; details and "Turn off" sit behind the chevron.
  return (
    <div className="rounded-control border border-surface-border bg-surface-page/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <Smartphone className={`h-4 w-4 shrink-0 ${on ? 'text-brand-400' : 'text-amber-400'}`} aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-strong">
          {t('admin.pushTitle')}
          {push !== 'loading' && (
            <span className={`ml-1.5 font-medium ${on ? 'text-brand-300' : 'text-amber-300'}`}>
              · {on ? t('admin.pushOn') : t('admin.pushOff')}
            </span>
          )}
        </p>

        {on && (
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing}
            aria-label={t('admin.pushTest')}
            title={t('admin.pushTest')}
            className={iconButton}
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          </button>
        )}
        {push === 'off' && (
          <Button variant="admin" loading={pushBusy} disabled={pushBusy} icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => void turnOn()}>
            {t('admin.pushTurnOnShort')}
          </Button>
        )}
        {push === 'unsupported' && notifications === 'default' && (
          <Button variant="secondary" icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => { void enableNotifications(); }}>
            {t('admin.pushTurnOnShort')}
          </Button>
        )}
        {soundToggle}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={t('admin.pushDetails')}
          className="grid h-9 w-7 shrink-0 place-items-center text-ink-muted hover:text-ink-soft"
        >
          {expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {note && !expanded && <p className="truncate px-3 pb-2 text-xs text-amber-200/90">{note}</p>}

      {expanded && (
        <div className="space-y-2 border-t border-surface-border px-3 py-2.5">
          <p className="text-xs text-ink-muted">{on ? t('admin.pushOnBody') : t('admin.pushOffBody')}</p>
          {note && <p className="text-xs text-amber-200">{note}</p>}
          {on && (
            <Button variant="ghost" loading={pushBusy} disabled={pushBusy} icon={<BellOff className="h-4 w-4" aria-hidden="true" />} onClick={() => void turnOff()}>
              {t('push.turnOff')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
