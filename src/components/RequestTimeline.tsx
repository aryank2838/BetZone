import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { UserRequest } from '@/lib/useUserRequests';
import { useFormat } from '@/i18n/useFormat';

interface RequestTimelineProps {
  requests: UserRequest[];
  error: { message: string; raw?: string } | null;
}

export default function RequestTimeline({ requests, error }: RequestTimelineProps) {
  const { formatNumber, formatDate } = useFormat();
  return (
    <section>
      <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Requests</h3>
      {error && (
        <div className="mb-3 rounded-xl border border-rose-900 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
          <p>{error.message}</p>
          {error.raw && <p className="mt-1 text-xs text-rose-400/70">{error.raw}</p>}
        </div>
      )}
      {requests.length === 0 ? (
        <p className="text-sm text-slate-400">No deposit or withdrawal requests yet.</p>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => {
            const rejected = request.status === 'rejected';
            const approved = request.status === 'approved';
            const statusColor = rejected ? 'text-rose-400' : approved ? 'text-emerald-400' : 'text-amber-400';
            return (
              <article key={`${request.kind}:${request.id}`} className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-200">
                      {request.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} · {formatNumber(request.amount)} balance
                    </p>
                    <p className="text-xs text-slate-400">Submitted {formatDate(request.created_at)}</p>
                  </div>
                  <span className={`text-xs font-medium capitalize ${statusColor}`}>{request.status}</span>
                </div>
                <ol className="grid grid-cols-3 gap-2 text-[11px]">
                  <li className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Submitted
                  </li>
                  <li className={`flex items-center gap-1.5 ${request.status === 'pending' ? 'text-amber-300' : 'text-slate-400'}`}>
                    {request.status === 'pending'
                      ? <Clock className="h-3.5 w-3.5 shrink-0" />
                      : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                    Under review
                  </li>
                  <li className={`flex items-center gap-1.5 ${statusColor}`}>
                    {rejected ? <XCircle className="h-3.5 w-3.5 shrink-0" />
                      : approved ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        : <Clock className="h-3.5 w-3.5 shrink-0" />}
                    {rejected ? 'Rejected' : approved ? 'Approved' : 'Decision pending'}
                  </li>
                </ol>
                {request.processed_at && (
                  <p className="mt-2 text-[11px] text-slate-400">{rejected ? 'Rejected' : 'Processed'} {formatDate(request.processed_at)}</p>
                )}
                {rejected && request.reject_reason && (
                  <p className="mt-2 rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                    Reason: {request.reject_reason}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
