import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { History, Plus, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { useUserRequests } from '@/lib/useUserRequests';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import { type WalletStatus } from '@/components/WithdrawalForm';
import WithdrawalForm from '@/components/WithdrawalForm';
import HelpButton from '@/components/HelpButton';
import { CardSkeleton } from '@/components/Skeleton';
import AddMoneyPanel from '@/components/money/AddMoneyPanel';
import HistoryPanel, { type Breakdown } from '@/components/money/HistoryPanel';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

export type MoneyTab = 'add' | 'withdraw' | 'history';

const TABS: { id: MoneyTab; label: TranslationKey; icon: typeof Plus }[] = [
  { id: 'add', label: 'money.tabAdd', icon: Plus },
  { id: 'withdraw', label: 'money.tabWithdraw', icon: Send },
  { id: 'history', label: 'money.tabHistory', icon: History },
];

const DEFAULT_MERCHANT_NAME = 'BetZone';

interface BalancePageProps {
  initialTab?: MoneyTab;
  onBalanceChanged: () => void;
  /** Admin-only shortcut to Admin → Settings (shown when deposits are not set up). */
  onOpenAdminSettings?: () => void;
}

/** The one place for money: balance summary plus Add / Withdraw / History tabs. */
export default function BalancePage({ initialTab = 'add', onBalanceChanged, onOpenAdminSettings }: BalancePageProps) {
  const { formatNumber } = useFormat();
  const { t } = useT();
  const [tab, setTab] = useState<MoneyTab>(initialTab);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [merchantUpiId, setMerchantUpiId] = useState('');
  const [merchantName, setMerchantName] = useState(DEFAULT_MERCHANT_NAME);
  const [approvalTimeNote, setApprovalTimeNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ message: string; raw?: string } | null>(null);
  const tabRefs = useRef<Record<MoneyTab, HTMLButtonElement | null>>({ add: null, withdraw: null, history: null });
  const userRequests = useUserRequests();
  const { limits } = useMyLimits();
  const restriction = activePlayRestriction(limits);
  const selfExcludedUntil = limits?.self_excluded_until && Date.parse(limits.self_excluded_until) > Date.now()
    ? limits.self_excluded_until
    : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bd, wallet, upi, mname, approvalNote] = await Promise.all([
        supabase.rpc('get_balance_breakdown'),
        supabase.rpc('get_wallet_status'),
        supabase.rpc('get_app_setting', { p_key: 'merchant_upi_id' }),
        supabase.rpc('get_app_setting', { p_key: 'merchant_name' }),
        supabase.rpc('get_app_setting', { p_key: 'approval_time_note' }),
      ]);
      const firstError = bd.error ?? wallet.error ?? upi.error ?? mname.error ?? approvalNote.error;
      if (firstError) {
        const friendly = friendlyErrorDetails(firstError);
        setLoadError({ message: friendly.message, raw: friendly.raw });
      } else {
        setLoadError(null);
      }
      if (!bd.error && bd.data) setBreakdown(bd.data as Breakdown);
      if (!wallet.error && wallet.data) setWalletStatus(wallet.data as WalletStatus);
      setMerchantUpiId(typeof upi.data === 'string' ? upi.data : '');
      setMerchantName(typeof mname.data === 'string' && mname.data ? mname.data : DEFAULT_MERCHANT_NAME);
      setApprovalTimeNote(typeof approvalNote.data === 'string' ? approvalNote.data : '');
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setLoadError({ message: friendly.message, raw: friendly.raw });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const afterRequest = async () => {
    await load();
    await userRequests.refresh();
    onBalanceChanged();
  };

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const hasPendingDeposit = userRequests.requests.some((request) => request.kind === 'deposit' && request.status === 'pending');
  const rupees = (value: number | undefined) => (value === undefined ? '—' : `₹${formatNumber(value)}`);

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader title={t('money.title')} subtitle={t('money.subtitle')} actions={<HelpButton />} />

      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6 sm:px-5">
        {loadError && <Alert details={loadError.raw} onRetry={() => void load()}>{loadError.message}</Alert>}
        {restriction && (
          <Alert tone="warning">
            {interpolate(t(restriction.kind === 'cooldown' ? 'restriction.cooldown' : 'restriction.selfExclusion'), { date: formatLimitEnd(restriction.until) })}
          </Alert>
        )}

        {loading && !breakdown ? (
          <CardSkeleton />
        ) : breakdown ? (
          <section className="rounded-card border border-surface-border bg-gradient-to-br from-surface to-surface-raised/60 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('dashboard.totalBalance')}</p>
            <p className="mt-1 text-4xl font-bold tracking-tight text-ink-strong">{rupees(breakdown.play_balance + breakdown.wallet)}</p>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-surface-border pt-4">
              <div>
                <dt className="text-xs text-ink-muted">{t('dashboard.playBalance')}</dt>
                <dd className="text-lg font-semibold text-accent-400">{rupees(breakdown.play_balance)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">{t('dashboard.withdrawable')}</dt>
                <dd className="text-lg font-semibold text-brand-400">{rupees(breakdown.wallet)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-ink-muted">{t('money.balanceExplainer')}</p>
          </section>
        ) : !loadError ? (
          <Alert>{t('money.loadFailed')}</Alert>
        ) : null}

        <div role="tablist" aria-label={t('money.title')} className="grid grid-cols-3 gap-1 rounded-card border border-surface-border bg-surface/80 p-1">
          {TABS.map(({ id, label, icon: Icon }) => {
            const selected = tab === id;
            return (
              <button
                key={id}
                ref={(element) => { tabRefs.current[id] = element; }}
                type="button"
                role="tab"
                id={`money-tab-${id}`}
                aria-selected={selected}
                aria-controls={`money-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={onTabKeyDown}
                className={`flex min-h-tap items-center justify-center gap-1.5 rounded-control text-sm font-semibold transition-colors ${
                  selected ? 'bg-surface-raised text-ink-strong shadow' : 'text-ink-muted hover:text-ink-soft'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" /> {t(label)}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" id={`money-panel-${tab}`} aria-labelledby={`money-tab-${tab}`} tabIndex={-1}>
          {tab === 'add' && (
            breakdown ? (
              <AddMoneyPanel
                maxAmount={breakdown.max_add_funds_amount}
                merchantUpiId={merchantUpiId}
                merchantName={merchantName}
                selfExcludedUntil={selfExcludedUntil}
                hasPendingDeposit={hasPendingDeposit}
                approvalTimeNote={approvalTimeNote}
                onOpenAdminSettings={onOpenAdminSettings}
                onSubmitted={afterRequest}
              />
            ) : loading ? <CardSkeleton /> : null
          )}
          {tab === 'withdraw' && (
            <div className="space-y-4">
              {approvalTimeNote && <Alert tone="info">{approvalTimeNote}</Alert>}
              <Card className="space-y-4">
                <WithdrawalForm status={walletStatus} onSubmitted={afterRequest} />
              </Card>
              <p className="px-1 text-xs text-ink-muted">{t('withdraw.rules')}</p>
            </div>
          )}
          {tab === 'history' && (
            <HistoryPanel breakdown={breakdown} requests={userRequests.requests} requestsError={userRequests.error} />
          )}
        </div>
      </main>
    </div>
  );
}
