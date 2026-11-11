import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import WithdrawalForm, { type WalletStatus } from '@/components/WithdrawalForm';
import { friendlyErrorDetails } from '@/lib/errors';
import { useUserRequests } from '@/lib/useUserRequests';
import RequestTimeline from '@/components/RequestTimeline';
import HelpButton from '@/components/HelpButton';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import { buildLedgerCsv, type LedgerCsvEntry } from '@/lib/ledgerCsv';
import { collectCursorPages, ledgerCursorFilter } from '@/lib/ledgerPagination';
import { ArrowLeft, Loader2, Wallet as WalletIcon, Lock, History, Gift, Dice1, Trophy, Banknote, Plus, Minus, Filter, ChevronDown, ReceiptText } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';

interface WalletPageProps {
  onBack: () => void;
  onWalletChanged: () => void;
  onMyBets?: () => void;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const REASON_LABELS: Record<string, { label: string; icon: typeof Gift }> = {
  signup_bonus: { label: 'Signup bonus', icon: Gift },
  selection_submit: { label: 'Game entry', icon: Dice1 },
  winning_payout: { label: 'Winnings', icon: Trophy },
  payout: { label: 'Winnings', icon: Trophy },
  withdrawal_request: { label: 'Withdrawal', icon: Banknote },
  withdrawal_refund: { label: 'Withdrawal refund', icon: Banknote },
  add_funds: { label: 'Added funds', icon: Plus },
  admin_adjust_points: { label: 'Admin adjustment', icon: History },
  admin_adjust_wallet: { label: 'Admin adjustment', icon: History },
};

type FilterType = 'all' | 'selection_submit' | 'withdrawals' | 'winnings' | 'add_funds';

const FILTERS: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'selection_submit', label: 'Game entries' },
  { id: 'withdrawals', label: 'Withdrawals' },
  { id: 'winnings', label: 'Winnings' },
  { id: 'add_funds', label: 'Added funds' },
];

const PAGE_SIZE = 50;

