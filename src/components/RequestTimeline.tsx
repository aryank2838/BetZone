import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { UserRequest } from '@/lib/useUserRequests';
import { useFormat } from '@/i18n/useFormat';
import { useT } from '@/i18n/useT';
import Alert from '@/components/ui/Alert';
import Badge from '@/components/ui/Badge';
import { SectionTitle } from '@/components/ui/Card';

interface RequestTimelineProps {
  requests: UserRequest[];
  error: { message: string; raw?: string } | null;
}

export default function RequestTimeline({ requests, error }: RequestTimelineProps) {
  const { formatNumber, formatDate } = useFormat();
  const { t } = useT();
  return (
    <section aria-labelledby="requests-title">
      <SectionTitle id="requests-title">{t('requests.title')}</SectionTitle>
      {error && <Alert details={error.raw} className="mb-3">{error.message}</Alert>}
      {requests.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('requests.empty')}</p>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => {
            const rejected = request.status === 'rejected';
            const approved = request.status === 'approved';
            const statusColor = rejected ? 'text-rose-300' : approved ? 'text-brand-300' : 'text-amber-300';
            return (
              <article key={`${request.kind}:${request.id}`} className="rounded-card border border-surface-border bg-surface/80 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-strong">
                      {request.kind === 'deposit' ? t('requests.deposit') : t('requests.withdrawal')} · ₹{formatNumber(request.amount)}
                    </p>
                    <p className="text-xs text-ink-muted">{formatDate(request.created_at)}</p>
                  </div>
                  <Badge tone={rejected ? 'danger' : approved ? 'success' : 'warning'}>
                    {rejected ? t('requests.rejected') : approved ? t('requests.done') : t('requests.checking')}
                  </Badge>
                </div>
                <ol className="grid grid-cols-3 gap-2 text-xs">
                  <li className="flex items-center gap-1.5 text-brand-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> {t('requests.stepSent')}
                  </li>
                  <li className={`flex items-center gap-1.5 ${request.status === 'pending' ? 'text-amber-300' : 'text-ink-muted'}`}>
                    {request.status === 'pending'
                      ? <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                      : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    {t('requests.stepChecking')}
                  </li>
                  <li className={`flex items-center gap-1.5 ${statusColor}`}>
                    {rejected ? <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      : approved ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                        : <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    {rejected ? t('requests.rejected') : approved ? t('requests.done') : t('requests.stepDecision')}
                  </li>
                </ol>
                {request.processed_at && (
                  <p className="mt-2 text-xs text-ink-muted">{rejected ? t('requests.rejectedOn') : t('requests.processedOn')} {formatDate(request.processed_at)}</p>
                )}
                {rejected && request.reject_reason && (
                  <p className="mt-2 rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-200">
                    {t('requests.reason')}: {request.reject_reason}
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
