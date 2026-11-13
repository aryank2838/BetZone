import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ListSkeleton, Skeleton } from '@/components/Skeleton';
import { supabase } from '@/lib/supabase';
import { buildCsv } from '@/lib/csv';
import { friendlyErrorDetails } from '@/lib/errors';
import { GAME_LABELS, type Game } from '@/types';

interface DailyRow {
  game: Game | 'ALL';
  total_staked: number;
  total_paid_out: number;
  gaming_revenue: number;
  approved_deposits?: number;
  approved_withdrawals?: number;
  net_cash?: number;
}

interface ReconciliationRow {
  user_id: string;
  display_name: string;
  points: number;
  wallet: number;
  ledger_total: number;
  opening_balance: number;
  expected_balance: number;
  difference: number;
}

interface LegacyOpeningBalance {
  user_id: string;
  display_name: string | null;
  opening_balance: number;
  captured_at: string;
}

export default function ReportsTab() {
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [mismatches, setMismatches] = useState<ReconciliationRow[]>([]);
  const [openingBalances, setOpeningBalances] = useState<LegacyOpeningBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [report, reconciliation, legacyBalances] = await Promise.all([
      supabase.rpc('admin_daily_report', { p_date: date }),
      supabase.rpc('admin_ledger_reconciliation'),
      supabase.rpc('admin_list_ledger_opening_balances'),
    ]);
    const failure = report.error ?? reconciliation.error ?? legacyBalances.error;
    if (failure) {
      const friendly = friendlyErrorDetails(failure);
      setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      setDaily([]);
      setMismatches([]);
      setOpeningBalances([]);
    } else {
      setDaily((report.data ?? []) as DailyRow[]);
      setMismatches((reconciliation.data ?? []) as ReconciliationRow[]);
      setOpeningBalances((legacyBalances.data ?? []) as LegacyOpeningBalance[]);
    }
    setLoading(false);
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const downloadCsv = () => {
    const rows: Array<Array<string | number>> = [
      ['game', 'total staked', 'total paid out', 'gaming revenue', 'approved deposits', 'approved withdrawals', 'net cash'],
      ...daily.map((row) => [
        row.game === 'ALL' ? 'All games' : GAME_LABELS[row.game],
        row.total_staked, row.total_paid_out, row.gaming_revenue,
        row.approved_deposits ?? '', row.approved_withdrawals ?? '', row.net_cash ?? '',
      ]),
      [],
      [`Legacy opening balances: ${openingBalances.length} users, total ${openingBalances.reduce((sum, row) => sum + row.opening_balance, 0)}`],
      ['user id', 'display name', 'opening balance', 'captured at'],
      ...openingBalances.map((row) => [row.user_id, row.display_name ?? '', row.opening_balance, row.captured_at]),
      [],
      ['Ledger reconciliation mismatches'],
      ['user id', 'display name', 'play balance', 'wallet balance', 'ledger total', 'legacy opening balance', 'expected balance', 'difference'],
      ...mismatches.map((row) => [
        row.user_id, row.display_name, row.points, row.wallet, row.ledger_total,
        row.opening_balance, row.expected_balance, row.difference,
      ]),
    ];
    const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `admin-report-${date}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-5 animate-fade-in">
      <header>
        <h3 className="text-lg font-semibold">Daily reconciliation</h3>
        <p className="text-xs text-ink-muted">Amounts use IST. Gaming revenue is stakes minus payouts; approved deposits and withdrawals are reported separately as net cash for all games.</p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 text-xs text-ink-muted">Report date (IST)
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 w-full rounded-lg border border-surface-strong bg-surface-raised p-2.5 text-sm text-ink-strong" />
        </label>
        <button type="button" disabled={loading || !daily.length} onClick={downloadCsv} className="flex items-center gap-2 rounded-lg border border-surface-strong px-3 min-h-tap py-2.5 text-sm text-slate-200 disabled:opacity-40">
          <Download className="h-4 w-4" /> Download CSV
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {loading ? <ListSkeleton rows={3} /> : (
        <div className="overflow-x-auto rounded-control border border-surface-border">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-surface text-ink-muted"><tr>
              {['Game', 'Staked', 'Paid out', 'Gaming revenue', 'Approved deposits', 'Approved withdrawals', 'Net cash'].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}
            </tr></thead>
            <tbody>{daily.map((row) => <tr key={row.game} className="border-t border-surface-border">
              <td className="px-3 py-3 font-medium text-slate-200">{row.game === 'ALL' ? 'All games' : GAME_LABELS[row.game]}</td>
              <td className="px-3 py-3">{row.total_staked}</td><td className="px-3 py-3">{row.total_paid_out}</td>
              <td className="px-3 py-3">{row.gaming_revenue}</td>
              <td className="px-3 py-3">{row.approved_deposits ?? '—'}</td>
              <td className="px-3 py-3">{row.approved_withdrawals ?? '—'}</td>
              <td className="px-3 py-3">{row.net_cash ?? '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <section className="space-y-3 rounded-control border border-amber-900/70 bg-amber-950/20 p-4">
        <div>
          <h4 className="font-semibold">Legacy opening balances</h4>
          {loading ? <Skeleton className="mt-2 h-4 w-2/3" /> : (
            <p className="mt-1 text-xs text-amber-200">
              Legacy opening balances: {openingBalances.length} users, total {openingBalances.reduce((sum, row) => sum + row.opening_balance, 0)}
            </p>
          )}
        </div>
        {!loading && openingBalances.map((row) => (
          <div key={row.user_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-900/50 pt-2 text-xs">
            <span className="text-ink-soft">{row.display_name || 'Unnamed'} · {row.user_id}</span>
            <span className="text-amber-200">{row.opening_balance} · captured {new Date(row.captured_at).toLocaleString()}</span>
          </div>
        ))}
      </section>
      <section className="space-y-3 rounded-control border border-surface-border bg-surface/70 p-4">
        <div>
          <h4 className="font-semibold">Balance mismatches</h4>
          <p className="mt-1 text-xs text-ink-muted">Reconciliation compares balances with ledger deltas plus the legacy opening amounts shown above. Those captured amounts are not independently validated; reports do not change balances.</p>
        </div>
        {loading ? <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div> : mismatches.length === 0 ? (
          <p className="text-sm text-emerald-300">No differences from the recorded ledger and legacy balance baseline</p>
        ) : mismatches.map((row) => <div key={row.user_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-surface-border pt-2 text-xs">
          <span className="text-ink-soft">{row.display_name || 'Unnamed'} · {row.user_id}</span>
          <span className="text-rose-300">Expected {row.expected_balance} · actual {row.points + row.wallet} · difference {row.difference}</span>
        </div>)}
      </section>
    </section>
  );
}
