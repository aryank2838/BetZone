import { useState } from 'react';
import { ImageIcon, Plus, Search, Users, Wallet } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';

export interface AdminListFilter {
  status: string;
  from: string;
  to: string;
  search: string;
}

export interface WithdrawalRequest {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  upi_id: string;
  created_at: string;
  processed_at: string | null;
  reject_reason: string | null;
  user_name: string;
}

export interface AddFundsRequest {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  payment_ref: string;
  screenshot_path: string | null;
  created_at: string;
  processed_at: string | null;
  reject_reason: string | null;
  user_name: string;
}

interface RequestsTabProps {
  withdrawals: WithdrawalRequest[];
  addFundsRequests: AddFundsRequest[];
  loading: boolean;
  processingId: string | null;
  loadingMore: boolean;
  hasMoreWithdrawals: boolean;
  hasMoreAddFunds: boolean;
  message: { kind: 'ok' | 'err'; text: string; raw?: string } | null;
  addFundsFilter: AdminListFilter;
  withdrawalFilter: AdminListFilter;
  onAddFundsFilterChange: (filter: AdminListFilter) => void;
  onWithdrawalFilterChange: (filter: AdminListFilter) => void;
  onSearch: (kind: 'withdrawals' | 'addFunds') => void;
  onProcessWithdrawal: (id: string, status: 'approved' | 'rejected', reason?: string) => void;
  onProcessAddFunds: (id: string, status: 'approved' | 'rejected', reason?: string) => void;
  onViewScreenshot: (path: string) => void;
  onLoadMore: (kind: 'withdrawals' | 'addFunds') => void;
}