export default function WalletPage({ onBack, onWalletChanged, onMyBets }: WalletPageProps) {
  const { formatDate } = useFormat();
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState<{ message: string; raw?: string } | null>(null);
  const [approvalTimeNote, setApprovalTimeNote] = useState('');
  const [exporting, setExporting] = useState(false);
  const userRequests = useUserRequests();
  const { limits } = useMyLimits();
  const restriction = activePlayRestriction(limits);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: walletData, error: walletError }, { data: ledgerData, error: ledgerError }, { data: noteData, error: noteError }] = await Promise.all([
        supabase.rpc('get_wallet_status'),
        supabase.from('point_ledger').select('id, delta, reason, metadata, created_at')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(PAGE_SIZE),
        supabase.rpc('get_app_setting', { p_key: 'approval_time_note' }),
      ]);
      const requestError = walletError ?? ledgerError ?? noteError;
      if (requestError) {
        const friendly = friendlyErrorDetails(requestError);
        setLoadError({ message: friendly.message, raw: friendly.raw });
      } else {
        setLoadError(null);
      }
      if (!walletError && walletData) setStatus(walletData as WalletStatus);
      if (!ledgerError && ledgerData) {
        setLedger(ledgerData as LedgerEntry[]);
        setHasMore((ledgerData as LedgerEntry[]).length === PAGE_SIZE);
      }
      setApprovalTimeNote(typeof noteData === 'string' ? noteData : '');
    } catch (error) {
      const friendly = friendlyErrorDetails(error);
      setLoadError({ message: friendly.message, raw: friendly.raw });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDownloadStatement = async () => {
    if (exporting) return;
    setExporting(true);
    setLoadError(null);
    try {
      const ledgerEntries = await collectCursorPages<LedgerEntry>(async (cursor, pageSize) => {
        let query = supabase
          .from('point_ledger')
          .select('id, delta, reason, metadata, created_at')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(pageSize);
        if (cursor) query = query.or(ledgerCursorFilter(cursor));
        const { data, error } = await query;
        if (error) throw error;
        return (data ?? []) as LedgerEntry[];
      }, 500);
      const entries: LedgerCsvEntry[] = ledgerEntries.map(({ delta, reason, metadata, created_at }) => ({
        delta, reason, metadata, created_at,
      }));

      const blob = new Blob([buildLedgerCsv(entries)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'wallet-statement.csv';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      const friendly = friendlyErrorDetails(error);
      setLoadError({ message: friendly.message, raw: friendly.raw });
    } finally {
      setExporting(false);
    }
  };

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const lastEntry = ledger[ledger.length - 1];
    const { data, error } = await supabase
      .from('point_ledger')
      .select('id, delta, reason, metadata, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .or(ledgerCursorFilter(lastEntry))
      .limit(PAGE_SIZE);

    if (error) {
      const friendly = friendlyErrorDetails(error);
      setLoadError({ message: friendly.message, raw: friendly.raw });
    } else if (data) {
      setLoadError(null);
      const newEntries = data as LedgerEntry[];
      setLedger((prev) => [...prev, ...newEntries]);
      setHasMore(newEntries.length === PAGE_SIZE);
    }
    setLoadingMore(false);
  };

  const filteredLedger = filter === 'all'
    ? ledger
    : filter === 'withdrawals'
      ? ledger.filter((e) => e.reason === 'withdrawal_request' || e.reason === 'withdrawal_refund')
      : ledger.filter((e) => e.reason === filter || (filter === 'winnings' && (e.reason === 'winning_payout' || e.reason === 'payout')));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />

      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-5 py-3.5 flex items-center gap-3">
          <button onClick={onBack} className="tap-target text-slate-400 hover:text-white transition-colors p-1" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="font-bold text-white leading-tight">Wallet</h2>
            <p className="text-[11px] text-slate-400 leading-tight">Your winnings and withdrawals</p>
          </div>
          {onMyBets && (
            <button type="button" onClick={onMyBets} className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800">
              <ReceiptText className="h-3.5 w-3.5" /> My bets
            </button>
          )}
          <HelpButton />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8 space-y-8 relative z-10">
        {loadError && (
          <div className="rounded-xl border border-rose-900 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
            <p>{loadError.message}</p>
            {loadError.raw && <p className="mt-1 text-xs text-rose-400/70">{loadError.raw}</p>}
            <button type="button" onClick={() => void load()} className="mt-2 text-xs font-semibold text-rose-200">Retry</button>
          </div>
        )}
        {restriction && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            {restriction.kind === 'cooldown' ? 'Betting break active' : 'Self-exclusion active'} until {formatLimitEnd(restriction.until)}. Withdrawals remain available.
          </div>
        )}
        {loading ? (
          <ListSkeleton rows={4} />
        ) : (
          <>
            <section className="border border-emerald-900 bg-emerald-950/30 rounded-2xl p-5 animate-slide-up">
              <div className="flex items-center gap-2 text-emerald-400 mb-2">
                <WalletIcon className="w-4 h-4" />
                <p className="text-xs font-medium uppercase tracking-wide">Withdrawable winnings</p>
              </div>
              <div className="flex items-baseline gap-2">
                <p className="text-4xl font-bold text-emerald-400">{status?.wallet ?? 0}</p>
                <p className="text-sm text-emerald-500">balance</p>
              </div>
              <p className="text-xs text-emerald-600/70 mt-2">Withdrawals are paid from your wallet balance.</p>
              <p className="text-xs text-emerald-600/70 mt-1">Withdrawal eligibility requires at least 100 in approved deposits and wagering turnover equal to those deposits (1×).</p>
            </section>

            <section className="border border-slate-800 bg-slate-900/80 rounded-2xl p-5 animate-slide-up" style={{ animationDelay: '50ms' }}>
              <div className="flex items-center gap-2 mb-1">
                <Lock className="w-3.5 h-3.5 text-slate-400" />
                <p className="text-sm font-medium text-white">Play balance</p>
              </div>
              <p className="text-2xl font-semibold text-cyan-400">{status?.points ?? 0} <span className="text-sm font-normal text-slate-400">balance</span></p>
              <p className="text-xs text-slate-400 mt-1">Play balance is used first when placing bets; any remaining stake is taken from your wallet balance.</p>
            </section>

            <section className="animate-slide-up" style={{ animationDelay: '100ms' }}>
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Request withdrawal</h3>
              {approvalTimeNote && <p className="mb-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-300">{approvalTimeNote}</p>}
              <div className="border border-slate-800 bg-slate-900/80 rounded-2xl p-5">
                <WithdrawalForm
                  status={status}
                  onSubmitted={async () => {
                    await load();
                    await userRequests.refresh();
                    onWalletChanged();
                  }}
                />
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                <History className="w-3.5 h-3.5 text-slate-400" />
                <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide">Transaction history</h3>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleDownloadStatement(); }}
                  disabled={exporting}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                >
                  {exporting ? 'Preparing…' : 'Download statement (CSV)'}
                </button>
              </div>

              <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1">
                <Filter className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                      filter === f.id
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {filteredLedger.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">
                  {filter === 'all' ? 'No transactions yet.' : 'No matching transactions.'}
                </p>
              ) : (
                <>
                  <div className="border border-slate-800 rounded-2xl bg-slate-900/80 divide-y divide-slate-800">
                    {filteredLedger.map((entry) => {
                      const info = REASON_LABELS[entry.reason] ?? { label: entry.reason, icon: History };
                      const Icon = info.icon;
                      const positive = entry.delta > 0;
                      return (
                        <div key={entry.id} className="flex items-center justify-between px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center ${positive ? 'bg-emerald-950 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                              <Icon className="w-3.5 h-3.5" />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-slate-200">{info.label}</p>
                              <p className="text-[11px] text-slate-400">{formatDate(entry.created_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                            </div>
                          </div>
                          <div className={`flex items-center gap-1 text-sm font-semibold ${positive ? 'text-emerald-400' : 'text-slate-400'}`}>
                            {positive ? <Plus className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                            {Math.abs(entry.delta)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {hasMore && filter === 'all' && (
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="w-full mt-3 py-2.5 rounded-xl border border-slate-800 bg-slate-900/80 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
                    >
                      {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <><ChevronDown className="w-4 h-4" /> Load more</>}
                    </button>
                  )}
                </>
              )}
            </section>

            <RequestTimeline requests={userRequests.requests} error={userRequests.error} />
          </>
        )}
      </main>
    </div>
  );
}
