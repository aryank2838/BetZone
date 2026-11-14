import type { CSSProperties } from 'react';
import { ChevronRight, Clock } from 'lucide-react';
import { GAME_LABELS, type GameResult, type GameStatus } from '@/types';
import { countdownTone, formatClockTime, formatCountdown } from '@/lib/countdown';
import type { GamePhase } from '@/lib/gameState';
import { gameLook } from '@/lib/gameLook';
import { formatHolidayDate, isoWeekday, weekdayNames } from '@/lib/holiday';
import CountdownAnnouncement from '@/components/CountdownAnnouncement';
import PastResults from '@/components/PastResults';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import { buttonClasses } from '@/components/ui/buttonClasses';
import { interpolate, useT } from '@/i18n/useT';
import { localeFor, type TranslationKey } from '@/i18n/context';

const PILL: Partial<Record<GamePhase, { tone: BadgeTone; label: TranslationKey }>> = {
  open: { tone: 'success', label: 'game.phaseOpen' },
  closing: { tone: 'warning', label: 'game.phaseClosing' },
  later: { tone: 'neutral', label: 'game.phaseLater' },
};

/** Patti-jodi-patti on one line, e.g. 128-14-356, with the open digit green and the close digit cyan. */
function InlineResult({ result, className = '' }: { result: GameResult; className?: string }) {
  return (
    <span className={`whitespace-nowrap font-bold tabular-nums tracking-wide text-ink-strong ${className}`}>
      {result.open_patti ?? '***'}
      <span className="px-0.5 text-ink-muted">-</span>
      {result.open_digit ? <span className="text-brand-400">{result.open_digit}</span> : <span className="text-ink-muted">*</span>}
      {result.close_digit ? <span className="text-accent-400">{result.close_digit}</span> : <span className="text-ink-muted">*</span>}
      <span className="px-0.5 text-ink-muted">-</span>
      {result.close_patti ?? <span className="text-ink-muted">***</span>}
    </span>
  );
}

function GameIcon({ game, small }: { game: string; small?: boolean }) {
  const { color, Icon } = gameLook(game);
  return (
    <span
      className={`grid shrink-0 place-items-center border ${small ? 'h-9 w-9 rounded-[10px]' : 'h-10 w-10 rounded-xl'}`}
      style={{ color, backgroundColor: `${color}26`, borderColor: `${color}66` }}
      aria-hidden="true"
    >
      <Icon className={small ? 'h-[18px] w-[18px]' : 'h-[22px] w-[22px]'} />
    </span>
  );
}

