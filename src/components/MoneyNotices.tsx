import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { interpolate, useT } from '@/i18n/useT';
import { useNoticeText, type MoneyNotice } from '@/lib/useMoneyNotices';

/** Approved/rejected requests since the player last looked, shown on Home. */
export default function MoneyNotices({ notices, onDismiss, onOpenHistory }: {
  notices: MoneyNotice[];
  onDismiss: () => void;
  onOpenHistory: () => void;
}) {
  const { t } = useT();
  const text = useNoticeText();
  if (notices.length === 0) return null;
  return (
    <section aria-label={t('money.tabHistory')} className="space-y-2">
      {notices.slice(0, 5).map((notice) => (
        <Alert key={`${notice.kind}-${notice.id}`} tone={notice.status === 'approved' ? 'success' : 'warning'} title={text(notice)}>
          {notice.status === 'rejected' && notice.reject_reason
            ? interpolate(t('notices.reason'), { reason: notice.reject_reason })
            : undefined}
        </Alert>
      ))}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onDismiss}>{t('notices.dismiss')}</Button>
        <Button variant="ghost" onClick={onOpenHistory}>{t('money.tabHistory')}</Button>
      </div>
    </section>
  );
}
