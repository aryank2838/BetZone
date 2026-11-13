import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { activePlayRestriction, formatLimitEnd, useMyLimits } from '@/lib/useMyLimits';
import { friendlyErrorDetails } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import HelpButton from '@/components/HelpButton';
import PlayLimitsSummary from '@/components/PlayLimitsSummary';
import { useDialogA11y } from '@/lib/useDialogA11y';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CardSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/ui/toastContext';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

export default function PlayLimitsPage({ onBack }: { onBack: () => void }) {
  const { refreshProfile } = useAuth();
  const { limits, error, refresh } = useMyLimits();
  const { t } = useT();
  const { formatNumber } = useFormat();
  const toast = useToast();
  const [deposit, setDeposit] = useState('');
  const [loss, setLoss] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; raw?: string } | null>(null);
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  useDialogA11y(confirmation !== null, confirmationRef, closeConfirmation);
  const initialized = useRef(false);

  useEffect(() => {
    if (!limits || initialized.current) return;
    const scheduled = !!limits.pending_effective_at;
    const depositValue = scheduled ? limits.pending_deposit_limit : limits.daily_deposit_limit;
    const lossValue = scheduled ? limits.pending_loss_limit : limits.daily_loss_limit;
    setDeposit(depositValue === null ? '' : String(depositValue));
    setLoss(lossValue === null ? '' : String(lossValue));
    initialized.current = true;
  }, [limits]);

  const saveLimits = async () => {
    const validValue = (value: string) => value === '' || (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
    if (!validValue(deposit) || !validValue(loss)) {
      setNotice({ message: t('limits.invalid') });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { error: rpcError } = await supabase.rpc('set_my_limits', {
        p_daily_deposit: deposit === '' ? null : Number(deposit),
        p_daily_loss: loss === '' ? null : Number(loss),
      });
      if (rpcError) throw rpcError;
      await refresh();
      toast.show(t('limits.saved'));
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setNotice({ message: friendly.message, raw: friendly.raw });
    } finally {
      setBusy(false);
    }
  };

  const startRestriction = async (kind: 'cooldown' | 'self_exclusion', duration: number) => {
    setBusy(true);
    setNotice(null);
    try {
      const { error: rpcError } = await supabase.rpc(kind === 'cooldown' ? 'start_cooldown' : 'self_exclude',
        kind === 'cooldown' ? { p_hours: duration } : { p_days: duration });
      if (rpcError) throw rpcError;
      await refresh();
      await refreshProfile();
      setConfirmation(null);
      toast.show(kind === 'cooldown' ? t('limits.breakStarted') : t('limits.exclusionStarted'));
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setNotice({ message: friendly.message, raw: friendly.raw });
    } finally {
      setBusy(false);
    }
  };

  const restriction = activePlayRestriction(limits);
  const durationLabel = (hours: number) => hours < 24
    ? interpolate(t(hours === 1 ? 'limits.hour' : 'limits.hours'), { count: hours })
    : interpolate(t(hours === 24 ? 'limits.day' : 'limits.days'), { count: hours / 24 });
  const currentLabel = (value: number | null) => value === null ? t('limits.noLimit') : `₹${formatNumber(value)}`;

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={t('settings.playLimits')} subtitle={t('limits.subtitle')} onBack={onBack} actions={<HelpButton />} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-5">
        {error && <Alert details={error.raw} onRetry={() => void refresh()}>{error.message}</Alert>}
        {restriction && (
          <Alert tone="warning">
            {interpolate(t(restriction.kind === 'cooldown' ? 'restriction.cooldown' : 'restriction.selfExclusion'), { date: formatLimitEnd(restriction.until) })}
          </Alert>
        )}
        {notice && <Alert details={notice.raw}>{notice.message}</Alert>}
        {limits ? (
          <>
            {(limits.daily_deposit_limit !== null || limits.daily_loss_limit !== null) && (
              <PlayLimitsSummary limits={limits} onOpen={() => document.getElementById('daily-limits')?.scrollIntoView({ behavior: 'smooth' })} />
            )}
            <Card className="space-y-4" id="daily-limits">
              <h2 className="font-semibold text-ink-strong">{t('limits.dailyTitle')}</h2>
              <p className="text-sm text-ink-muted">{t('limits.dailyHelp')}</p>
              <LimitInput label={t('limits.depositInput')} value={deposit} current={currentLabel(limits.daily_deposit_limit)} setValue={setDeposit} />
              <LimitInput label={t('limits.lossInput')} value={loss} current={currentLabel(limits.daily_loss_limit)} setValue={setLoss} />
              {limits.pending_effective_at && (
                <Alert tone="info">
                  {interpolate(t('limits.scheduled'), {
                    date: formatLimitEnd(limits.pending_effective_at),
                    deposit: currentLabel(limits.pending_deposit_limit),
                    loss: currentLabel(limits.pending_loss_limit),
                  })}
                </Alert>
              )}
              <Button size="lg" fullWidth loading={busy} onClick={() => void saveLimits()}>{t('limits.save')}</Button>
            </Card>
            <Card className="space-y-4">
              <h2 className="font-semibold text-ink-strong">{t('limits.breakTitle')}</h2>
              <p className="text-sm text-ink-muted">{t('limits.breakHelp')}</p>
              <div className="grid grid-cols-2 gap-2">
                {[1, 6, 24, 72].map((hours) => (
                  <Button key={hours} variant="secondary" disabled={busy} onClick={() => void startRestriction('cooldown', hours)}>
                    {durationLabel(hours)}
                  </Button>
                ))}
              </div>
            </Card>
            <section className="space-y-4 rounded-card border border-rose-900/70 bg-rose-950/20 p-5">
              <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-rose-400" aria-hidden="true" /><h2 className="font-semibold text-ink-strong">{t('limits.exclusionTitle')}</h2></div>
              <p className="text-sm text-ink-soft">{t('limits.exclusionHelp')}</p>
              <div className="grid grid-cols-2 gap-2">
                {[7, 30, 90, 180].map((days) => (
                  <Button key={days} variant="danger" disabled={busy} onClick={() => setConfirmation(days)}>
                    {interpolate(t('limits.days'), { count: days })}
                  </Button>
                ))}
              </div>
            </section>
          </>
        ) : !error ? <CardSkeleton /> : null}
      </main>
      {confirmation !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5">
          <div ref={confirmationRef} role="dialog" aria-modal="true" aria-labelledby="exclusion-title" className="w-full max-w-sm space-y-4 rounded-card border border-rose-900 bg-surface p-5">
            <h2 id="exclusion-title" className="font-semibold text-ink-strong">{interpolate(t('limits.confirmTitle'), { count: confirmation })}</h2>
            <p className="text-sm text-ink-soft">{t('limits.confirmBody')} <strong>{t('limits.confirmStrong')}</strong></p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => setConfirmation(null)}>{t('limits.goBack')}</Button>
              <Button variant="danger" loading={busy} onClick={() => void startRestriction('self_exclusion', confirmation)}>{t('limits.confirm')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LimitInput({ label, value, current, setValue }: {
  label: string;
  value: string;
  current: string;
  setValue: (value: string) => void;
}) {
  const { t } = useT();
  return (
    <label className="block text-sm text-ink-soft">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className="text-xs text-ink-muted">{interpolate(t('limits.current'), { value: current })}</span>
      </span>
      <span className="relative mt-1.5 block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden="true">₹</span>
        <input type="text" inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} placeholder={t('limits.noLimit')} className="w-full rounded-control border border-surface-strong bg-surface-raised py-3 pl-7 pr-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none" />
      </span>
    </label>
  );
}
