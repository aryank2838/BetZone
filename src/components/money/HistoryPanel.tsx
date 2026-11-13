import { useCallback, useEffect, useState } from 'react';
import { Banknote, Dice1, Download, Gift, History, Minus, Plus, Send, Sparkles, TrendingDown, Trophy } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { buildLedgerCsv, type LedgerCsvEntry } from '@/lib/ledgerCsv';
import { collectCursorPages, ledgerCursorFilter } from '@/lib/ledgerPagination';
import type { UserRequest } from '@/lib/useUserRequests';
import RequestTimeline from '@/components/RequestTimeline';
import { ListSkeleton } from '@/components/Skeleton';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/Card';
import { useFormat } from '@/i18n/useFormat';
import { useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

export interface Breakdown {
  signup_earned: number;
  selections_spent: number;
  winnings_total: number;
  deposits_total: number;
  withdrawn_total: number;
  play_balance: number;
  wallet: number;
  pending_withdrawals: number;
  pending_add_funds: number;
  max_add_funds_amount: number;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const REASONS: Record<string, { label: TranslationKey; icon: typeof Gift }> = {
  signup_bonus: { label: 'history.signupBonus', icon: Gift },
  selection_submit: { label: 'history.bet', icon: Dice1 },
  winning_payout: { label: 'history.winnings', icon: Trophy },
  payout: { label: 'history.winnings', icon: Trophy },
  withdrawal_request: { label: 'history.withdrawal', icon: Banknote },
  withdrawal_refund: { label: 'history.withdrawalRefund', icon: Banknote },
  add_funds: { label: 'history.moneyAdded', icon: Plus },
  admin_adjust_points: { label: 'history.adjustment', icon: History },
  admin_adjust_wallet: { label: 'history.adjustment', icon: History },
};

type FilterType = 'all' | 'selection_submit' | 'withdrawals' | 'winnings' | 'add_funds';

const FILTERS: { id: FilterType; label: TranslationKey }[] = [
  { id: 'all', label: 'history.filterAll' },
  { id: 'selection_submit', label: 'history.filterBets' },
  { id: 'winnings', label: 'history.filterWinnings' },
  { id: 'add_funds', label: 'history.filterAdded' },
  { id: 'withdrawals', label: 'history.filterWithdrawals' },
];

const PAGE_SIZE = 50;
const LEDGER_COLUMNS = 'id, delta, reason, metadata, created_at';

function SummaryRow({ icon, label, sub, value }: { icon: React.ReactNode; label: string; sub: string; value: number }) {
  const { formatNumber } = useFormat();
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-strong">{label}</span>
        <span className="block text-xs text-ink-muted">{sub}</span>
      </span>
      <span className={`text-sm font-semibold tabular-nums ${value < 0 ? 'text-rose-300' : 'text-ink-strong'}`}>
        {value > 0 ? '+' : value < 0 ? '−' : ''}₹{formatNumber(Math.abs(value))}
      </span>
    </li>
  );
}

export default function HistoryPanel({ breakdown, requests, requestsError }: {
  breakdown: Breakdown | null;
  requests: UserRequest[];
  requestsError: { message: string; raw?: string } | null;
}) {
  const { formatDate, formatNumber } = useFormat();
  const { t } = useT();
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<{ message: string; raw?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error: ledgerError } = await supabase.from('point_ledger').select(LEDGER_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE);
      if (ledgerError) throw ledgerError;
      const rows = (data ?? []) as LedgerEntry[];
      setLedger(rows);
      setHasMore(rows.length === PAGE_SIZE);
      setError(null);
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setError({ message: friendly.message, raw: friendly.raw });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (loadingMore || !hasMore || ledger.length === 0) return;
    setLoadingMore(true);
    const { data, error: ledgerError } = await supabase.from('point_ledger').select(LEDGER_COLUMNS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .or(ledgerCursorFilter(ledger[ledger.length - 1]))
      .limit(PAGE_SIZE);
    if (ledgerError) {
      const friendly = friendlyErrorDetails(ledgerError);
      setError({ message: friendly.message, raw: friendly.raw });
    } else if (data) {
      setError(null);
      const next = data as LedgerEntry[];
      setLedger((previous) => [...previous, ...next]);
      setHasMore(next.length === PAGE_SIZE);
    }
    setLoadingMore(false);
  };

  const downloadStatement = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const entries = await collectCursorPages<LedgerEntry>(async (cursor, pageSize) => {
        let query = supabase.from('point_ledger').select(LEDGER_COLUMNS)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(pageSize);
        if (cursor) query = query.or(ledgerCursorFilter(cursor));
        const { data, error: pageError } = await query;
        if (pageError) throw pageError;
        return (data ?? []) as LedgerEntry[];
      }, 500);
      const csvEntries: LedgerCsvEntry[] = entries.map(({ delta, reason, metadata, created_at }) => ({ delta, reason, metadata, created_at }));
      const blob = new Blob([buildLedgerCsv(csvEntries)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'wallet-statement.csv';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setError({ message: friendly.message, raw: friendly.raw });
    } finally {
      setExporting(false);
    }
  };

  const filtered = filter === 'all'
    ? ledger
    : filter === 'withdrawals'
      ? ledger.filter((entry) => entry.reason === 'withdrawal_request' || entry.reason === 'withdrawal_refund')
      : filter === 'winnings'
        ? ledger.filter((entry) => entry.reason === 'winning_payout' || entry.reason === 'payout')
        : ledger.filter((entry) => entry.reason === filter);

  return (
    <div className="space-y-6">
      <RequestTimeline requests={requests} error={requestsError} />

      <section aria-labelledby="ledger-title">
        <SectionTitle
          id="ledger-title"
          icon={<History className="h-4 w-4" aria-hidden="true" />}
          action={(
            <Button variant="ghost" loading={exporting} icon={<Download className="h-4 w-4" />} onClick={() => void downloadStatement()}>
              {exporting ? t('history.preparing') : t('history.download')}
            </Button>
          )}
        >
          {t('history.title')}
        </SectionTitle>

        {error && <Alert details={error.raw} onRetry={() => void load()} className="mb-3">{error.message}</Alert>}

        <div className="mb-3 flex gap-2 overflow-x-auto pb-1" role="group" aria-label={t('history.filterLabel')}>
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              aria-pressed={filter === item.id}
              className={`min-h-[40px] whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors ${
                filter === item.id
                  ? 'bg-brand-600 text-white'
                  : 'border border-surface-border bg-surface text-ink-muted hover:border-surface-strong hover:text-ink-soft'
              }`}
            >
              {t(item.label)}
            </button>
          ))}
        </div>

        {loading ? (
          <ListSkeleton rows={4} />
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">{filter === 'all' ? t('history.empty') : t('history.noMatch')}</p>
        ) : (
          <>
            <ul className="divide-y divide-surface-border rounded-card border border-surface-border bg-surface/80">
              {filtered.map((entry) => {
                const info = REASONS[entry.reason];
                const Icon = info?.icon ?? History;
                const positive = entry.delta > 0;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`flex h-8 w-8 items-center justify-center rounded-full ${positive ? 'bg-brand-950 text-brand-400' : 'bg-surface-raised text-ink-muted'}`} aria-hidden="true">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-sm font-medium text-ink-soft">{info ? t(info.label) : entry.reason}</p>
                        <p className="text-xs text-ink-muted">{formatDate(entry.created_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                    </div>
                    <span className={`flex items-center gap-0.5 text-sm font-semibold tabular-nums ${positive ? 'text-brand-400' : 'text-ink-muted'}`}>
                      {positive ? <Plus className="h-3.5 w-3.5" aria-label="+" /> : <Minus className="h-3.5 w-3.5" aria-label="−" />}
                      ₹{formatNumber(Math.abs(entry.delta))}
                    </span>
                  </li>
                );
              })}
            </ul>
            {hasMore && filter === 'all' && (
              <Button variant="secondary" fullWidth className="mt-3" loading={loadingMore} onClick={() => void loadMore()}>
                {t('common.loadMore')}
              </Button>
            )}
          </>
        )}
      </section>

      {breakdown && (
        <section aria-labelledby="summary-title">
          <SectionTitle id="summary-title">{t('history.summary')}</SectionTitle>
          <ul className="divide-y divide-surface-border rounded-card border border-surface-border bg-surface/80">
            <SummaryRow icon={<Gift className="h-4 w-4 text-amber-400" />} label={t('history.welcomeBonus')} sub={t('history.welcomeBonusSub')} value={breakdown.signup_earned} />
            <SummaryRow icon={<Plus className="h-4 w-4 text-accent-400" />} label={t('history.moneyAdded')} sub={t('history.moneyAddedSub')} value={breakdown.deposits_total} />
            <SummaryRow icon={<TrendingDown className="h-4 w-4 text-rose-400" />} label={t('history.spent')} sub={t('history.spentSub')} value={-breakdown.selections_spent} />
            <SummaryRow icon={<Sparkles className="h-4 w-4 text-brand-400" />} label={t('history.winnings')} sub={t('history.winningsSub')} value={breakdown.winnings_total} />
            <SummaryRow icon={<Send className="h-4 w-4 text-ink-muted" />} label={t('history.withdrawn')} sub={t('history.withdrawnSub')} value={-breakdown.withdrawn_total} />
          </ul>
        </section>
      )}
    </div>
  );
}
