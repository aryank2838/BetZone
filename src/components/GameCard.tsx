import { CalendarOff, ChevronRight, Clock } from 'lucide-react';
import { GAME_LABELS, type GameResult, type GameStatus } from '@/types';
import { countdownTone, formatBetWindow } from '@/lib/countdown';
import { gamePhase, type GamePhase } from '@/lib/gameState';
import { formatHolidayDate } from '@/lib/holiday';
import CountdownAnnouncement from '@/components/CountdownAnnouncement';
import PastResults from '@/components/PastResults';
import ResultNumbers from '@/components/ResultNumbers';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/buttonClasses';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

const PHASE: Record<GamePhase, { tone: BadgeTone; label: TranslationKey; border: string }> = {
  open: { tone: 'success', label: 'game.phaseOpen', border: 'border-brand-800/70' },
  closing: { tone: 'warning', label: 'game.phaseClosing', border: 'border-amber-700/70' },
  closed: { tone: 'neutral', label: 'game.phaseClosed', border: 'border-surface-border' },
  holiday: { tone: 'warning', label: 'game.phaseHoliday', border: 'border-amber-900/60 border-dashed' },
};

export default function GameCard({ status, result, nowMs, disabled, onOpen }: {
  status: GameStatus;
  result: GameResult | null | undefined;
  nowMs: number;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { t, language } = useT();
  const phase = gamePhase(status, nowMs);
  const style = PHASE[phase];
  const name = status.label || GAME_LABELS[status.game];
  const hasResult = !!(result && (result.open_digit || result.close_digit));
  const holiday = phase === 'holiday';
  const canPlay = phase === 'open' || phase === 'closing';

  const windows = [
    { label: t('game.openBets'), isOpen: status.open_bets_open, cutoff: status.open_bets_close_ts },
    { label: t('game.closeBets'), isOpen: status.close_bets_open, cutoff: status.close_bets_close_ts },
  ];

  return (
    <article className={`overflow-hidden rounded-card border bg-surface/80 ${style.border}`} aria-label={name}>
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-bold text-ink-strong">{name}</h3>
          <Badge tone={style.tone}>{t(style.label)}</Badge>
        </div>

        {holiday ? (
          <div className="flex items-start gap-2 text-sm text-amber-200">
            <CalendarOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p>{interpolate(t('game.holiday'), { date: status.holiday_reopens_on ? formatHolidayDate(status.holiday_reopens_on) : '' })}</p>
              {status.holiday_note && <p className="mt-0.5 text-amber-200/80">{status.holiday_note}</p>}
            </div>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {windows.map(({ label, isOpen, cutoff }) => {
              const tone = isOpen ? countdownTone(cutoff, nowMs) : 'closed';
              const color = tone === 'red' ? 'text-rose-300' : tone === 'amber' ? 'text-amber-300' : tone === 'closed' ? 'text-ink-muted' : 'text-ink-soft';
              return (
                <li key={label} className={`flex flex-wrap items-center gap-x-2 text-sm ${color}`}>
                  <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="font-medium">{label}</span>
                  <span className="tabular-nums">{formatBetWindow(isOpen, cutoff, status.bets_open_at, nowMs, language)}</span>
                  <CountdownAnnouncement cutoff={cutoff} opensAt={status.bets_open_at} isOpen={isOpen} nowMs={nowMs} label={label} />
                </li>
              );
            })}
          </ul>
        )}

        {!holiday && (
          <div className="rounded-control border border-surface-border bg-surface-page/60 px-4 py-3">
            <p className="text-xs font-medium text-ink-muted">
              {result && hasResult
                ? result.round_date === status.server_ist_date
                  ? t('dashboard.todaysResult')
                  : interpolate(t('dashboard.latestResult'), { date: result.round_date })
                : t('dashboard.todaysResult')}
            </p>
            {result && hasResult ? (
              <>
                <ResultNumbers result={result} size="lg" />
                <div className="mt-1 flex flex-wrap justify-center gap-2">
                  {result.open_digit && (
                    <Badge tone={result.open_processed ? 'success' : 'warning'}>
                      {result.open_processed ? t('result.openPaid') : t('result.openPending')}
                    </Badge>
                  )}
                  {result.close_digit && (
                    <Badge tone={result.close_processed ? 'success' : 'warning'}>
                      {result.close_processed ? t('result.closePaid') : t('result.closePending')}
                    </Badge>
                  )}
                </div>
              </>
            ) : (
              <p className="py-1 text-sm text-ink-soft">{t('dashboard.resultsPending')}</p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onOpen}
          disabled={disabled || holiday}
          className={buttonClasses({ variant: canPlay ? 'primary' : 'secondary', size: 'lg', fullWidth: true })}
        >
          {canPlay ? t('game.playNow') : t('game.viewGame')}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <PastResults game={status.game} />
    </article>
  );
}
