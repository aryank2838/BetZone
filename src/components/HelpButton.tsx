import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { useDialogA11y } from '@/lib/useDialogA11y';
import { useFormat } from '@/i18n/useFormat';
import { useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';
import { isUuid } from '@/lib/uuid';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { useToast } from '@/components/ui/toastContext';

interface Ticket {
  id: string;
  category: string;
  request_ref: string | null;
  message: string;
  status: string;
  admin_note: string | null;
  created_at: string;
  closed_at: string | null;
}

const CATEGORIES: { id: string; label: TranslationKey }[] = [
  { id: 'deposit', label: 'help.catDeposit' },
  { id: 'withdrawal', label: 'help.catWithdrawal' },
  { id: 'bet', label: 'help.catBet' },
  { id: 'account', label: 'help.catAccount' },
  { id: 'other', label: 'help.catOther' },
];

const FIELD = 'w-full rounded-control border bg-surface-raised p-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';

export default function HelpButton({ variant = 'icon' }: { variant?: 'icon' | 'row' }) {
  const { formatDate } = useFormat();
  const { t } = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDialogA11y(open, dialogRef, close);
  const [whatsapp, setWhatsapp] = useState('');
  const [email, setEmail] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [category, setCategory] = useState('other');
  const [requestRef, setRequestRef] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [wa, em, rows] = await Promise.all([
      supabase.rpc('get_app_setting', { p_key: 'support_whatsapp' }),
      supabase.rpc('get_app_setting', { p_key: 'support_email' }),
      supabase.from('support_tickets').select('id, category, request_ref, message, status, admin_note, created_at, closed_at').order('created_at', { ascending: false }).limit(50),
    ]);
    const loadError = wa.error ?? em.error ?? rows.error;
    if (loadError) {
      const friendly = friendlyErrorDetails(loadError);
      setError({ text: friendly.message, raw: friendly.raw });
      return;
    }
    setWhatsapp(typeof wa.data === 'string' ? wa.data : '');
    setEmail(typeof em.data === 'string' ? em.data : '');
    setTickets((rows.data ?? []) as Ticket[]);
  };
  useEffect(() => { if (open) void load(); }, [open]);

  const requestRefInvalid = requestRef.trim() !== '' && !isUuid(requestRef);
  const submit = async () => {
    if (requestRefInvalid) {
      setError({ text: t('help.refInvalid') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('submit_support_ticket', {
        p_category: category,
        p_request_ref: requestRef.trim() || null,
        p_message: message.trim(),
      });
      if (rpcError) throw rpcError;
      setMessage('');
      setRequestRef('');
      toast.show(t('help.submitted'));
      await load();
    } catch (caught) {
      const friendly = friendlyErrorDetails(caught);
      setError({ text: friendly.message, raw: friendly.raw });
    } finally {
      setBusy(false);
    }
  };

  const categoryLabel = (id: string) => {
    const found = CATEGORIES.find((item) => item.id === id);
    return found ? t(found.label) : id;
  };

  return (
    <>
      {variant === 'row' ? (
        <button type="button" onClick={() => setOpen(true)} className="flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-sm text-ink-soft hover:bg-surface-raised/50">
          <HelpCircle className="h-4 w-4 text-ink-muted" aria-hidden="true" />
          <span className="flex-1">{t('help.title')}</span>
          <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} aria-label={t('help.title')} className="tap-target rounded-control border border-surface-strong text-ink-soft hover:bg-surface-raised">
          <HelpCircle className="h-4 w-4" />
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 sm:items-center" onClick={() => setOpen(false)}>
          <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="help-title" className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-card border border-surface-border bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-ink sm:rounded-card" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center justify-between">
              <h2 id="help-title" className="text-lg font-bold text-ink-strong">{t('help.title')}</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')} className="tap-target -mr-2 rounded-lg"><X className="h-5 w-5 text-ink-muted" /></button>
            </header>
            <div className="flex flex-wrap gap-3 text-sm">
              {whatsapp && <a className="text-brand-300 underline" href={`https://wa.me/${whatsapp.replace(/^\+/, '')}`} target="_blank" rel="noreferrer">WhatsApp: {whatsapp}</a>}
              {email && <a className="text-accent-300 underline" href={`mailto:${email}`}>{t('help.email')}: {email}</a>}
              {!whatsapp && !email && <p className="text-sm text-ink-muted">{t('help.noContacts')}</p>}
            </div>
            <div className="space-y-3 border-t border-surface-border pt-4">
              <h3 className="text-sm font-semibold text-ink-strong">{t('help.report')}</h3>
              <label className="block text-xs text-ink-muted">
                {t('help.category')}
                <select value={category} onChange={(event) => setCategory(event.target.value)} className={`${FIELD} mt-1.5 border-surface-strong`}>
                  {CATEGORIES.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
                </select>
              </label>
              <input value={requestRef} onChange={(event) => setRequestRef(event.target.value)} placeholder={t('help.refPlaceholder')} aria-label={t('help.refPlaceholder')} aria-invalid={requestRefInvalid} aria-describedby={requestRefInvalid ? 'help-request-ref-error' : undefined} className={`${FIELD} ${requestRefInvalid ? 'border-rose-500' : 'border-surface-strong'}`} />
              {requestRefInvalid && <p id="help-request-ref-error" className="text-xs text-rose-300">{t('help.refShort')}</p>}
              <textarea value={message} maxLength={1000} rows={3} onChange={(event) => setMessage(event.target.value)} placeholder={t('help.messagePlaceholder')} aria-label={t('help.messagePlaceholder')} className={`${FIELD} border-surface-strong`} />
              {error && <Alert details={error.raw}>{error.text}</Alert>}
              <Button fullWidth loading={busy} disabled={message.trim().length < 5 || requestRefInvalid} onClick={() => void submit()}>{t('help.submit')}</Button>
            </div>
            <div className="space-y-2 border-t border-surface-border pt-4">
              <h3 className="text-sm font-semibold text-ink-strong">{t('help.yourReports')}</h3>
              {tickets.length === 0 ? <p className="text-sm text-ink-muted">{t('help.noReports')}</p> : tickets.map((ticket) => (
                <article key={ticket.id} className="rounded-control border border-surface-border bg-surface-page/60 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink-soft">{categoryLabel(ticket.category)}</span>
                    <Badge tone={ticket.status === 'open' ? 'warning' : 'success'}>{ticket.status === 'open' ? t('help.statusOpen') : t('help.statusClosed')}</Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-ink-muted">{ticket.message}</p>
                  {ticket.request_ref && <p className="mt-1 break-all text-xs text-ink-muted">{t('help.request')}: {ticket.request_ref}</p>}
                  {ticket.admin_note && <p className="mt-2 text-accent-300">{t('help.supportNote')}: {ticket.admin_note}</p>}
                  <p className="mt-1 text-xs text-ink-muted">{formatDate(ticket.created_at, { dateStyle: 'medium', timeStyle: 'short' })}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