export default function RequestsTab(props: RequestsTabProps) {
  const { formatNumber, formatDate } = useFormat();
  const [rejecting, setRejecting] = useState<{ id: string; kind: 'withdrawal' | 'addFunds'; reason: string } | null>(null);
  const {
    withdrawals, addFundsRequests, loading, processingId, loadingMore,
    hasMoreWithdrawals, hasMoreAddFunds, message, addFundsFilter, withdrawalFilter,
    onAddFundsFilterChange, onWithdrawalFilterChange, onSearch, onProcessWithdrawal,
    onProcessAddFunds, onViewScreenshot, onLoadMore,
  } = props;
  const openReject = (id: string, kind: 'withdrawal' | 'addFunds') => setRejecting({ id, kind, reason: '' });
  const confirmReject = () => {
    if (!rejecting || rejecting.reason.trim().length < 3 || rejecting.reason.trim().length > 200) return;
    if (rejecting.kind === 'withdrawal') onProcessWithdrawal(rejecting.id, 'rejected', rejecting.reason.trim());
    else onProcessAddFunds(rejecting.id, 'rejected', rejecting.reason.trim());
    setRejecting(null);
  };

  return (
    <section className="space-y-6 animate-fade-in">
      <div>
        <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Add Funds Requests</h3>
        <RequestFilters filter={addFundsFilter} onChange={onAddFundsFilterChange} onSearch={() => onSearch('addFunds')} searchPlaceholder="Search name or UTR" />
        {loading ? <Loading /> : addFundsRequests.length === 0 ? (
          <Empty icon={<Plus className="w-5 h-5 text-slate-700 mx-auto mb-2" />} text="No add-funds requests match these filters." />
        ) : (
          <div className="space-y-2">
            {addFundsRequests.map((request) => (
              <div key={request.id} className="border border-slate-800 rounded-xl bg-slate-900/80 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2"><Users className="w-3.5 h-3.5 text-slate-400" /><span className="text-sm font-medium text-white">{request.user_name}</span></div>
                  <span className="text-lg font-bold text-emerald-400">{formatNumber(request.amount)} balance</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Ref: {request.payment_ref}</span>
                  <span className="text-xs text-slate-400">{formatDate(request.created_at)}</span>
                </div>
                {request.screenshot_path && (
                  <button onClick={() => onViewScreenshot(request.screenshot_path!)} className="mt-2 flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
                    <ImageIcon className="w-3.5 h-3.5" /> View payment screenshot
                  </button>
                )}
                {request.status === 'pending' ? <div className="flex gap-2 mt-3">
                  <button onClick={() => onProcessAddFunds(request.id, 'approved')} disabled={processingId === request.id} className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors">Approve & credit</button>
                  <button onClick={() => openReject(request.id, 'addFunds')} disabled={processingId === request.id} className="flex-1 py-2 rounded-lg border border-slate-700 text-slate-300 text-xs font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors">Reject</button>
                </div> : <p className={`mt-3 text-xs ${request.status === 'approved' ? 'text-emerald-400' : 'text-rose-400'}`}>{request.status}{request.reject_reason ? ` · ${request.reject_reason}` : ''}</p>}
                {rejecting?.id === request.id && rejecting.kind === 'addFunds' && (
                  <RejectReasonForm value={rejecting.reason} onChange={(reason) => setRejecting({ ...rejecting, reason })} onCancel={() => setRejecting(null)} onConfirm={confirmReject} disabled={processingId === request.id} />
                )}
              </div>
            ))}
          </div>
        )}
        {hasMoreAddFunds && <LoadMore loading={loadingMore} label="Load more add-funds requests" onClick={() => onLoadMore('addFunds')} />}
      </div>

      <div>
        <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Withdrawal Requests</h3>
        <RequestFilters filter={withdrawalFilter} onChange={onWithdrawalFilterChange} onSearch={() => onSearch('withdrawals')} searchPlaceholder="Search by name" />
        {loading ? <Loading /> : withdrawals.length === 0 ? (
          <Empty icon={<Wallet className="w-5 h-5 text-slate-700 mx-auto mb-2" />} text="No withdrawal requests match these filters." />
        ) : (
          <div className="space-y-2">
            {withdrawals.map((request) => (
              <div key={request.id} className="border border-slate-800 rounded-xl bg-slate-900/80 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2"><Users className="w-3.5 h-3.5 text-slate-400" /><span className="text-sm font-medium text-white">{request.user_name}</span></div>
                  <span className="text-lg font-bold text-white">{formatNumber(request.amount)} balance</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">UPI: {request.upi_id}</span>
                  <span className="text-xs text-slate-400">{formatDate(request.created_at, { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
                {request.status === 'pending' ? <div className="flex gap-2 mt-3">
                  <button onClick={() => onProcessWithdrawal(request.id, 'approved')} disabled={processingId === request.id} className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors">Approve</button>
                  <button onClick={() => openReject(request.id, 'withdrawal')} disabled={processingId === request.id} className="flex-1 py-2 rounded-lg border border-slate-700 text-slate-300 text-xs font-medium hover:bg-slate-800 disabled:opacity-40 transition-colors">Reject (refund)</button>
                </div> : <p className={`mt-3 text-xs ${request.status === 'approved' ? 'text-emerald-400' : 'text-rose-400'}`}>{request.status}{request.reject_reason ? ` · ${request.reject_reason}` : ''}</p>}
                {rejecting?.id === request.id && rejecting.kind === 'withdrawal' && (
                  <RejectReasonForm value={rejecting.reason} onChange={(reason) => setRejecting({ ...rejecting, reason })} onCancel={() => setRejecting(null)} onConfirm={confirmReject} disabled={processingId === request.id} />
                )}
              </div>
            ))}
          </div>
        )}
        {hasMoreWithdrawals && <LoadMore loading={loadingMore} label="Load more withdrawals" onClick={() => onLoadMore('withdrawals')} />}
      </div>
      {message && (
        <div role={message.kind === 'err' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
          <p>{message.text}</p>
          {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
        </div>
      )}
    </section>
  );
}

function RequestFilters({ filter, onChange, onSearch, searchPlaceholder }: {
  filter: AdminListFilter;
  onChange: (filter: AdminListFilter) => void;
  onSearch: () => void;
  searchPlaceholder: string;
}) {
  return <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
    <select value={filter.status} onChange={(event) => onChange({ ...filter, status: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-xs text-white">
      <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
    </select>
    <div className="relative">
      <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <input value={filter.search} onChange={(event) => onChange({ ...filter, search: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') onSearch(); }} placeholder={searchPlaceholder} className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 pl-7 pr-2 text-xs text-white" />
    </div>
    <label className="text-[10px] text-slate-400">From (IST)<input type="date" value={filter.from} onChange={(event) => onChange({ ...filter, from: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 p-2 text-xs text-white" /></label>
    <label className="text-[10px] text-slate-400">To (IST)<input type="date" value={filter.to} onChange={(event) => onChange({ ...filter, to: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 p-2 text-xs text-white" /></label>
    <button type="button" onClick={onSearch} className="col-span-2 rounded-lg bg-slate-700 py-2 text-xs font-medium text-white hover:bg-slate-600">Apply filters</button>
  </div>;
}

function Loading() {
  return <ListSkeleton rows={3} />;
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="border border-dashed border-slate-800 rounded-xl py-8 px-4 text-center">{icon}<p className="text-sm text-slate-400">{text}</p></div>;
}

function LoadMore({ loading, label, onClick }: { loading: boolean; label: string; onClick: () => void }) {
  return <button onClick={onClick} disabled={loading} className="w-full mt-2 py-2 rounded-lg border border-slate-800 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-40">{loading ? 'Loading…' : label}</button>;
}

function RejectReasonForm({ value, onChange, onCancel, onConfirm, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-3 space-y-2">
      <label className="block text-xs text-slate-400">
        Rejection reason (3–200 characters)
        <textarea value={value} maxLength={200} onChange={(event) => onChange(event.target.value)} rows={2} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm text-white focus:border-rose-400 focus:outline-none" />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg border border-slate-700 py-2 text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={disabled || value.trim().length < 3} className="flex-1 rounded-lg bg-rose-700 py-2 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-40">Confirm rejection</button>
      </div>
    </div>
  );
}
