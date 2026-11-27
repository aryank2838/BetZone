import { useEffect, useState } from 'react';
import { CalendarCheck, Copy, Handshake, Share2, TrendingUp, Users, Wallet } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { referralLink } from '@/lib/referral';
import ShareButton from '@/components/ShareButton';
import { UPI_PATTERN, levelRanges, usePartnerDashboard, weekLabel, type PartnerClosedWeek } from '@/lib/partner';
import PageHeader from '@/components/ui/PageHeader';
import { Card, SectionTitle } from '@/components/ui/Card';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { CardSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/ui/toastContext';
import { interpolate, useT } from '@/i18n/useT';
import { useFormat } from '@/i18n/useFormat';

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-3 py-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';

export default function PartnerPage({ onBack }: { onBack: () => void }) {
  const { t, locale } = useT();
  const { formatNumber, formatDate } = useFormat();
  const toast = useToast();
  const { data, loading, error, reload } = usePartnerDashboard();
  const [upi, setUpi] = useState('');
  const [savingUpi, setSavingUpi] = useState(false);
  const [upiError, setUpiError] = useState<string | null>(null);

  useEffect(() => { setUpi(data?.payout_upi ?? ''); }, [data?.payout_upi]);

  // Signed amounts: "−₹500" for a loss.
  const rupees = (value: number) => `${value < 0 ? '−' : ''}₹${formatNumber(Math.abs(value))}`;
  const day = (value: string) => formatDate(value, { day: 'numeric', month: 'short' });

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-surface-page text-ink">
        <PageHeader title={t('partner.title')} onBack={onBack} />
        <main className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-5"><CardSkeleton /><CardSkeleton /></main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-surface-page text-ink">
        <PageHeader title={t('partner.title')} onBack={onBack} />
        <main className="mx-auto max-w-2xl px-4 py-6 sm:px-5">
          {error
            ? <Alert details={error.raw} onRetry={() => void reload()}>{error.message}</Alert>
            : <Alert tone="info">{t('partner.notPartner')}</Alert>}
        </main>
      </div>
    );
  }

  const link = referralLink(data.code);
  const week = data.week;
  const levels = data.uses_levels ? levelRanges(data.levels ?? [], formatNumber) : [];
  const base = Math.max(week.net + week.carry_in, 0);
  const currentLevel = (data.levels ?? []).reduce((found, level, index) => (level.min_profit <= base ? index : found), 0);
  const nextLevel = data.uses_levels && week.next_level_min != null && week.next_level_percent != null
    ? { amount: Math.max(week.next_level_min - base, 1), percent: week.next_level_percent }
    : null;
  const shareText = interpolate(t('partner.shareText'), { link });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.show(t('referral.copied'), 'success');
    } catch {
      toast.show(interpolate(t('referral.copyFailed'), { link }), 'info');
    }
  };

  const saveUpi = async () => {
    const value = upi.trim();
    if (value && !UPI_PATTERN.test(value)) { setUpiError(t('partner.upiInvalid')); return; }
    setSavingUpi(true);
    setUpiError(null);
    try {
      const { error: rpcError } = await supabase.rpc('partner_set_payout_upi', { p_upi: value });
      if (rpcError) throw rpcError;
      toast.show(t('partner.upiSaved'), 'success');
      await reload();
    } catch (caught) {
      setUpiError(friendlyErrorDetails(caught).message);
    } finally {
      setSavingUpi(false);
    }
  };

  const weekStatus = (row: PartnerClosedWeek) => {
    if (row.status === 'paid') {
      return <span className="text-emerald-300">{interpolate(t('partner.statusPaid'), { date: row.paid_at ? day(row.paid_at) : '', utr: row.paid_utr ?? '' })}</span>;
    }
    if (row.status === 'due') return <span className="text-amber-300">{t('partner.statusDue')}</span>;
    return <span className="text-ink-muted">{row.carry_out < 0 ? interpolate(t('partner.statusCarried'), { amount: rupees(row.carry_out) }) : t('partner.statusNothing')}</span>;
  };

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={t('partner.title')} subtitle={interpolate(t(data.uses_levels ? 'partner.subtitleLevels' : 'partner.subtitle'), { percent: data.share_percent })} onBack={onBack} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-5">
        {!data.active && <Alert tone="warning">{t('partner.paused')}</Alert>}
        {error && <Alert details={error.raw} onRetry={() => void reload()}>{error.message}</Alert>}

        {/* This week so far */}
        <section aria-labelledby="partner-week-title" className="rounded-card border border-amber-500/30 bg-gradient-to-br from-amber-950/50 to-surface-raised/60 p-5">
          <p id="partner-week-title" className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {interpolate(t('partner.thisWeek'), { range: weekLabel(week.week_start, week.week_end, locale) })}
          </p>
          <p className="mt-1 text-sm text-ink-soft">{t('partner.yourEarnings')}</p>
          <p className="text-3xl font-bold tracking-tight text-amber-300">{rupees(week.projected_share)}</p>
          <dl className="mt-4 space-y-1.5 border-t border-surface-border pt-4 text-sm">
            <div className="flex justify-between"><dt className="text-ink-muted">{t('partner.bets')}</dt><dd className="tabular-nums">{rupees(week.bets)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">{t('partner.wins')}</dt><dd className="tabular-nums">−{rupees(week.wins)}</dd></div>
            {week.bonuses > 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('partner.bonuses')}</dt><dd className="tabular-nums">−{rupees(week.bonuses)}</dd></div>}
            <div className="flex justify-between font-semibold"><dt>{t('partner.net')}</dt><dd className={`tabular-nums ${week.net < 0 ? 'text-rose-300' : 'text-ink-strong'}`}>{rupees(week.net)}</dd></div>
            {week.carry_in < 0 && <div className="flex justify-between"><dt className="text-ink-muted">{t('partner.carryIn')}</dt><dd className="tabular-nums text-rose-300">{rupees(week.carry_in)}</dd></div>}
            <div className="flex justify-between"><dt className="text-ink-muted">{t('partner.yourShare')}</dt><dd>{data.share_percent}%</dd></div>
          </dl>
          {data.uses_levels && (
            <p className="mt-3 rounded-control bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200">
              {nextLevel
                ? interpolate(t('partner.nextLevel'), { amount: formatNumber(nextLevel.amount), percent: nextLevel.percent })
                : t('partner.topLevel')}
            </p>
          )}
          <p className="mt-3 text-xs text-ink-muted">{t('partner.weekNote')}</p>
        </section>

        {/* Levels */}
        {levels.length > 0 && (
          <Card className="space-y-3">
            <SectionTitle icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}>{t('partner.levelsTitle')}</SectionTitle>
            <p className="text-sm text-ink-soft">{t('partner.levelsHint')}</p>
            <ul className="divide-y divide-surface-border rounded-control border border-surface-border">
              {levels.map((level, index) => {
                const current = index === currentLevel;
                return (
                  <li key={level.label} className={`flex items-center justify-between px-3 py-2 text-sm ${current ? 'bg-amber-500/10 font-semibold text-amber-200' : 'text-ink-soft'}`}>
                    <span>{interpolate(t('partner.levelRow'), { range: level.label })}</span>
                    <span className="tabular-nums">{level.percent}%</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {/* Invite link */}
        <Card className="space-y-3">
          <SectionTitle icon={<Share2 className="h-4 w-4" aria-hidden="true" />}>{t('partner.inviteTitle')}</SectionTitle>
          <p className="text-sm text-ink-soft">{t('partner.inviteHint')}</p>
          <div className="flex items-center justify-between gap-3 rounded-control border border-surface-strong bg-surface-page/60 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-ink-muted">{t('referral.yourCode')}</p>
              <p className="text-lg font-bold tracking-[0.3em] text-amber-300">{data.code}</p>
            </div>
            <button
              type="button"
              onClick={() => void copyLink()}
              className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-control border border-surface-strong px-3 text-sm font-semibold text-ink-strong hover:border-amber-400"
            >
              <Copy className="h-4 w-4" aria-hidden="true" /> {t('referral.copyLink')}
            </button>
          </div>
          <ShareButton
            text={shareText}
            label={t('referral.share')}
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-control bg-amber-400 px-4 text-sm font-bold text-slate-950 hover:brightness-110"
          />
        </Card>

        {/* Payout UPI */}
        <Card className="space-y-3">
          <SectionTitle icon={<Wallet className="h-4 w-4" aria-hidden="true" />}>{t('partner.upiTitle')}</SectionTitle>
          <p className="text-sm text-ink-soft">{t('partner.upiHint')}</p>
          <label className="sr-only" htmlFor="partner-upi">{t('partner.upiTitle')}</label>
          <input
            id="partner-upi"
            value={upi}
            autoComplete="off"
            autoCapitalize="none"
            placeholder={interpolate(t('common.example'), { value: 'name@okaxis' })}
            onChange={(event) => { setUpi(event.target.value); setUpiError(null); }}
            className={INPUT}
          />
          {upiError && <p className="text-sm text-rose-300">{upiError}</p>}
          <Button variant="secondary" loading={savingUpi} disabled={savingUpi || upi.trim() === (data.payout_upi ?? '')} onClick={() => void saveUpi()}>
            {t('partner.upiSave')}
          </Button>
        </Card>

        {/* Players */}
        <section aria-labelledby="partner-players-title">
          <SectionTitle id="partner-players-title" icon={<Users className="h-4 w-4" aria-hidden="true" />}>
            {interpolate(t('partner.players'), { count: formatNumber(data.player_count) })}
          </SectionTitle>
          {data.players.length === 0 ? (
            <p className="rounded-card border border-dashed border-surface-strong px-4 py-6 text-center text-sm text-ink-muted">{t('partner.noPlayers')}</p>
          ) : (
            <ul className="divide-y divide-surface-border rounded-card border border-surface-border bg-surface/80">
              {data.players.map((player, index) => (
                <li key={`${player.name}-${player.joined_at}-${index}`} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink-strong">{player.name}</p>
                    <p className="text-xs text-ink-muted">
                      {interpolate(t('partner.joined'), { date: day(player.joined_at) })}
                      {player.last_active && <> · {interpolate(t('partner.lastActive'), { date: day(player.last_active) })}</>}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <p className="tabular-nums text-ink-soft">{interpolate(t('partner.playerBets'), { amount: rupees(player.bets) })}</p>
                    <p className={`text-xs tabular-nums ${player.net < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{interpolate(t('partner.playerNet'), { amount: rupees(player.net) })}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Past weeks */}
        <section aria-labelledby="partner-weeks-title">
          <SectionTitle id="partner-weeks-title" icon={<CalendarCheck className="h-4 w-4" aria-hidden="true" />}>{t('partner.pastWeeks')}</SectionTitle>
          {data.weeks.length === 0 ? (
            <p className="rounded-card border border-dashed border-surface-strong px-4 py-6 text-center text-sm text-ink-muted">{t('partner.noWeeks')}</p>
          ) : (
            <ul className="divide-y divide-surface-border rounded-card border border-surface-border bg-surface/80">
              {data.weeks.map((row) => (
                <li key={row.week_start} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-ink-strong">{weekLabel(row.week_start, row.week_end, locale)}</span>
                    <span className="font-bold tabular-nums text-amber-300">{rupees(row.share)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-3 text-xs">
                    <span className="text-ink-muted">{interpolate(t('partner.weekNet'), { amount: rupees(row.net) })}</span>
                    {weekStatus(row)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="flex items-start gap-2 px-1 text-xs text-ink-muted">
          <Handshake className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {t('partner.howItWorks')}
        </p>
      </main>
    </div>
  );
}
