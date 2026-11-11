import { useCallback, useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';

interface Ticket {
  id: string;
  user_id: string;
  user_name: string;
  category: string;
  request_ref: string | null;
  message: string;
  status: string;
  admin_note: string | null;
  created_at: string;
  closed_at: string | null;
}

export default function SupportTab() {
  const { formatDate } = useFormat();
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (nextStatus: 'open' | 'closed', nextOffset: number, append: boolean) => {
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc('admin_list_support_tickets', {
      p_status: nextStatus, p_limit: 30, p_offset: nextOffset,
    });
    if (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
    } else {
      const rows = (data ?? []) as Ticket[];
      setTickets((previous) => append ? [...previous, ...rows] : rows);
      setHasMore(rows.length === 30);
      setOffset(nextOffset);
      setError('');
    }
    setBusy(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => { void load(status, 0, false); }, [status, load]);

  const close = async (id: string) => {
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('admin_close_ticket', {
      p_id: id, p_note: note[id]?.trim() || null,
    });
    if (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      setBusy(false);
      return;
    }
    setNote((previous) => ({ ...previous, [id]: '' }));
    await load(status, 0, false);
  };

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2"><LifeBuoy className="h-4 w-4 text-cyan-400" /><h2 className="text-sm font-semibold">Support tickets</h2></div>
        <select value={status} onChange={(event) => setStatus(event.target.value as 'open' | 'closed')} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs">
          <option value="open">Open</option><option value="closed">Closed</option>
        </select>
      </header>
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {busy && tickets.length === 0 ? <ListSkeleton rows={3} /> :
        tickets.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">No {status} tickets.</p> :
          <div className="space-y-3">
            {tickets.map((ticket) => <article key={ticket.id} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-white">{ticket.user_name} · <span className="capitalize">{ticket.category}</span></p>
                <p className="text-xs text-slate-400">{formatDate(ticket.created_at, { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-300">{ticket.message}</p>
              {ticket.request_ref && <p className="break-all text-xs text-cyan-300">Request: {ticket.request_ref}</p>}
              {ticket.status === 'open' ? <>
                <textarea value={note[ticket.id] ?? ''} maxLength={1000} rows={2} onChange={(event) => setNote((previous) => ({ ...previous, [ticket.id]: event.target.value }))} placeholder="Optional note for user" className="w-full rounded-lg border border-slate-700 bg-slate-800 p-2.5 text-sm" />
                <button type="button" disabled={busy} onClick={() => void close(ticket.id)} className="rounded-lg bg-cyan-700 px-4 py-2 text-xs font-medium text-white disabled:opacity-40">Close ticket</button>
              </> : <>
                <p className="text-xs text-emerald-300">Closed {ticket.closed_at ? formatDate(ticket.closed_at, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</p>
                {ticket.admin_note && <p className="text-xs text-slate-400">Note: {ticket.admin_note}</p>}
              </>}
            </article>)}
          </div>}
      {hasMore && <button type="button" disabled={loadingMore || busy} onClick={() => { setLoadingMore(true); void load(status, offset + 30, true); }} className="w-full rounded-lg border border-slate-700 py-2.5 text-xs text-slate-300 disabled:opacity-40">{loadingMore ? 'Loading…' : 'Load more'}</button>}
    </section>
  );
}