export default function GameCard({ status, phase, result, nowMs, disabled, onOpen }: {
  status: GameStatus;
  phase: GamePhase;
  result: GameResult | null | undefined;
  nowMs: number;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { t, language } = useT();
  const name = status.label || GAME_LABELS[status.game];
  const { color } = gameLook(status.game);
  const hasResult = !!(result && (result.open_digit || result.close_digit));
  const resultLabel = result && hasResult
    ? result.round_date === status.server_ist_date
      ? t('dashboard.todaysResult')
      : interpolate(t('dashboard.latestResult'), { date: formatHolidayDate(result.round_date) })
    : t('dashboard.todaysResult');

  // Closed for today, day off or holiday: one short row.
  if (phase === 'closed' || phase === 'dayOff' || phase === 'holiday') {
    const off = phase !== 'closed';
    const subtitle = phase === 'holiday'
      ? interpolate(t('game.holidayRow'), { date: status.holiday_reopens_on ? formatHolidayDate(status.holiday_reopens_on) : '' })
      : phase === 'dayOff'
        ? interpolate(t('game.dayOffRow'), {
          day: status.day_off_reopens_on ? weekdayNames([isoWeekday(status.day_off_reopens_on)], localeFor(language)) : '',
          time: formatClockTime(status.bets_open_at),
        })
        : t('game.doneToday');
    const inner = (
      <>
        <GameIcon game={status.game} small />
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-ink-strong">{name}</span>
          <span className="block text-xs text-ink-muted">{subtitle}</span>
          {phase === 'holiday' && status.holiday_note && <span className="block text-xs text-amber-200/80">{status.holiday_note}</span>}
        </span>
        {off ? (
          <Badge tone={phase === 'holiday' ? 'warning' : 'neutral'}>{t(phase === 'holiday' ? 'game.phaseHoliday' : 'game.phaseDayOff')}</Badge>
        ) : result && hasResult ? (
          <span className="shrink-0 text-right">
            <InlineResult result={result} className="text-[15px]" />
            <span className="mt-0.5 block text-[11px] text-ink-muted">{resultLabel}</span>
          </span>
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
      </>
    );
    const rowClass = 'flex w-full items-center gap-3 px-3.5 py-3 text-left';
    const rowStyle: CSSProperties = { backgroundImage: `linear-gradient(100deg, ${color}1f 0%, transparent 60%)` };
    return (
      <article
        className={`overflow-hidden rounded-card border bg-surface/80 ${off ? 'border-dashed border-surface-strong opacity-75' : 'border-surface-border'}`}
        aria-label={name}
      >
        {off || disabled ? (
          <div className={rowClass} style={rowStyle}>{inner}</div>
        ) : (
          <button type="button" onClick={onOpen} className={`${rowClass} hover:bg-surface-raised/40`} style={rowStyle}>{inner}</button>
        )}
      </article>
    );
  }

  const canPlay = phase === 'open' || phase === 'closing';
  const pill = PILL[phase];
  const windows = [
    { label: t('game.openBets'), isOpen: status.open_bets_open, cutoff: status.open_bets_close_ts, closesAt: status.open_bets_close_at },
    { label: t('game.closeBets'), isOpen: status.close_bets_open, cutoff: status.close_bets_close_ts, closesAt: status.close_bets_close_at },
  ];

  const timeLeft = (cutoff: string) => {
    const ms = Date.parse(cutoff) - nowMs;
    if (!Number.isFinite(ms)) return '';
    if (ms < 10 * 60_000) return interpolate(t('game.leftClock'), { time: formatCountdown(cutoff, nowMs) });
    const minutes = Math.floor(ms / 60_000);
    return minutes >= 60
      ? interpolate(t('game.leftHours'), { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, '0') })
      : interpolate(t('game.leftMinutes'), { m: minutes });
  };

  const border = phase === 'closing'
    ? 'border-amber-600/70 game-card-closing'
    : phase === 'open'
      ? 'border-brand-700/60 shadow-[0_8px_28px_-12px_rgba(52,211,153,0.4)]'
      : 'border-surface-border';

  return (
    <article className={`overflow-hidden rounded-card border bg-surface/80 ${border}`} aria-label={name}>
      <div
        className="flex items-center gap-3 border-b px-4 pb-3 pt-3.5"
        style={{ backgroundImage: `linear-gradient(100deg, ${color}42 0%, ${color}0f 70%)`, borderColor: `${color}40` }}
      >
        <GameIcon game={status.game} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-bold leading-tight text-ink-strong">{name}</h3>
          <p className="text-xs tabular-nums text-ink-muted">
            {formatClockTime(status.bets_open_at)} – {formatClockTime(status.close_result_at)}
          </p>
        </div>
        {pill && <Badge tone={pill.tone}>{t(pill.label)}</Badge>}
      </div>

      <div className="space-y-3.5 px-4 pb-4 pt-3.5">
        <ul className="space-y-1.5">
          {windows.map(({ label, isOpen, cutoff, closesAt }) => {
            const tone = isOpen ? countdownTone(cutoff, nowMs) : 'closed';
            const urgent = tone === 'amber' || tone === 'red';
            const text = phase === 'later'
              ? interpolate(t('game.opensAt'), { time: formatClockTime(status.bets_open_at) })
              : isOpen
                ? `${interpolate(t('game.closesAt'), { time: formatClockTime(closesAt) })} · ${timeLeft(cutoff)}`
                : t('game.windowClosed');
            return (
              <li key={label} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm ${urgent ? 'text-amber-300' : isOpen || phase === 'later' ? 'text-ink-soft' : 'text-ink-muted'}`}>
                <Clock className={`h-4 w-4 shrink-0 ${urgent ? '' : 'text-ink-muted'}`} aria-hidden="true" />
                <span className={isOpen || phase === 'later' ? 'font-semibold text-ink' : 'font-medium'}>{label}</span>
                <span className="tabular-nums">{text}</span>
                <CountdownAnnouncement cutoff={cutoff} opensAt={status.bets_open_at} isOpen={isOpen} nowMs={nowMs} label={label} />
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-3 rounded-control border border-surface-border bg-surface-page/60 px-3 py-2.5">
          <span className="text-xs text-ink-muted">{resultLabel}</span>
          {result && hasResult
            ? <InlineResult result={result} className="text-xl" />
            : <span className="text-sm text-ink-soft">{t('dashboard.resultsPending')}</span>}
        </div>

        <button
          type="button"
          onClick={onOpen}
          disabled={disabled}
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
