import { useState } from 'react';
import { Bell, BellOff, BellRing, Send, Smartphone, Volume2, VolumeX } from 'lucide-react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
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
  return (
    <div className="space-y-3 rounded-control border border-surface-border bg-surface-page/50 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-strong">
          <Smartphone className="h-4 w-4 text-amber-400" aria-hidden="true" />
          {t('admin.pushTitle')}
        </p>
        {push !== 'loading' && (
          <Badge tone={on ? 'success' : 'warning'} icon={on ? <BellRing className="h-3.5 w-3.5" aria-hidden="true" /> : <BellOff className="h-3.5 w-3.5" aria-hidden="true" />}>
            {on ? t('admin.pushOn') : t('admin.pushOff')}
          </Badge>
        )}
      </div>

      {on && (
        <>
          <p className="text-sm text-ink-muted">{t('admin.pushOnBody')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={testing} disabled={testing} icon={<Send className="h-4 w-4" aria-hidden="true" />} onClick={() => void sendTest()}>
              {t('admin.pushTest')}
            </Button>
            <Button variant="ghost" loading={pushBusy} disabled={pushBusy} onClick={() => void turnOff()}>
              {t('push.turnOff')}
            </Button>
          </div>
        </>
      )}

      {push === 'off' && (
        <>
          <p className="text-sm text-ink-muted">{t('admin.pushOffBody')}</p>
          <Button variant="admin" fullWidth loading={pushBusy} disabled={pushBusy} icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => void turnOn()}>
            {t('admin.pushTurnOn')}
          </Button>
        </>
      )}

      {push === 'blocked' && <p className="text-sm text-amber-200">{t('admin.pushBlocked')}</p>}
      {push === 'ios-install' && <p className="text-sm text-amber-200">{t('push.iosInstall')}</p>}
      {push === 'unsupported' && (
        <div className="space-y-2">
          <p className="text-sm text-amber-200">{t('admin.pushTabOnly')}</p>
          {notifications === 'default' && (
            <Button variant="secondary" icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => { void enableNotifications(); }}>
              {t('admin.notificationsOn')}
            </Button>
          )}
          {notifications === 'granted' && (
            <Badge tone="success" icon={<Bell className="h-3.5 w-3.5" aria-hidden="true" />}>{t('admin.notificationsActive')}</Badge>
          )}
        </div>
      )}

      <Button
        variant="ghost"
        aria-pressed={soundEnabled}
        icon={soundEnabled ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : <VolumeX className="h-4 w-4" aria-hidden="true" />}
        onClick={() => setSoundEnabled(!soundEnabled)}
      >
        {soundEnabled ? t('admin.soundOn') : t('admin.soundOff')}
      </Button>
    </div>
  );
}
