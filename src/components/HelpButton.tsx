import { useCallback, useEffect, useRef, useState } from 'react';
import { HelpCircle, Loader2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { useDialogA11y } from '@/lib/useDialogA11y';
import { useFormat } from '@/i18n/useFormat';
import { isUuid } from '@/lib/uuid';

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

export default function HelpButton() {
  const { formatDate } = useFormat();
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
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [wa, em, rows] = await Promise.all([
      supabase.rpc('get_app_setting', { p_key: 'support_whatsapp' }),
      supabase.rpc('get_app_setting', { p_key: 'support_email' }),
      supabase.from('support_tickets').select('id, category, request_ref, message, status, admin_note, created_at, closed_at').order('created_at', { ascending: false }).limit(50),
    ]);
    const error = wa.error ?? em.error ?? rows.error;
    if (error) {
      const friendly = friendlyErrorDetails(error);
      setNotice(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
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
      setNotice('The related request ID must be a full request ID (for example 0f8fad5b-d9cb-469f-a165-70867728950e), or leave it empty.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const { error } = await supabase.rpc('submit_support_ticket', {
        p_category: category,
        p_request_ref: requestRef.trim() || null,
        p_message: message.trim(),
      });
      if (error) throw error;
      setMessage('');
      setRequestRef('');
      setNotice('Report submitted. You can follow its status below.');
      await load();
    } catch (error) {
      const friendly = friendlyErrorDetails(error);
      setNotice(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Help" className="tap-target rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><HelpCircle className="h-4 w-4" /></button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 sm:items-center" onClick={() => setOpen(false)}>
          <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="help-title" className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl border border-slate-800 bg-slate-900 p-5 pb-[env(safe-area-inset-bottom)] sm:rounded-2xl" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center justify-between"><h2 id="help-title" className="font-bold">Help & support</h2><button type="button" onClick={() => setOpen(false)} aria-label="Close help" className="tap-target"><X className="h-5 w-5 text-slate-400" /></button></header>
            <div className="flex flex-wrap gap-3 text-sm">
              {whatsapp && <a className="text-emerald-300 underline" href={`https://wa.me/${whatsapp.replace(/^\+/, '')}`} target="_blank" rel="noreferrer">WhatsApp: {whatsapp}</a>}
              {email && <a className="text-cyan-300 underline" href={`mailto:${email}`}>Email: {email}</a>}
              {!whatsapp && !email && <p className="text-xs text-slate-400">Support contacts are not configured. You can still submit a report below.</p>}
            </div>
            <div className="space-y-2 border-t border-slate-800 pt-4">
              <h3 className="text-sm font-semibold">Report a problem</h3>
              <select value={category} onChange={(event) => setCategory(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-sm">
                {['deposit', 'withdrawal', 'bet', 'account', 'other'].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <input value={requestRef} onChange={(event) => setRequestRef(event.target.value)} placeholder="Related request ID (optional)" aria-label="Related request ID (optional)" aria-invalid={requestRefInvalid} aria-describedby={requestRefInvalid ? 'help-request-ref-error' : undefined} className={`w-full rounded-lg border bg-slate-800 p-2.5 text-sm ${requestRefInvalid ? 'border-rose-500' : 'border-slate-700'}`} />
              {requestRefInvalid && <p id="help-request-ref-error" className="text-xs text-rose-300">Enter a full request ID or leave this empty.</p>}
              <textarea value={message} maxLength={1000} rows={3} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the problem (5–1000 characters)" className="w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-sm" />
              <button type="button" disabled={busy || message.trim().length < 5 || requestRefInvalid} onClick={() => void submit()} className="w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold disabled:opacity-40">{busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Submit report'}</button>
            </div>
            {notice && <p role="status" className="text-xs text-slate-300">{notice}</p>}
            <div className="space-y-2 border-t border-slate-800 pt-4">
              <h3 className="text-sm font-semibold">Your reports</h3>
              {tickets.length === 0 ? <p className="text-xs text-slate-400">No reports yet.</p> : tickets.map((ticket) => <article key={ticket.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
                <div className="flex justify-between"><span className="capitalize text-slate-200">{ticket.category}</span><span className={ticket.status === 'open' ? 'text-amber-300' : 'text-emerald-300'}>{ticket.status}</span></div>
                <p className="mt-1 whitespace-pre-wrap text-slate-400">{ticket.message}</p>
                {ticket.request_ref && <p className="mt-1 text-slate-400">Request: {ticket.request_ref}</p>}
                {ticket.admin_note && <p className="mt-2 text-cyan-300">Support note: {ticket.admin_note}</p>}
                <p className="mt-1 text-slate-400">{formatDate(ticket.created_at, { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </article>)}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
