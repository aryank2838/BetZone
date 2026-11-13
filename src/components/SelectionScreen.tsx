import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { Game, SelectionEntry, GameResult, SavedSelection, BetType } from '@/types';
import { GAME_LABELS, BET_TYPES, isCloseBet, isValidPattiCombo } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { useBetLimits } from '@/lib/betLimits';
import { countdownTone, formatBetWindow, formatClockTime } from '@/lib/countdown';
import { friendlyError, friendlyErrorDetails } from '@/lib/errors';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import HelpButton from '@/components/HelpButton';
import { CardSkeleton } from '@/components/Skeleton';
import { useDialogA11y } from '@/lib/useDialogA11y';
import CountdownAnnouncement from '@/components/CountdownAnnouncement';
import ResultNumbers from '@/components/ResultNumbers';
import PageHeader from '@/components/ui/PageHeader';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { Card, SectionTitle } from '@/components/ui/Card';
import { useToast } from '@/components/ui/toastContext';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';
import { calculateBetSlip } from '@/lib/betSlip';
import { CalendarOff, Clock, Lock, Plus, ReceiptText, Trophy, X } from 'lucide-react';
import { formatHolidayDate, isOnHoliday } from '@/lib/holiday';

interface SelectionScreenProps {
  game: Game;
  onBack: () => void;
  onPointsChanged: () => void;
  onAddFunds: () => void;
}

type Tab = BetType;

interface PendingPick {
  number: string;
  points: number;
}

const TABS: { id: Tab; label: TranslationKey; color: 'emerald' | 'cyan' | 'amber' }[] = [
  { id: 'single_open', label: 'bet.tab.single_open', color: 'emerald' },
  { id: 'single_close', label: 'bet.tab.single_close', color: 'cyan' },
  { id: 'jodi', label: 'bet.tab.jodi', color: 'amber' },
  { id: 'patti_open', label: 'bet.tab.patti_open', color: 'emerald' },
  { id: 'patti_close', label: 'bet.tab.patti_close', color: 'cyan' },
];

const TAB_ACTIVE: Record<'emerald' | 'cyan' | 'amber', string> = {
  emerald: 'bg-brand-500 text-white',
  cyan: 'bg-accent-500 text-white',
  amber: 'bg-amber-500 text-white',
};

const INPUT = 'rounded-control border border-surface-strong bg-surface-raised px-3 py-2.5 text-base text-ink-strong focus:border-brand-400 focus:outline-none';

