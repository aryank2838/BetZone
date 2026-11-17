import { Bell, BellOff, BellRing } from 'lucide-react';
import { usePushNotifications } from '@/lib/push';
import { Card, SectionTitle } from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { useToast } from '@/components/ui/toastContext';
import { useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

/** Account page: turn this device's notifications on or off. */
export function PushNotificationsCard() {
  const { t, language } = useT();
  const toast = useToast();
  const { state, busy, enable, disable } = usePushNotifications(language);

  if (state === 'loading') return null;

  const turnOn = async () => {
    try {
      const next = await enable();
      if (next === 'on') toast.show(t('push.enabled'), 'success');
    } catch {
      toast.show(t('push.failed'), 'error');
    }
  };
  const turnOff = async () => {
    try {
      await disable();
      toast.show(t('push.disabled'));
    } catch {
      toast.show(t('errors.retry'), 'error');
    }
  };

  const note: Partial<Record<typeof state, TranslationKey>> = {
    unsupported: 'push.unsupported',
    'ios-install': 'push.iosInstall',
    blocked: 'push.blocked',
  };
  const noteKey = note[state];

  return (
    <Card className="space-y-3">
      <SectionTitle>{t('push.title')}</SectionTitle>
      <p className="text-sm text-ink-muted">{t('push.body')}</p>
      {state === 'on' && (
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <BellRing className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('push.on')}
          </p>
          <Button variant="secondary" loading={busy} disabled={busy} icon={<BellOff className="h-4 w-4" aria-hidden="true" />} onClick={() => void turnOff()}>
            {t('push.turnOff')}
          </Button>
        </div>
      )}
      {state === 'off' && (
        <Button loading={busy} disabled={busy} icon={<Bell className="h-4 w-4" aria-hidden="true" />} onClick={() => void turnOn()}>
          {t('push.turnOn')}
        </Button>
      )}
      {noteKey && <p className="text-sm text-amber-200">{t(noteKey)}</p>}
    </Card>
  );
}

/**
 * Short offer shown right after a deposit or withdrawal request, when the
 * player is most likely to want it. Hidden if notifications are already on
 * or cannot be turned on from here.
 */
export function PushPrompt({ context }: { context: 'deposit' | 'withdraw' }) {
  const { t, language } = useT();
  const toast = useToast();
  const { state, busy, enable } = usePushNotifications(language);

  if (state !== 'off') return null;

  const turnOn = async () => {
    try {
      const next = await enable();
      if (next === 'on') toast.show(t('push.enabled'), 'success');
    } catch {
      toast.show(t('push.failed'), 'error');
    }
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-card border border-cyan-900 bg-cyan-950/40 px-4 py-3">
      <Bell className="h-4 w-4 shrink-0 text-cyan-300" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-cyan-100">
        {t(context === 'deposit' ? 'push.promptDeposit' : 'push.promptWithdraw')}
      </p>
      <Button variant="secondary" loading={busy} disabled={busy} onClick={() => void turnOn()}>
        {t('push.turnOn')}
      </Button>
    </div>
  );
}
