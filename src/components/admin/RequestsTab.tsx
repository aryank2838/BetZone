import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Clock, Copy, ImageIcon, Plus, Search, User, Wallet } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';
import { supabase } from '@/lib/supabase';
import { formatWaiting, sortForReview, waitingTone } from '@/lib/adminOverview';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Alert from '@/components/ui/Alert';
import { SectionTitle } from '@/components/ui/Card';
import { useToast } from '@/components/ui/toastContext';

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
  /** Set once the screenshot file was deleted (settled 30+ days ago). */
  screenshot_removed_at?: string | null;
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
  /** Called when a screenshot thumbnail has loaded on screen. */
  onScreenshotSeen?: (path: string) => void;
  onLoadMore: (kind: 'withdrawals' | 'addFunds') => void;
}

/** Re-renders every 30 seconds so "waiting" times stay current. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Short-lived signed URLs for the screenshot thumbnails on screen. */
function useScreenshotThumbnails(paths: string[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = paths.join('|');
  useEffect(() => {
    let active = true;
    const list = key ? key.split('|') : [];
    if (list.length === 0) return () => { active = false; };
    void (async () => {
      const { data, error } = await supabase.storage.from('payment-screenshots').createSignedUrls(list, 600);
      if (!active || error || !data) return;
      const next: Record<string, string> = {};
      for (const item of data) if (item.path && item.signedUrl) next[item.path] = item.signedUrl;
      setUrls(next);
    })();
    return () => { active = false; };
  }, [key]);
  return urls;
}

export default function RequestsTab(props: RequestsTabProps) {
  const [rejecting, setRejecting] = useState<{ id: string; kind: 'withdrawal' | 'addFunds'; reason: string } | null>(null);
  const {
    withdrawals, addFundsRequests, loading, processingId, loadingMore,
    hasMoreWithdrawals, hasMoreAddFunds, message, addFundsFilter, withdrawalFilter,
    onAddFundsFilterChange, onWithdrawalFilterChange, onSearch, onProcessWithdrawal,
    onProcessAddFunds, onViewScreenshot, onScreenshotSeen, onLoadMore,
  } = props;
  const now = useNow();
  const sortedAddFunds = useMemo(() => sortForReview(addFundsRequests), [addFundsRequests]);
  const sortedWithdrawals = useMemo(() => sortForReview(withdrawals), [withdrawals]);
  const thumbnailPaths = useMemo(
    () => sortedAddFunds.flatMap((request) => (
      request.screenshot_path && !request.screenshot_removed_at ? [request.screenshot_path] : []
    )),
    [sortedAddFunds],
  );
  const thumbnails = useScreenshotThumbnails(thumbnailPaths);
  const pendingAddFunds = addFundsRequests.filter((request) => request.status === 'pending').length;
  const pendingWithdrawals = withdrawals.filter((request) => request.status === 'pending').length;

  const openReject = (id: string, kind: 'withdrawal' | 'addFunds') => setRejecting({ id, kind, reason: '' });
  const confirmReject = () => {
    if (!rejecting || rejecting.reason.trim().length < 3 || rejecting.reason.trim().length > 200) return;
    if (rejecting.kind === 'withdrawal') onProcessWithdrawal(rejecting.id, 'rejected', rejecting.reason.trim());
    else onProcessAddFunds(rejecting.id, 'rejected', rejecting.reason.trim());
    setRejecting(null);
  };

  return (
    <section className="space-y-8 animate-fade-in">
      {message && (
        <Alert tone={message.kind === 'ok' ? 'success' : 'error'} details={message.raw}>{message.text}</Alert>
      )}

      <div>
        <SectionTitle icon={<Plus className="h-4 w-4" aria-hidden="true" />} action={pendingAddFunds > 0 ? <Badge tone="warning">{pendingAddFunds} pending</Badge> : undefined}>
          Add-money requests
        </SectionTitle>
        <RequestFilters filter={addFundsFilter} onChange={onAddFundsFilterChange} onSearch={() => onSearch('addFunds')} searchPlaceholder="Search name or UTR" />
        {loading ? <ListSkeleton rows={3} /> : sortedAddFunds.length === 0 ? (
          <Empty icon={<Plus className="mx-auto mb-2 h-5 w-5 text-ink-muted" />} text="No add-money requests match these filters." />
        ) : (
          <div className="space-y-3">
            {sortedAddFunds.map((request) => {
              const thumbnail = request.screenshot_path ? thumbnails[request.screenshot_path] : undefined;
              const screenshotRemoved = !!request.screenshot_removed_at;
              return (
                <RequestCard key={request.id} pending={request.status === 'pending'}>
                  <div className="flex gap-3">
                    {request.screenshot_path && !screenshotRemoved && (
                      <button
                        type="button"
                        onClick={() => onViewScreenshot(request.screenshot_path!)}
                        aria-label={`Open payment screenshot from ${request.user_name}`}
                        className="flex h-28 w-20 shrink-0 items-center justify-center overflow-hidden rounded-control border border-surface-strong bg-surface-raised"
                      >
                        {thumbnail ? (
                          <img
                            src={thumbnail}
                            alt=""
                            className="h-full w-full object-cover"
                            onLoad={() => onScreenshotSeen?.(request.screenshot_path!)}
                          />
                        ) : <ImageIcon className="h-5 w-5 text-ink-muted" aria-hidden="true" />}
                      </button>
                    )}
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <RequestHeader name={request.user_name} amount={request.amount} amountClass="text-brand-400" />
                      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                        <span className="break-all">UTR <span className="font-mono text-ink-strong">{request.payment_ref}</span></span>
                        <CopyButton value={request.payment_ref} label="UTR" />
                      </div>
                      <RequestMeta request={request} now={now} />
                      {screenshotRemoved
                        ? <p className="text-xs text-ink-muted">Screenshot deleted 30 days after this request was settled</p>
                        : !request.screenshot_path && <p className="text-xs text-amber-300">No screenshot attached</p>}
                    </div>
                  </div>
                  {request.status === 'pending' ? (
                    <ActionRow
                      busy={processingId === request.id}
                      approveLabel="Approve & credit"
                      rejectLabel="Reject"
                      onApprove={() => onProcessAddFunds(request.id, 'approved')}
                      onReject={() => openReject(request.id, 'addFunds')}
                    />
                  ) : <ProcessedStatus status={request.status} reason={request.reject_reason} />}
                  {rejecting?.id === request.id && rejecting.kind === 'addFunds' && (
                    <RejectReasonForm value={rejecting.reason} onChange={(reason) => setRejecting({ ...rejecting, reason })} onCancel={() => setRejecting(null)} onConfirm={confirmReject} disabled={processingId === request.id} />
                  )}
                </RequestCard>
              );
            })}
          </div>
        )}
        {hasMoreAddFunds && <LoadMore loading={loadingMore} label="Load more add-money requests" onClick={() => onLoadMore('addFunds')} />}
      </div>

      <div>
        <SectionTitle icon={<Wallet className="h-4 w-4" aria-hidden="true" />} action={pendingWithdrawals > 0 ? <Badge tone="warning">{pendingWithdrawals} pending</Badge> : undefined}>
          Withdrawal requests
        </SectionTitle>
        <RequestFilters filter={withdrawalFilter} onChange={onWithdrawalFilterChange} onSearch={() => onSearch('withdrawals')} searchPlaceholder="Search by name" />
        {loading ? <ListSkeleton rows={3} /> : sortedWithdrawals.length === 0 ? (
          <Empty icon={<Wallet className="mx-auto mb-2 h-5 w-5 text-ink-muted" />} text="No withdrawal requests match these filters." />
        ) : (
          <div className="space-y-3">
            {sortedWithdrawals.map((request) => (
              <RequestCard key={request.id} pending={request.status === 'pending'}>
                <div className="space-y-1.5">
                  <RequestHeader name={request.user_name} amount={request.amount} amountClass="text-ink-strong" />
                  <RequestMeta request={request} now={now} />
                </div>
                {request.status === 'pending' && (
                  <div className="mt-3 grid grid-cols-1 gap-2 rounded-control border border-surface-border bg-surface-page/60 p-3 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-ink-muted">UPI ID</p>
                        <p className="break-all font-mono text-sm text-ink-strong">{request.upi_id}</p>
                      </div>
                      <CopyButton value={request.upi_id} label="UPI ID" />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs text-ink-muted">Amount</p>
                        <p className="font-mono text-sm text-ink-strong">{request.amount}</p>
                      </div>
                      <CopyButton value={String(request.amount)} label="amount" />
                    </div>
                  </div>
                )}
                {request.status !== 'pending' && <p className="mt-1 break-all text-sm text-ink-muted">UPI {request.upi_id}</p>}
                {request.status === 'pending' ? (
                  <ActionRow
                    busy={processingId === request.id}
                    approveLabel="I've paid · Approve"
                    rejectLabel="Reject (refund)"
                    onApprove={() => onProcessWithdrawal(request.id, 'approved')}
                    onReject={() => openReject(request.id, 'withdrawal')}
                  />
                ) : <ProcessedStatus status={request.status} reason={request.reject_reason} />}
                {rejecting?.id === request.id && rejecting.kind === 'withdrawal' && (
                  <RejectReasonForm value={rejecting.reason} onChange={(reason) => setRejecting({ ...rejecting, reason })} onCancel={() => setRejecting(null)} onConfirm={confirmReject} disabled={processingId === request.id} />
                )}
              </RequestCard>
            ))}
          </div>
        )}
        {hasMoreWithdrawals && <LoadMore loading={loadingMore} label="Load more withdrawals" onClick={() => onLoadMore('withdrawals')} />}
      </div>
    </section>
  );
}

function RequestCard({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <article className={`rounded-card border p-4 ${pending ? 'border-surface-strong bg-surface/90' : 'border-surface-border bg-surface/50'}`}>
      {children}
    </article>
  );
}

function RequestHeader({ name, amount, amountClass }: { name: string; amount: number; amountClass: string }) {
  const { formatNumber } = useFormat();
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="flex min-w-0 items-center gap-1.5 text-base font-semibold text-ink-strong">
        <User className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="truncate">{name || 'Unnamed'}</span>
      </p>
      <p className={`shrink-0 text-xl font-bold ${amountClass}`}>₹{formatNumber(amount)}</p>
    </div>
  );
}

