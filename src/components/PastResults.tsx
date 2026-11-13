import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Game } from '@/types';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { ChevronDown, Trophy } from 'lucide-react';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { buttonClasses } from '@/components/ui/buttonClasses';
import { formatHolidayDate } from '@/lib/holiday';
import { useT } from '@/i18n/useT';
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
  const { t } = useT();
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
    <section className="border-t border-surface-border bg-surface-page/40">
      <button type="button" onClick={toggle} aria-expanded={expanded} className="flex min-h-tap w-full items-center justify-between px-5 py-3 text-left hover:bg-surface-raised/40">
        <span className="flex items-center gap-2 text-sm font-medium text-ink-soft">
          <Trophy className="h-4 w-4 text-amber-400" aria-hidden="true" /> {t('results.past')}
        </span>
        <ChevronDown className={`h-4 w-4 text-ink-muted transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="border-t border-surface-border px-5 py-3">
          {loading && <ListSkeleton rows={2} />}
          {message && <Alert details={details} onRetry={() => void load(rows.length > 0)}>{message}</Alert>}
          {!loading && !message && rows.length === 0 && (
            <div className="py-3 text-center">
              <p className="text-sm text-ink-muted">{t('results.none')}</p>
              <button type="button" onClick={() => void load(false)} className={buttonClasses({ variant: 'secondary', className: 'mt-2' })}>{t('results.checkAgain')}</button>
            </div>
          )}
          {rows.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1.5 font-medium">{t('results.date')}</th>
                  <th scope="col" className="py-1.5 text-center font-medium">{t('results.result')}</th>
                  <th scope="col" className="py-1.5 text-right font-medium">{t('results.jodi')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border/80">
                {rows.map((row) => (
                  <tr key={row.round_date}>
                    <td className="py-2.5 text-ink-muted">{formatHolidayDate(row.round_date)}</td>
                    <td className="py-2.5 text-center font-semibold tabular-nums">
                      <span className="text-ink-muted">{row.open_patti ?? '---'}</span>{' '}
                      <span className="text-brand-400">{row.open_digit ?? '-'}</span>
                      <span className="text-accent-400">{row.close_digit ?? '-'}</span>{' '}
                      <span className="text-ink-muted">{row.close_patti ?? '---'}</span>
                    </td>
                    <td className="py-2.5 text-right font-semibold tabular-nums text-ink-soft">{row.jodi ?? t('results.pending')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {hasMore && rows.length > 0 && (
            <Button variant="secondary" fullWidth className="mt-3" onClick={() => void load(true)} loading={loading}>
              {t('common.loadMore')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
