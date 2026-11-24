import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, CalendarDays, Info } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { GAME_LABELS, type Game } from '@/types';
import { friendlyErrorDetails } from '@/lib/errors';
import { gameLook } from '@/lib/gameLook';
import { digitCounts, digitGaps, hotJodis, isDoubleJodi, weeklyChart, type ResultRow } from '@/lib/resultStats';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import { Card, SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';
import { interpolate, useT } from '@/i18n/useT';
import { localeFor } from '@/i18n/context';

/** The most results get_result_history returns in one call. */
const HISTORY_SIZE = 100;
const WINDOWS = [30, 60, 100] as const;
type ChartTab = 'jodi' | 'stats';
/** Columns in the jodi chart: Monday to Saturday. */
const CHART_DAYS = 6;

export default function ResultsChartPage({ game, onBack }: { game: Game; onBack: () => void }) {
  const { t, language } = useT();
  const locale = localeFor(language);
  const name = GAME_LABELS[game] ?? game;
  const { color, Icon } = gameLook(game);
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<{ message: string; raw?: string } | null>(null);
  const [tab, setTab] = useState<ChartTab>('jodi');
  const [windowSize, setWindowSize] = useState<(typeof WINDOWS)[number]>(30);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setError(null);
    setRows(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_result_history', { p_game: game, p_limit: HISTORY_SIZE, p_offset: 0 });
      if (current !== requestId.current) return;
      if (rpcError) throw rpcError;
      setRows((data as ResultRow[] | null) ?? []);
    } catch (err) {
      if (current !== requestId.current) return;
      const friendly = friendlyErrorDetails(err);
      setError({ message: friendly.message, raw: friendly.raw });
      setRows([]);
    }
  }, [game]);

  useEffect(() => { void load(); }, [load]);

  // Monday to Saturday: no game has results on Sunday.
  const weekdays = useMemo(() => Array.from({ length: CHART_DAYS }, (_, index) =>
    // 2026-11-16 is a Monday.
    new Date(Date.UTC(2026, 10, 16 + index)).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })), [locale]);

  return (
    <div className="min-h-screen bg-surface-page">
      <PageHeader
        title={interpolate(t('chart.title'), { game: name })}
        subtitle={t('chart.subtitle')}
        onBack={onBack}
        leading={(
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border" style={{ color, backgroundColor: `${color}26`, borderColor: `${color}66` }} aria-hidden="true">
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
      />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-5 sm:px-5">
        <div className="grid grid-cols-2 gap-2 rounded-control border border-surface-border bg-surface/60 p-1" role="tablist" aria-label={t('chart.subtitle')}>
          {([['jodi', 'chart.tabJodi', CalendarDays], ['stats', 'chart.tabStats', BarChart3]] as const).map(([value, label, TabIcon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`flex min-h-tap items-center justify-center gap-2 rounded-[10px] text-sm font-semibold transition-colors ${tab === value ? 'bg-brand-700 text-ink-strong' : 'text-ink-muted hover:text-ink-soft'}`}
            >
              <TabIcon className="h-4 w-4" aria-hidden="true" /> {t(label)}
            </button>
          ))}
        </div>

        {error && <Alert details={error.raw} onRetry={() => void load()}>{error.message}</Alert>}
        {rows === null && <ListSkeleton rows={3} />}
        {rows && !error && rows.length === 0 && (
          <p className="rounded-card border border-dashed border-surface-strong px-4 py-8 text-center text-sm text-ink-muted">{t('chart.empty')}</p>
        )}

        {rows && rows.length > 0 && tab === 'jodi' && <JodiChart rows={rows} weekdays={weekdays} locale={locale} />}
        {rows && rows.length > 0 && tab === 'stats' && (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('chart.windowLabel')}>
              {WINDOWS.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={windowSize === size}
                  onClick={() => setWindowSize(size)}
                  className={`min-h-[36px] rounded-full border px-3.5 text-[13px] font-medium ${windowSize === size
                    ? 'border-brand-500 bg-brand-700 text-ink-strong'
                    : 'border-surface-strong bg-surface-raised text-ink-soft hover:bg-surface-strong'}`}
                >
                  {interpolate(t('chart.lastN'), { count: String(size) })}
                </button>
              ))}
            </div>
            <NumberStats rows={rows.slice(0, windowSize)} />
          </>
        )}

        <p className="flex items-start gap-2 px-1 text-xs text-ink-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {t('chart.disclaimer')}
        </p>
      </main>
    </div>
  );
}