export default function SelectionScreen({ game, onBack, onPointsChanged, onAddFunds }: SelectionScreenProps) {
  const { formatNumber, formatDate } = useFormat();
  const { profile } = useAuth();
  const { language, t } = useT();
  const toast = useToast();
  const betLimits = useBetLimits();
  const [tab, setTab] = useState<Tab>('jodi');
  const [lockedByType, setLockedByType] = useState<Record<string, Map<string, number>>>({});
  // One slip per bet type, so looking at another type never loses picks.
  const [slips, setSlips] = useState<Partial<Record<Tab, PendingPick[]>>>({});
  const pending = slips[tab] ?? [];
  const setPending = useCallback((update: PendingPick[] | ((previous: PendingPick[]) => PendingPick[])) => {
    setSlips((current) => {
      const previous = current[tab] ?? [];
      return { ...current, [tab]: typeof update === 'function' ? update(previous) : update };
    });
  }, [tab]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    raw?: string;
    action?: ReturnType<typeof friendlyError>['action'];
  } | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [manualPatti, setManualPatti] = useState('');
  const [manualDigit, setManualDigit] = useState('');
  const [manualPoints, setManualPoints] = useState('10');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const submittingRef = useRef(false);
  const confirmationRef = useRef<HTMLElement>(null);
  const { statuses, loading: statusLoading, error: statusError, errorDetails: statusErrorDetails, nowMs, refresh } = useGameStatus();
  const closeConfirmation = useCallback(() => {
    if (!saving) {
      setConfirmationOpen(false);
      setMessage(null);
    }
  }, [saving]);
  useDialogA11y(confirmationOpen, confirmationRef, closeConfirmation);
  const { limits } = useMyLimits();
  const restriction = activePlayRestriction(limits);
  const status = statuses.find((item) => item.game === game) ?? null;
  const checkedStatus = !statusLoading;
  const previousRound = useRef<string | null>(null);
  const savedLoadId = useRef(0);
  const rupees = (value: number) => `₹${formatNumber(value)}`;

  const betInfo = BET_TYPES[tab];
  const multiplier = betInfo.multiplier;
  const closeBet = isCloseBet(tab);
  const cutoff = status
    ? closeBet ? status.close_bets_close_ts : status.open_bets_close_ts
    : null;
  const cutoffTone = cutoff ? countdownTone(cutoff, nowMs) : 'closed';
  const betOpen = status !== null && !restriction
    && (closeBet ? status.close_bets_open : status.open_bets_open)
    && cutoffTone !== 'closed';
  const stakeError = interpolate(t('bet.stakeRange'), { max: rupees(betLimits.maxPerBet) });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_latest_results', { p_game: game });
        if (!active) return;
        if (error) {
          const friendly = friendlyErrorDetails(error);
          setMessage({ text: friendly.message, raw: friendly.raw });
        } else if (data) setResult({ ...(data as GameResult), game });
      } catch (error) {
        if (!active) return;
        const friendly = friendlyErrorDetails(error);
        setMessage({ text: friendly.message, raw: friendly.raw });
      }
    })();
    return () => { active = false; };
  }, [game]);

  const loadSaved = useCallback(async (userId: string, roundDate: string) => {
    const currentLoad = ++savedLoadId.current;
    setLoading(true);
    setLockedByType({});
    const { data, error } = await supabase
      .from('selections')
      .select('id, game, bet_type, round_date, selections, total_points, updated_at')
      .eq('game', game)
      .eq('user_id', userId)
      .eq('round_date', roundDate);

    if (error) {
      console.error('Failed to load saved picks', error);
      const friendly = friendlyErrorDetails(error);
      setMessage({ text: friendly.message, raw: friendly.raw });
    } else if (data) {
      const byType: Record<string, Map<string, number>> = {};
      (data as SavedSelection[]).forEach((row) => {
        const entries = new Map<string, number>();
        (row.selections as SelectionEntry[]).forEach((item) => {
          entries.set(item.number, Number(item.points) || 1);
        });
        byType[row.bet_type] = entries;
      });
      if (currentLoad === savedLoadId.current) setLockedByType(byType);
    }
    if (currentLoad === savedLoadId.current) setLoading(false);
  }, [game]);

  useEffect(() => {
    const roundDate = status?.round_date ?? null;
    if (previousRound.current && roundDate && previousRound.current !== roundDate) {
      setSlips({});
      setLockedByType({});
    }
    previousRound.current = roundDate;
    if (profile?.id && roundDate) void loadSaved(profile.id, roundDate);
  }, [profile?.id, status?.round_date, loadSaved]);

  useEffect(() => {
    if (!status) return;
    setTab((current) => {
      const currentOpen = isCloseBet(current) ? status.close_bets_open : status.open_bets_open;
      if (currentOpen) return current;
      if (status.open_bets_open) return 'jodi';
      if (status.close_bets_open) return 'single_close';
      return current;
    });
    // Picks for a bet window that has closed can no longer be placed.
    setSlips((current) => {
      const open = (type: Tab) => (isCloseBet(type) ? status.close_bets_open : status.open_bets_open);
      const entries = Object.entries(current) as Array<[Tab, PendingPick[]]>;
      return entries.every(([type]) => open(type)) ? current : Object.fromEntries(entries.filter(([type]) => open(type)));
    });
  }, [status]);

  // Switching bet type keeps every slip; only the half-typed patti is cleared.
  useEffect(() => {
    setManualPatti('');
    setManualDigit('');
    setMessage(null);
  }, [tab]);

  const lockedMap = lockedByType[tab] ?? new Map<string, number>();
  const lockedEntries = Array.from(lockedMap.entries()).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const lockedCount = Object.values(lockedByType).reduce((sum, map) => sum + map.size, 0);

  const validStake = (points: number) => Number.isInteger(points) && points >= 1 && points <= betLimits.maxPerBet;

  const addPending = (number: string, points: number) => {
    if (lockedMap.has(number)) return;
    setPending((prev) => {
      const existing = prev.find((p) => p.number === number);
      if (existing) return prev.map((p) => p.number === number ? { ...p, points } : p);
      return [...prev, { number, points }];
    });
    setMessage(null);
  };

  const removePending = (number: string) => {
    setPending((prev) => prev.filter((p) => p.number !== number));
  };

  const updatePendingPoints = (number: string, points: number) => {
    setPending((prev) => prev.map((p) => p.number === number ? { ...p, points } : p));
  };

  const togglePick = (label: string) => {
    if (lockedMap.has(label)) return;
    if (pending.some((p) => p.number === label)) {
      removePending(label);
      return;
    }
    const points = Number(manualPoints);
    if (!validStake(points)) {
      setMessage({ text: stakeError });
      return;
    }
    addPending(label, points);
  };

  const handlePattiAdd = () => {
    const p = manualPatti.trim();
    const d = manualDigit.trim();
    if (!/^\d{3}$/.test(p)) { setMessage({ text: t('bet.pattiDigits') }); return; }
    if (!/^\d$/.test(d)) { setMessage({ text: t('bet.digitRange') }); return; }
    const num = `${p}-${d}`;
    if (!isValidPattiCombo(num)) { setMessage({ text: t('bet.pattiInvalid') }); return; }
    const pts = Number(manualPoints);
    if (!validStake(pts)) { setMessage({ text: stakeError }); return; }
    if (lockedMap.has(num)) { setMessage({ text: interpolate(t('bet.alreadyPlaced'), { number: num }) }); return; }
    addPending(num, pts);
    setManualPatti('');
    setManualDigit('');
  };

  const pendingSorted = [...pending].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const betSlip = calculateBetSlip(pendingSorted, profile?.points ?? 0, profile?.wallet ?? 0, multiplier);
  const newTotal = betSlip.totalCost;
  const lockedTotal = lockedEntries.reduce((sum, [, p]) => sum + p, 0);
  const balance = (profile?.points ?? 0) + (profile?.wallet ?? 0);
  const insufficient = newTotal > balance;
  const invalidEntry = pendingSorted.some((p) => !validStake(p.points));
  const exceedsSubmitLimit = newTotal > betLimits.maxPerSubmit;
  const slipVisible = betOpen && pendingSorted.length > 0;
  const otherSlips = (Object.entries(slips) as Array<[Tab, PendingPick[]]>).filter(([type, picks]) => type !== tab && picks.length > 0);
  const slipCount = Object.values(slips).reduce((sum, picks) => sum + (picks?.length ?? 0), 0);

  const handleSave = async () => {
    if (submittingRef.current) return;
    if (!profile) return;
    if (pendingSorted.length === 0) { setMessage({ text: t('bet.addOne') }); return; }
    if (invalidEntry) { setMessage({ text: stakeError }); return; }
    if (exceedsSubmitLimit) { setMessage({ text: interpolate(t('betslip.submitLimit'), { max: formatNumber(betLimits.maxPerSubmit) }) }); return; }
    if (insufficient) { setMessage({ text: interpolate(t('betslip.notEnough'), { balance: formatNumber(balance), total: formatNumber(newTotal) }), action: 'add_funds' }); return; }
    if (!status || !betOpen) { setMessage({ text: t('errors.closed') }); return; }

    setSaving(true);
    submittingRef.current = true;
    setMessage(null);
    try {
      const payload = pendingSorted.map((p) => ({ number: p.number, points: p.points }));
      const { data, error } = await supabase.rpc('submit_selection', {
        p_game: game,
        p_selections: payload,
        p_bet_type: tab,
      });
      if (error) throw error;
      const placed = data as { new_count: number; new_points: number };
      await loadSaved(profile.id, status.round_date);
      setPending([]);
      setConfirmationOpen(false);
      toast.show(interpolate(t('bet.placed'), { count: placed.new_count, amount: rupees(placed.new_points) }));
      onPointsChanged();
    } catch (err) {
      const { message: friendlyMessage, action } = friendlyError(err);
      const friendly = friendlyErrorDetails(err);
      setMessage({ text: friendlyMessage, raw: friendly.raw, action });
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const renderGrid = () => {
    if (betInfo.inputType === 'patti_combo') return null;
    const count = betInfo.inputType === 'digit' ? 10 : 100;
    const digit = betInfo.inputType === 'digit';
    return (
      <div className={digit ? 'grid grid-cols-5 gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5'}>
        {Array.from({ length: count }, (_, n) => {
          const label = digit ? String(n) : String(n).padStart(2, '0');
          const isLocked = lockedMap.has(label);
          const isPending = pending.some((p) => p.number === label);
          return (
            <button
              key={label}
              type="button"
              onClick={() => togglePick(label)}
              disabled={isLocked}
              aria-pressed={isPending}
              className={`aspect-square rounded-lg border font-bold tabular-nums transition-colors active:scale-95 ${digit ? 'text-lg' : 'text-sm'} ${
                isLocked
                  ? 'border-surface-strong bg-surface-raised text-ink-muted line-through decoration-ink-muted/60'
                  : isPending
                  ? digit ? 'border-brand-500 bg-brand-500 text-white' : 'border-amber-500 bg-amber-500 text-white'
                  : 'border-surface-strong bg-surface-raised text-ink-soft hover:border-slate-600 hover:bg-slate-700'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  };

  const gameName = status?.label || GAME_LABELS[game];

  return (
    <div className={`min-h-screen bg-surface-page text-ink ${slipVisible ? 'pb-[calc(7rem+env(safe-area-inset-bottom))]' : 'pb-8'}`}>
      <PageHeader
        title={gameName}
        subtitle={interpolate(t('bet.headerCounts'), { placed: lockedCount, slip: slipCount })}
        onBack={onBack}
        actions={(
          <>
            <div className="text-right">
              <p className="text-base font-bold leading-tight text-ink-strong">{rupees(balance)}</p>
              <p className="text-xs leading-tight text-ink-muted">{t('bet.balance')}</p>
            </div>
            <HelpButton />
          </>
        )}
      />

      <div className="mx-auto max-w-2xl space-y-4 px-4 pt-5 sm:px-5">
        {result && (result.open_digit || result.close_digit) && (
          <Card className="!p-4">
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                <Trophy className="h-4 w-4 text-amber-400" aria-hidden="true" />
                {result.round_date === status?.round_date ? t('dashboard.todaysResult') : interpolate(t('dashboard.latestResult'), { date: formatHolidayDate(result.round_date) })}
              </p>
            </div>
            <ResultNumbers result={result} />
            <div className="flex justify-center gap-4 text-xs text-ink-muted">
              {result.open_digit && result.open_posted_at && <p>{t('bet.openAt')} {formatDate(result.open_posted_at, { hour: '2-digit', minute: '2-digit' })}</p>}
              {result.close_digit && result.close_posted_at && <p>{t('bet.closeAt')} {formatDate(result.close_posted_at, { hour: '2-digit', minute: '2-digit' })}</p>}
            </div>
          </Card>
        )}

        {checkedStatus && status && isOnHoliday(status) && (
          <Alert tone="warning">
            <p className="flex items-center gap-1.5"><CalendarOff className="h-4 w-4" aria-hidden="true" />{interpolate(t('game.holiday'), { date: status.holiday_reopens_on ? formatHolidayDate(status.holiday_reopens_on) : '' })}</p>
            {status.holiday_note && <p className="mt-1 opacity-80">{status.holiday_note}</p>}
          </Alert>
        )}
        {checkedStatus && !status && (
          <Alert details={statusErrorDetails} onRetry={() => void refresh()}>
            {t('bet.scheduleMissing')} {statusError ?? ''}
          </Alert>
        )}
        {checkedStatus && status && !betOpen && !isOnHoliday(status) && !restriction && (
          <Alert tone="info">
            {interpolate(t('bet.closedInfo'), {
              opens: formatClockTime(status.bets_open_at),
              openClose: formatClockTime(status.open_bets_close_at),
              closeClose: formatClockTime(status.close_bets_close_at),
            })}
          </Alert>
        )}
        {restriction && (
          <Alert tone="warning">
            {interpolate(t(restriction.kind === 'cooldown' ? 'bet.restrictedCooldown' : 'bet.restrictedSelfExclusion'), { date: formatLimitEnd(restriction.until) })}
          </Alert>
        )}

        {status && !isOnHoliday(status) && (
          <ul className="space-y-1.5 px-1 text-sm">
            {([
              [t('game.openBets'), status.open_bets_open, status.open_bets_close_ts, status.open_bets_close_at],
              [t('game.closeBets'), status.close_bets_open, status.close_bets_close_ts, status.close_bets_close_at],
            ] as const).map(([label, isOpen, cutoffTs, cutoffAt]) => {
              const tone = isOpen ? countdownTone(cutoffTs, nowMs) : 'closed';
              return (
                <li key={label} className={`flex items-start gap-2 ${tone === 'red' ? 'text-rose-300' : tone === 'amber' ? 'text-amber-300' : tone === 'closed' ? 'text-ink-muted' : 'text-ink-soft'}`}>
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="font-medium">{label}</span>{' · '}
                    <span className="tabular-nums">{formatBetWindow(isOpen, cutoffTs, status.bets_open_at, nowMs, language)}</span>
                    {isOpen && <span className="text-ink-muted"> ({interpolate(t('bet.lastBet'), { time: formatClockTime(cutoffAt) })})</span>}
                  </span>
                  <CountdownAnnouncement cutoff={cutoffTs} opensAt={status.bets_open_at} isOpen={isOpen} nowMs={nowMs} label={label} />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <main className="relative z-10 mx-auto max-w-2xl space-y-5 px-4 py-5 sm:px-5">
        {/* Bet type tabs */}
        <div role="tablist" aria-label={t('bet.typeLabel')} className="flex gap-1 overflow-x-auto rounded-card border border-surface-border bg-surface/80 p-1">
          {TABS.map((item) => {
            const typeCutoff = status
              ? isCloseBet(item.id) ? status.close_bets_close_ts : status.open_bets_close_ts
              : '';
            const typeClosed = !status
              || (isCloseBet(item.id) ? !status.close_bets_open : !status.open_bets_open)
              || countdownTone(typeCutoff, nowMs) === 'closed';
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                disabled={typeClosed}
                className={`relative flex min-h-[52px] flex-1 flex-col items-center justify-center whitespace-nowrap rounded-control px-3 text-sm font-semibold transition-colors ${
                  selected ? TAB_ACTIVE[item.color] : 'text-ink-muted hover:bg-surface-raised hover:text-ink-soft'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {(slips[item.id]?.length ?? 0) > 0 && (
                  <span className="absolute right-1 top-1 min-w-[18px] rounded-full bg-amber-400 px-1 text-[11px] font-bold leading-[18px] text-slate-950">
                    {slips[item.id]!.length}
                    <span className="sr-only"> {t('bet.inSlip')}</span>
                  </span>
                )}
                <span>{t(item.label)}</span>
                <span className={`text-xs font-medium ${selected ? 'text-white/80' : 'text-ink-muted'}`}>{BET_TYPES[item.id].multiplier}×</span>
              </button>
            );
          })}
        </div>

        <p className="px-1 text-sm text-ink-muted">{t(`bet.desc.${tab}` as TranslationKey)}</p>

        {message && !confirmationOpen && (
          <Alert
            details={message.raw}
            action={message.action === 'add_funds' ? <Button variant="secondary" onClick={onAddFunds}>{t('betslip.addFunds')}</Button> : undefined}
          >
            {message.text}
          </Alert>
        )}

        {betOpen && (
          <Card className="space-y-4 !p-4">
            <div>
              <label htmlFor="selection-stake" className="mb-2 block text-sm font-medium text-ink-soft">{t('bet.stakeLabel')}</label>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden="true">₹</span>
                  <input
                    id="selection-stake"
                    type="number"
                    min={1}
                    max={betLimits.maxPerBet}
                    step={1}
                    inputMode="numeric"
                    value={manualPoints}
                    onChange={(event) => setManualPoints(event.target.value)}
                    className={`${INPUT} w-28 pl-7`}
                  />
                </div>
                {betLimits.quickStakes.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setManualPoints(String(value))}
                    aria-pressed={manualPoints === String(value)}
                    className={`min-h-tap min-w-[56px] rounded-control border px-3 text-sm font-semibold transition-colors ${
                      manualPoints === String(value)
                        ? 'border-brand-500 bg-brand-950 text-brand-200'
                        : 'border-surface-strong bg-surface-raised text-ink-soft hover:bg-slate-700'
                    }`}
                  >
                    ₹{formatNumber(value)}
                  </button>
                ))}
              </div>
              {pendingSorted.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPending((items) => items.map((pick) => ({ ...pick, points: Number(manualPoints) || 0 })))}
                  className="mt-2 min-h-[36px] text-sm font-medium text-accent-300 hover:text-accent-200"
                >
                  {interpolate(t('bet.applyAll'), { amount: manualPoints ? rupees(Number(manualPoints) || 0) : '—' })}
                </button>
              )}
            </div>

            {betInfo.inputType === 'patti_combo' ? (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <label className="flex-1 text-sm text-ink-soft">
                    {t('bet.patti')}
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{3}"
                      value={manualPatti}
                      onChange={(event) => setManualPatti(event.target.value.replace(/\D/g, '').slice(0, 3))}
                      onKeyDown={(event) => { if (event.key === 'Enter') handlePattiAdd(); }}
                      placeholder="e.g. 123"
                      maxLength={3}
                      className={`${INPUT} mt-1 w-full`}
                    />
                  </label>
                  <label className="w-24 text-sm text-ink-soft">
                    {t('bet.digit')}
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]"
                      value={manualDigit}
                      onChange={(event) => setManualDigit(event.target.value.replace(/\D/g, '').slice(0, 1))}
                      onKeyDown={(event) => { if (event.key === 'Enter') handlePattiAdd(); }}
                      placeholder="e.g. 6"
                      maxLength={1}
                      className={`${INPUT} mt-1 w-full`}
                    />
                  </label>
                </div>
                <Button fullWidth icon={<Plus className="h-4 w-4" />} disabled={manualPatti.length < 3 || !manualDigit} onClick={handlePattiAdd}>
                  {manualPatti && manualDigit ? interpolate(t('bet.addNumber'), { number: `${manualPatti}-${manualDigit}` }) : t('bet.addPick')}
                </Button>
              </div>
            ) : (
              <div>
                <p className="mb-2 text-sm text-ink-muted">{t('bet.tapHint')}</p>
                {loading ? <CardSkeleton /> : renderGrid()}
              </div>
            )}

            {pendingSorted.length > 0 && (
              <div className="space-y-2 border-t border-surface-border pt-4">
                <SectionTitle action={<button type="button" onClick={() => { setPending([]); setMessage(null); }} className="min-h-[36px] text-sm text-ink-muted hover:text-ink-soft">{t('bet.clearAll')}</button>}>
                  {t('bet.inSlip')}
                </SectionTitle>
                {invalidEntry && <p className="text-sm text-rose-300">{stakeError}</p>}
                {exceedsSubmitLimit && <p className="text-sm text-rose-300">{interpolate(t('betslip.submitLimit'), { max: formatNumber(betLimits.maxPerSubmit) })}</p>}
                <ul className="space-y-2">
                  {pendingSorted.map((pick) => (
                    <li key={pick.number} className="flex items-center gap-3 rounded-control border border-surface-strong bg-surface-raised/50 px-3 py-2 animate-scale-in">
                      <span className="w-14 font-bold tabular-nums text-ink-strong">{pick.number}</span>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-ink-muted" aria-hidden="true">₹</span>
                        <input
                          type="number"
                          min={1}
                          max={betLimits.maxPerBet}
                          step={1}
                          inputMode="numeric"
                          aria-label={interpolate(t('bet.stakeFor'), { number: pick.number })}
                          value={pick.points}
                          onChange={(event) => updatePendingPoints(pick.number, event.target.value === '' ? 0 : Number(event.target.value))}
                          className={`${INPUT} w-24 py-1.5 pl-6 text-sm`}
                        />
                      </div>
                      <span className="flex-1 text-right text-sm font-medium text-brand-300">
                        {interpolate(t('betslip.potentialWin'), { amount: formatNumber(pick.points * multiplier) })}
                      </span>
                      <button
                        type="button"
                        aria-label={interpolate(t('bet.remove'), { number: pick.number })}
                        onClick={() => removePending(pick.number)}
                        className="tap-target -mr-2 rounded-lg text-ink-muted hover:text-rose-300"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        {lockedEntries.length > 0 && (
          <section aria-labelledby="placed-title">
            <SectionTitle id="placed-title" icon={<Lock className="h-4 w-4" aria-hidden="true" />}>
              {interpolate(t('bet.placedTitle'), { type: t(`bet.name.${tab}` as TranslationKey) })}
            </SectionTitle>
            <ul className="divide-y divide-surface-border rounded-card border border-surface-border bg-surface/80">
              {lockedEntries.map(([number, points]) => (
                <li key={number} className="flex items-center justify-between px-4 py-3">
                  <span className="font-bold tabular-nums text-ink-strong">{number}</span>
                  <span className="flex items-center gap-3 text-sm">
                    <span className="text-ink-muted">{interpolate(t('betslip.stake'), { points: formatNumber(points) })}</span>
                    <span className="font-medium text-brand-300">{interpolate(t('betslip.potentialWin'), { amount: formatNumber(points * multiplier) })}</span>
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between bg-surface/50 px-4 py-3 text-sm">
                <span className="text-ink-muted">{t('bet.totalBet')}</span>
                <span className="font-semibold text-ink-soft">{rupees(lockedTotal)}</span>
              </li>
            </ul>
          </section>
        )}
      </main>

      {/* Sticky bet slip: always visible while picks are waiting. */}
      {slipVisible && !confirmationOpen && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-surface-border bg-surface-page/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">
          <div className="mx-auto max-w-2xl">
            {insufficient && (
              <p className="mb-2 text-center text-sm text-rose-300">
                {interpolate(t('betslip.notEnough'), { balance: formatNumber(balance), total: formatNumber(newTotal) })}{' '}
                <button type="button" onClick={onAddFunds} className="font-semibold text-brand-300 underline">{t('betslip.addFunds')}</button>
              </p>
            )}
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink-strong">
                  {interpolate(t(pendingSorted.length === 1 ? 'bet.slipOne' : 'bet.slipMany'), { count: pendingSorted.length })} · {rupees(newTotal)}
                </p>
                <p className="truncate text-xs text-ink-muted">{t(`bet.name.${tab}` as TranslationKey)}</p>
                {otherSlips.length > 0 && (
                  <p className="truncate text-xs text-amber-300">
                    {interpolate(t('bet.otherSlips'), { list: otherSlips.map(([type, picks]) => `${t(`bet.name.${type}` as TranslationKey)} (${picks.length})`).join(', ') })}
                  </p>
                )}
              </div>
              <Button
                size="lg"
                icon={<ReceiptText className="h-4 w-4" />}
                onClick={() => { setMessage(null); setConfirmationOpen(true); }}
                disabled={saving || invalidEntry || exceedsSubmitLimit}
              >
                {t('bet.review')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmationOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:px-4 sm:py-6">
          <section
            ref={confirmationRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bet-slip-title"
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-card border border-surface-strong bg-surface p-5 shadow-2xl sm:rounded-card"
          >
            <h2 id="bet-slip-title" className="text-lg font-bold text-ink-strong">{t('betslip.title')}</h2>
            <p className="mt-1 text-sm text-amber-300">{t('betslip.locked')}</p>
            <ul className="mt-4 max-h-56 divide-y divide-surface-border overflow-y-auto rounded-control border border-surface-border">
              {pendingSorted.map((pick, index) => (
                <li key={pick.number} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <span className="font-bold text-ink-strong">{pick.number}</span>
                  <span className="text-ink-muted">{interpolate(t('betslip.stake'), { points: formatNumber(pick.points) })}</span>
                  <span className="text-brand-300">{interpolate(t('betslip.potentialWin'), { amount: formatNumber(betSlip.potentialWins[index]) })}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 space-y-2 rounded-control bg-surface-raised/70 p-3 text-sm">
              <div className="flex justify-between"><span className="text-ink-muted">{t('betslip.pickCount')}</span><span>{betSlip.pickCount}</span></div>
              <div className="flex justify-between"><span className="text-ink-muted">{t('betslip.totalCost')}</span><span className="font-bold text-ink-strong">{interpolate(t('betslip.totalCostValue'), { points: formatNumber(newTotal) })}</span></div>
              <div className="flex justify-between"><span className="text-ink-muted">{t('betslip.balanceAfter')}</span><span /></div>
              <div className="flex justify-between pl-3"><span className="text-ink-muted">{t('betslip.play')}</span><span>₹{formatNumber(betSlip.playAfterBet)}</span></div>
              <div className="flex justify-between pl-3"><span className="text-ink-muted">{t('betslip.wallet')}</span><span>₹{formatNumber(betSlip.walletAfterBet)}</span></div>
            </div>
            {(insufficient || invalidEntry || exceedsSubmitLimit) && (
              <div className="mt-3 space-y-1 text-sm text-rose-300">
                {insufficient && <p>{interpolate(t('betslip.notEnough'), { balance: formatNumber(balance), total: formatNumber(newTotal) })}</p>}
                {invalidEntry && <p>{interpolate(t('betslip.stakeRange'), { max: formatNumber(betLimits.maxPerBet) })}</p>}
                {exceedsSubmitLimit && <p>{interpolate(t('betslip.submitLimit'), { max: formatNumber(betLimits.maxPerSubmit) })}</p>}
                {insufficient && (
                  <button type="button" onClick={onAddFunds} className="pt-1 font-semibold text-brand-300 hover:text-brand-200">
                    {t('betslip.addFunds')}
                  </button>
                )}
              </div>
            )}
            {message && (
              <Alert
                className="mt-3"
                details={message.raw}
                action={message.action === 'add_funds' ? <Button variant="secondary" onClick={onAddFunds}>{t('betslip.addFunds')}</Button> : undefined}
              >
                {message.text}
              </Alert>
            )}
            <div className="sticky bottom-0 mt-5 grid grid-cols-2 gap-3 bg-surface pb-[env(safe-area-inset-bottom)]">
              <Button variant="secondary" size="lg" disabled={saving} onClick={() => { setConfirmationOpen(false); setMessage(null); }}>
                {t('betslip.back')}
              </Button>
              <Button
                size="lg"
                loading={saving}
                disabled={!betOpen || insufficient || invalidEntry || exceedsSubmitLimit || pendingSorted.length === 0}
                onClick={() => { void handleSave(); }}
              >
                {t('betslip.confirm')}
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
