import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Game } from '@/types';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { ChevronDown, ChevronRight, Trophy } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';

interface ResultRow {
  round_date: string;
  open_patti: string | null;
  open_digit: string | null;
  close_patti: string | null;
  close_digit: string | null;
  jodi: string | null;
}

interface PastResultsProps {
  game: Game;
}

const PAGE_SIZE = 10;

export default function PastResults({ game }: PastResultsProps) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState('');
  const requestId = useRef(0);

  const load = async (append: boolean) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setMessage('');
    setDetails('');
    try {
      const { data, error } = await supabase.rpc('get_result_history', {
        p_game: game,
        p_limit: PAGE_SIZE,
        p_offset: append ? offset : 0,
      });
      if (currentRequest !== requestId.current) return;
      if (error) {
        const friendly = friendlyError(error);
        setMessage(friendly.message);
        if (friendly.key === 'errors.generic') {
          setDetails(rawErrorMessage(error));
        }
      } else {
        const next = (data as ResultRow[] | null) ?? [];
        setRows((current) => append ? [...current, ...next] : next);
        setOffset((append ? offset : 0) + next.length);
        setHasMore(next.length === PAGE_SIZE);
      }
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      const friendly = friendlyError(error);
      setMessage(friendly.message);
      if (friendly.key === 'errors.generic') {
        setDetails(rawErrorMessage(error));
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && rows.length === 0 && !loading) void load(false);
  };

  return (
    <section className="mt-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <button type="button" onClick={toggle} aria-expanded={expanded} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Trophy className="h-4 w-4 text-amber-400" /> Past results
        </span>
        {expanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
      </button>
      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3">
          {loading && <ListSkeleton rows={2} />}
          {message && (
            <div className="text-xs text-rose-300">
              <p>{message}</p>
              {details && <p className="mt-1 text-[10px] text-rose-400/70">{details}</p>}
              <button type="button" onClick={() => void load(rows.length > 0)} className="mt-1 underline">Retry</button>
            </div>
          )}
          {!loading && !message && rows.length === 0 && (
            <div className="py-3 text-center">
              <p className="text-xs text-slate-400">No results yet.</p>
              <button type="button" onClick={() => void load(false)} className="mt-2 min-h-11 rounded-lg border border-slate-700 px-3 text-xs text-slate-300">Check again</button>
            </div>
          )}
          <div className="divide-y divide-slate-800/80">
            {rows.map((row) => (
              <div key={row.round_date} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                <span className="text-slate-400">{row.round_date}</span>
                <div className="flex items-center gap-2 font-semibold tabular-nums">
                  <span className="text-slate-400">{row.open_patti ?? '---'}</span>
                  <span className="text-emerald-400">{row.open_digit ?? '-'}</span>
                  <span className="text-cyan-400">{row.close_digit ?? '-'}</span>
                  <span className="text-slate-400">{row.close_patti ?? '---'}</span>
                </div>
                <span className="text-slate-400">Jodi {row.jodi ?? 'pending'}</span>
              </div>
            ))}
          </div>
          {hasMore && rows.length > 0 && (
            <button type="button" onClick={() => void load(true)} disabled={loading} className="mt-3 w-full rounded-lg border border-slate-700 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
              Load more
            </button>
          )}
        </div>
      )}
    </section>
  );
}