function JodiChart({ rows, weekdays, locale }: { rows: ResultRow[]; weekdays: string[]; locale: string }) {
  const { t } = useT();
  const weeks = useMemo(() => weeklyChart(rows), [rows]);
  const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const addDays = (iso: string, days: number) => {
    const date = new Date(`${iso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };

  return (
    <Card className="!p-2 sm:!p-4">
      {/* Fixed layout: six equal columns that always fit the screen, no sideways scroll. */}
      <table className="w-full table-fixed border-separate border-spacing-[3px] text-center tabular-nums sm:border-spacing-1">
        <caption className="sr-only">{t('chart.tabJodi')}</caption>
        <thead>
          <tr className="text-[11px] font-semibold uppercase text-ink-muted">
            {weekdays.map((day) => <th key={day} scope="col" className="py-1 font-semibold">{day}</th>)}
          </tr>
        </thead>
        {weeks.map((week) => (
          <tbody key={week.start}>
            <tr>
              <th scope="colgroup" colSpan={CHART_DAYS} className="px-1 pb-0.5 pt-2 text-left text-xs font-semibold text-ink-soft">
                {shortDate(week.start)} – {shortDate(addDays(week.start, CHART_DAYS - 1))}
              </th>
            </tr>
            <tr>
              {week.days.slice(0, CHART_DAYS).map((day, index) => <ChartCell key={index} day={day} label={day ? shortDate(day.round_date) : ''} />)}
            </tr>
          </tbody>
        ))}
      </table>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-ink-muted">
        <span>{t('chart.pattiNote')}</span>
      </p>
      <p className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-ink-muted">
        <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-900 ring-1 ring-rose-700" aria-hidden="true" /> {t('chart.doubleNote')}
      </p>
    </Card>
  );
}

/** A patti read top to bottom, e.g. 1-2-5 stacked. Keeps its width when empty so jodis line up. */
function StackedPatti({ patti }: { patti: string | null }) {
  return (
    <span className="flex w-[7px] flex-col text-[10px] font-semibold leading-[1.15] text-ink-muted sm:w-2.5 sm:text-xs" aria-hidden="true">
      {(patti ?? '   ').split('').map((digit, index) => <span key={index}>{digit.trim() || ' '}</span>)}
    </span>
  );
}

function ChartCell({ day, label }: { day: ResultRow | null; label: string }) {
  if (!day) {
    return <td className="h-12 rounded-md bg-surface-page/40 text-surface-strong sm:h-14">·</td>;
  }
  const double = isDoubleJodi(day.jodi);
  const spoken = `${label}: ${day.open_patti ?? '***'} ${day.open_digit ?? '*'}${day.close_digit ?? '*'} ${day.close_patti ?? '***'}`;
  return (
    <td
      title={spoken}
      aria-label={spoken}
      className={`h-12 rounded-md px-0.5 sm:h-14 ${double ? 'bg-rose-950/60 ring-1 ring-rose-800/70' : 'bg-surface-raised/70'}`}
    >
      <div className="flex items-center justify-between">
        <StackedPatti patti={day.open_patti} />
        <span className={`text-[15px] font-extrabold leading-none sm:text-lg ${double ? 'text-rose-300' : ''}`} aria-hidden="true">
          <span className={double ? '' : 'text-brand-400'}>{day.open_digit ?? '*'}</span>
          <span className={double ? '' : day.close_digit ? 'text-accent-400' : 'text-ink-muted'}>{day.close_digit ?? '*'}</span>
        </span>
        <StackedPatti patti={day.close_patti} />
      </div>
    </td>
  );
}

function DigitBars({ title, counts, tone }: { title: string; counts: number[]; tone: 'brand' | 'accent' }) {
  const { t } = useT();
  const max = Math.max(1, ...counts);
  const top = Math.max(...counts);
  return (
    <Card className="!p-4">
      <SectionTitle>{title}</SectionTitle>
      <div className="flex h-36 items-end gap-1.5" role="list">
        {counts.map((count, digit) => {
          const hot = count > 0 && count === top;
          return (
            <div key={digit} role="listitem" aria-label={`${digit}: ${interpolate(t('chart.times'), { count: String(count) })}`} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <span className={`text-[11px] tabular-nums ${hot ? 'font-bold text-amber-300' : 'text-ink-muted'}`}>{count}</span>
              <div
                className={`w-full rounded-t-md transition-all duration-500 ${hot ? 'bg-amber-400' : tone === 'brand' ? 'bg-brand-500/70' : 'bg-accent-500/70'}`}
                style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
              />
              <span className={`text-sm font-bold tabular-nums ${tone === 'brand' ? 'text-brand-400' : 'text-accent-400'}`}>{digit}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function NumberStats({ rows }: { rows: ResultRow[] }) {
  const { t } = useT();
  const openCounts = useMemo(() => digitCounts(rows, 'open'), [rows]);
  const closeCounts = useMemo(() => digitCounts(rows, 'close'), [rows]);
  const repeats = useMemo(() => hotJodis(rows), [rows]);
  const gaps = useMemo(() => digitGaps(rows), [rows]);
  const longestGap = Math.max(...gaps.map((gap) => gap ?? -1));

  return (
    <div className="space-y-4">
      <DigitBars title={t('chart.openDigits')} counts={openCounts} tone="brand" />
      <DigitBars title={t('chart.closeDigits')} counts={closeCounts} tone="accent" />

      <Card className="!p-4">
        <SectionTitle>{t('chart.gaps')}</SectionTitle>
        <p className="-mt-1 mb-3 text-xs text-ink-muted">{t('chart.gapsHelp')}</p>
        <div className="grid grid-cols-5 gap-2">
          {gaps.map((gap, digit) => {
            const coldest = gap === null || (gap === longestGap && gap > 0);
            return (
              <div key={digit} className={`rounded-control border px-1 py-2 text-center ${coldest ? 'border-sky-800 bg-sky-950/40' : 'border-surface-border bg-surface-raised/50'}`}>
                <p className="text-lg font-extrabold tabular-nums text-ink-strong">{digit}</p>
                <p className={`text-[11px] ${coldest ? 'text-sky-300' : 'text-ink-muted'}`}>
                  {gap === null ? t('chart.notSeen') : gap === 0 ? t('chart.latest') : interpolate(t('chart.resultsAgo'), { count: String(gap) })}
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="!p-4">
        <SectionTitle>{t('chart.hotJodis')}</SectionTitle>
        {repeats.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('chart.noRepeats')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {repeats.map(({ jodi, count }) => (
              <li key={jodi} className="flex items-center gap-2 rounded-full border border-amber-800/70 bg-amber-950/40 py-1.5 pl-3 pr-2.5">
                <span className="text-base font-extrabold tabular-nums text-amber-200">{jodi}</span>
                <span className="rounded-full bg-amber-900/70 px-1.5 text-[11px] font-semibold text-amber-200">{interpolate(t('chart.times'), { count: String(count) })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