function RequestMeta({ request, now }: { request: { status: string; created_at: string }; now: number }) {
  const { formatDate } = useFormat();
  const submitted = formatDate(request.created_at, { dateStyle: 'medium', timeStyle: 'short' });
  if (request.status !== 'pending') return <p className="text-xs text-ink-muted">{submitted}</p>;
  const tone = waitingTone(request.created_at, now);
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <Badge tone={tone === 'late' ? 'danger' : tone === 'warning' ? 'warning' : 'neutral'} icon={<Clock className="h-3 w-3" aria-hidden="true" />}>
        Waiting {formatWaiting(request.created_at, now)}
      </Badge>
      {submitted}
    </p>
  );
}

function ActionRow({ busy, approveLabel, rejectLabel, onApprove, onReject }: {
  busy: boolean;
  approveLabel: string;
  rejectLabel: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  // Reject sits on the left and Approve on the right, with a clear gap, so a
  // slip of the thumb does not hit the other money action.
  return (
    <div className="mt-4 grid grid-cols-2 gap-4">
      <Button size="lg" variant="danger" disabled={busy} onClick={onReject}>{rejectLabel}</Button>
      <Button size="lg" loading={busy} onClick={onApprove}>{approveLabel}</Button>
    </div>
  );
}

function ProcessedStatus({ status, reason }: { status: string; reason: string | null }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={status === 'approved' ? 'success' : 'danger'}>{status}</Badge>
      {reason && <span className="text-ink-muted">{reason}</span>}
    </p>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.show(`Copied ${label}`, 'success');
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.show(`Couldn't copy ${label}. Select it and copy manually.`, 'error');
    }
  };
  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      aria-label={`Copy ${label}`}
      className="tap-target shrink-0 gap-1 rounded-control border border-surface-strong px-3 text-xs font-semibold text-ink-soft hover:bg-surface-raised"
    >
      {copied ? <Check className="h-4 w-4 text-brand-400" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function RequestFilters({ filter, onChange, onSearch, searchPlaceholder }: {
  filter: AdminListFilter;
  onChange: (filter: AdminListFilter) => void;
  onSearch: () => void;
  searchPlaceholder: string;
}) {
  const input = 'min-h-tap w-full rounded-control border border-surface-strong bg-surface-raised px-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';
  return (
    <details className="mb-3 rounded-card border border-surface-border bg-surface/60">
      <summary className="flex min-h-tap cursor-pointer items-center gap-2 px-4 text-sm text-ink-soft">
        <Search className="h-4 w-4" aria-hidden="true" />
        Filters · {filter.status || 'all statuses'}{filter.search ? ` · “${filter.search}”` : ''}
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t border-surface-border p-4 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">Status
          <select value={filter.status} onChange={(event) => onChange({ ...filter, status: event.target.value })} className={`mt-1 ${input}`}>
            <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
          </select>
        </label>
        <label className="text-xs text-ink-muted">Search
          <input value={filter.search} onChange={(event) => onChange({ ...filter, search: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') onSearch(); }} placeholder={searchPlaceholder} className={`mt-1 ${input}`} />
        </label>
        <label className="text-xs text-ink-muted">From (IST)<input type="date" value={filter.from} onChange={(event) => onChange({ ...filter, from: event.target.value })} className={`mt-1 ${input}`} /></label>
        <label className="text-xs text-ink-muted">To (IST)<input type="date" value={filter.to} onChange={(event) => onChange({ ...filter, to: event.target.value })} className={`mt-1 ${input}`} /></label>
        <Button variant="secondary" className="sm:col-span-2" onClick={onSearch}>Apply filters</Button>
      </div>
    </details>
  );
}

function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="rounded-card border border-dashed border-surface-border px-4 py-8 text-center">{icon}<p className="text-sm text-ink-muted">{text}</p></div>;
}

function LoadMore({ loading, label, onClick }: { loading: boolean; label: string; onClick: () => void }) {
  return <Button variant="ghost" fullWidth className="mt-3" loading={loading} onClick={onClick}>{label}</Button>;
}

function RejectReasonForm({ value, onChange, onCancel, onConfirm, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 space-y-3 rounded-control border border-rose-900 bg-rose-950/20 p-3">
      <label className="block text-sm text-ink-soft">
        Rejection reason (3–200 characters, shown to the player)
        <textarea value={value} maxLength={200} onChange={(event) => onChange(event.target.value)} rows={2} autoFocus className="mt-1 w-full resize-y rounded-control border border-surface-strong bg-surface-raised p-3 text-sm text-ink-strong focus:border-rose-400 focus:outline-none" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={disabled || value.trim().length < 3}>Confirm rejection</Button>
      </div>
    </div>
  );
}
