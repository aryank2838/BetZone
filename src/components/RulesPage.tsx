import { useEffect, useState } from 'react';
import { BET_TYPES, GAME_LABELS, type BetType } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { formatClockTime } from '@/lib/countdown';
import HelpButton from '@/components/HelpButton';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

interface PublicRulesView {
  minimum_withdrawal: number;
  maximum_withdrawal: number;
  approved_deposit_minimum: number;
  turnover_multiplier: number;
  maximum_bet: number;
  maximum_submit: number;
}

export default function RulesPage({ onBack }: { onBack: () => void }) {
  const { statuses, error, errorDetails, refresh } = useGameStatus();
  const { t } = useT();
  const { formatNumber } = useFormat();
  const [rules, setRules] = useState<PublicRulesView | null>(null);
  const [rulesError, setRulesError] = useState<{ message: string; raw?: string } | null>(null);
  const rupees = (value: number) => `₹${formatNumber(value)}`;

  useEffect(() => {
    void supabase.rpc('get_public_rules').then(({ data, error: rpcError }) => {
      if (rpcError) {
        const friendly = friendlyErrorDetails(rpcError);
        setRulesError({ message: friendly.message, raw: friendly.raw });
      } else setRules(data as PublicRulesView);
    });
  }, []);

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={t('dashboard.rules')} subtitle={t('rules.subtitle')} onBack={onBack} actions={<HelpButton />} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-5">
        {rulesError && <Alert details={rulesError.raw}>{rulesError.message}</Alert>}
        <Card className="space-y-3">
          <h2 className="font-semibold text-ink-strong">{t('rules.betTypes')}</h2>
          {rules && (
            <p className="text-sm text-ink-muted">
              {interpolate(t('rules.betLimits'), { perBet: rupees(rules.maximum_bet), perSubmit: rupees(rules.maximum_submit) })}
            </p>
          )}
          {(Object.keys(BET_TYPES) as BetType[]).map((type) => {
            const info = BET_TYPES[type];
            const example = info.inputType === 'digit' ? '7' : info.inputType === 'jodi' ? '42' : '123-6';
            return (
              <div key={type} className="border-t border-surface-border pt-3">
                <p className="text-sm font-semibold text-ink-strong">{t(`bet.name.${type}` as TranslationKey)} · {info.multiplier}×</p>
                <p className="mt-0.5 text-sm text-ink-muted">
                  {t(`bet.desc.${type}` as TranslationKey)}{' '}
                  {interpolate(t('rules.example'), { example, win: rupees(10 * info.multiplier) })}
                </p>
              </div>
            );
          })}
        </Card>
        <Card className="space-y-3">
          <h2 className="font-semibold text-ink-strong">{t('rules.schedules')}</h2>
          {error && <Alert details={errorDetails} onRetry={() => void refresh()}>{error}</Alert>}
          {statuses.map((status) => (
            <div key={status.game} className="border-t border-surface-border pt-3 text-sm">
              <p className="font-semibold text-ink-strong">{status.label || GAME_LABELS[status.game]}</p>
              <p className="mt-0.5 text-ink-muted">
                {interpolate(t('rules.schedule'), {
                  opens: formatClockTime(status.bets_open_at),
                  openClose: formatClockTime(status.open_bets_close_at),
                  closeClose: formatClockTime(status.close_bets_close_at),
                })}
              </p>
            </div>
          ))}
        </Card>
        <Card className="space-y-3 text-sm text-ink-soft">
          <h2 className="font-semibold text-ink-strong">{t('rules.moneyTitle')}</h2>
          <p>{t('rules.results')}</p>
          <p>{t('rules.balanceOrder')}</p>
          {rules && (
            <p>
              {interpolate(t('rules.withdrawals'), {
                deposit: rupees(rules.approved_deposit_minimum),
                min: rupees(rules.minimum_withdrawal),
                max: rupees(rules.maximum_withdrawal),
              })}
            </p>
          )}
          <p>{t('rules.disputes')}</p>
        </Card>
      </main>
    </div>
  );
}
