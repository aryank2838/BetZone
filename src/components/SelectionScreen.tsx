import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { Game, SelectionEntry, GameResult, SavedSelection } from '@/types';
import { GAME_LABELS, BET_TYPES, isCloseBet, isValidPattiCombo } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { useBetLimits } from '@/lib/betLimits';
import { countdownTone, formatBetWindow } from '@/lib/countdown';
import { friendlyError, friendlyErrorDetails } from '@/lib/errors';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import HelpButton from '@/components/HelpButton';
import { CardSkeleton } from '@/components/Skeleton';
import { useDialogA11y } from '@/lib/useDialogA11y';
import CountdownAnnouncement from '@/components/CountdownAnnouncement';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import { calculateBetSlip } from '@/lib/betSlip';
import {
  ArrowLeft, Loader2, CheckCircle2, Lock, Plus, Trophy, Hash, Grid3x3,
  Sparkles, TrendingUp,
} from 'lucide-react';

interface SelectionScreenProps {
  game: Game;
  onBack: () => void;
  onPointsChanged: () => void;
  onAddFunds: () => void;
}

type Tab = 'single_open' | 'single_close' | 'jodi' | 'patti_open' | 'patti_close';

interface PendingPick {
  number: string;
  points: number;
}

function formatScheduleTime(time: string, locale: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function SelectionScreen({ game, onBack, onPointsChanged, onAddFunds }: SelectionScreenProps) {
  const { formatNumber, formatDate } = useFormat();
  const { profile } = useAuth();
  const { locale, t } = useT();
  const betLimits = useBetLimits();
  const [tab, setTab] = useState<Tab>('jodi');
  const [lockedByType, setLockedByType] = useState<Record<string, Map<string, number>>>({});
  const [pending, setPending] = useState<PendingPick[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    kind: 'ok' | 'err';
    text: string;
    raw?: string;
    action?: ReturnType<typeof friendlyError>['action'];
  } | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [manualNumber, setManualNumber] = useState('');
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

  const betInfo = BET_TYPES[tab];
  const closeBet = isCloseBet(tab);
  const cutoff = status
    ? closeBet ? status.close_bets_close_ts : status.open_bets_close_ts
    : null;
  const cutoffTone = cutoff ? countdownTone(cutoff, nowMs) : 'closed';
  const betOpen = status !== null && !restriction
    && (closeBet ? status.close_bets_open : status.open_bets_open)
    && cutoffTone !== 'closed';

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_latest_results', { p_game: game });
        if (!active) return;
        if (error) {
          const friendly = friendlyErrorDetails(error);
          setMessage({ kind: 'err', text: friendly.message, raw: friendly.raw });
        } else if (data) setResult({ ...(data as GameResult), game });
      } catch (error) {
        if (!active) return;
        const friendly = friendlyErrorDetails(error);
        setMessage({ kind: 'err', text: friendly.message, raw: friendly.raw });
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
      setMessage({ kind: 'err', text: friendly.message, raw: friendly.raw });
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
      setPending([]);
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
  }, [status]);

  useEffect(() => {
    setPending([]);
    setManualNumber('');
    setManualPatti('');
    setManualDigit('');
    setMessage(null);
  }, [tab]);

  const lockedMap = lockedByType[tab] ?? new Map<string, number>();
  const lockedEntries = Array.from(lockedMap.entries()).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

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

  const clearPending = () => {
    setPending([]);
    setMessage(null);
  };

  const handleManualAdd = () => {
    let num: string;
    if (betInfo.inputType === 'patti_combo') {
      const p = manualPatti.trim();
      const d = manualDigit.trim();
      if (!/^\d{3}$/.test(p)) { setMessage({ kind: 'err', text: 'Patti must be 3 digits.' }); return; }
      if (!/^\d$/.test(d)) { setMessage({ kind: 'err', text: 'Digit must be 0-9.' }); return; }
      num = `${p}-${d}`;
    } else {
      num = manualNumber.trim().padStart(betInfo.maxLength === 1 ? 1 : betInfo.maxLength, '0');
    }
    if (betInfo.inputType === 'digit') {
      if (!/^\d$/.test(num)) { setMessage({ kind: 'err', text: 'Enter a single digit (0-9).' }); return; }
    } else if (betInfo.inputType === 'jodi') {
      if (!/^\d{2}$/.test(num)) { setMessage({ kind: 'err', text: 'Enter a 2-digit number (00-99).' }); return; }
    } else if (betInfo.inputType === 'patti_combo') {
      if (!isValidPattiCombo(num)) { setMessage({ kind: 'err', text: 'Enter a valid patti + digit combination (e.g. 123-6).' }); return; }
    }
    const pts = Number(manualPoints);
    if (!Number.isInteger(pts) || pts < 1 || pts > betLimits.maxPerBet) {
      setMessage({ kind: 'err', text: `Stake must be a whole number from 1 to ${betLimits.maxPerBet}.` });
      return;
    }
    if (lockedMap.has(num)) {
      setMessage({ kind: 'err', text: `${num} is already locked.` });
      return;
    }
    addPending(num, pts);
    setManualNumber('');
    setManualPatti('');
    setManualDigit('');
  };

  const pendingSorted = [...pending].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const betSlip = calculateBetSlip(pendingSorted, profile?.points ?? 0, profile?.wallet ?? 0, betInfo.multiplier);
  const newTotal = betSlip.totalCost;
  const lockedTotal = lockedEntries.reduce((sum, [, p]) => sum + p, 0);
  const balance = (profile?.points ?? 0) + (profile?.wallet ?? 0);
  const insufficient = newTotal > balance;
  const invalidEntry = pendingSorted.some((p) =>
    !Number.isInteger(p.points) || p.points < 1 || p.points > betLimits.maxPerBet
  );
  const exceedsSubmitLimit = newTotal > betLimits.maxPerSubmit;

  const handleSave = async () => {
    if (submittingRef.current) return;
    if (!profile) return;
    if (pendingSorted.length === 0) {
      setMessage({ kind: 'err', text: 'Add at least one new pick first.' });
      return;
    }
    if (invalidEntry) {
      setMessage({ kind: 'err', text: `Every pick needs a whole-number stake from 1 to ${betLimits.maxPerBet}.` });
      return;
    }
    if (exceedsSubmitLimit) {
      setMessage({ kind: 'err', text: `A single submit can total at most ${betLimits.maxPerSubmit} points.` });
      return;
    }
    if (insufficient) {
      setMessage({ kind: 'err', text: `You need ${newTotal} balance but only have ${balance} available.` });
      return;
    }
    if (!status || !betOpen) {
      setMessage({ kind: 'err', text: 'Betting is closed for this bet type right now.' });
      return;
    }

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
      const result = data as { new_count: number; new_points: number };
      await loadSaved(profile.id, status.round_date);
      setPending([]);
      setConfirmationOpen(false);
      setMessage({ kind: 'ok', text: `Submitted ${result.new_count} pick(s) for ${result.new_points} balance.` });
      onPointsChanged();
    } catch (err) {
      const { message: friendlyMessage, action } = friendlyError(err);
      const friendly = friendlyErrorDetails(err);
      setMessage({
        kind: 'err',
        text: friendlyMessage,
        raw: friendly.raw,
        action,
      });
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const tabs: { id: Tab; label: string; multiplier: number; color: string }[] = [
    { id: 'single_open', label: 'Open', multiplier: 9, color: 'emerald' },
    { id: 'single_close', label: 'Close', multiplier: 9, color: 'cyan' },
    { id: 'jodi', label: 'Jodi', multiplier: 90, color: 'amber' },
    { id: 'patti_open', label: 'O Patti', multiplier: 120, color: 'emerald' },
    { id: 'patti_close', label: 'C Patti', multiplier: 120, color: 'cyan' },
  ];

  const tabColorMap: Record<string, { active: string; text: string; bg: string }> = {
    emerald: { active: 'bg-emerald-500 text-white', text: 'text-emerald-400', bg: 'bg-emerald-950/40' },
    cyan: { active: 'bg-cyan-500 text-white', text: 'text-cyan-400', bg: 'bg-cyan-950/40' },
    amber: { active: 'bg-amber-500 text-white', text: 'text-amber-400', bg: 'bg-amber-950/40' },
  };

  const renderGrid = () => {
    if (betInfo.inputType === 'digit') {
      return (
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: 10 }, (_, n) => {
            const label = String(n);
            const isLocked = lockedMap.has(label);
            const isPending = pending.find((p) => p.number === label);
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (isLocked) return;
                  if (isPending) removePending(label);
                  else {
                    const points = Number(manualPoints);
                    if (!Number.isInteger(points) || points < 1 || points > betLimits.maxPerBet) {
                      setMessage({ kind: 'err', text: `Stake must be a whole number from 1 to ${betLimits.maxPerBet}.` });
                      return;
                    }
                    addPending(label, points);
                  }
                }}
                disabled={isLocked}
                className={`aspect-square rounded-xl text-base font-bold border transition-all active:scale-90 ${
                  isLocked
                    ? 'bg-slate-800 text-slate-400 border-slate-700'
                    : isPending
                    ? 'bg-emerald-500 text-white border-emerald-500 shadow-lg shadow-emerald-500/20'
                    : 'bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-600 hover:bg-slate-700'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      );
    } else if (betInfo.inputType === 'jodi') {
      return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1.5">
          {Array.from({ length: 100 }, (_, n) => {
            const label = String(n).padStart(2, '0');
            const isLocked = lockedMap.has(label);
            const isPending = pending.find((p) => p.number === label);
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  if (isLocked) return;
                  if (isPending) removePending(label);
                  else {
                    const points = Number(manualPoints);
                    if (!Number.isInteger(points) || points < 1 || points > betLimits.maxPerBet) {
                      setMessage({ kind: 'err', text: `Stake must be a whole number from 1 to ${betLimits.maxPerBet}.` });
                      return;
                    }
                    addPending(label, points);
                  }
                }}
                disabled={isLocked}
                className={`aspect-square rounded-lg text-xs font-medium border transition-all active:scale-90 ${
                  isLocked
                    ? 'bg-slate-800 text-slate-400 border-slate-700'
                    : isPending
                    ? 'bg-amber-500 text-white border-amber-500 shadow-md shadow-amber-500/15'
                    : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600 hover:bg-slate-700'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />

      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="tap-target text-slate-400 hover:text-white transition-colors p-1" aria-label="Back">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h2 className="font-bold text-white leading-tight">{GAME_LABELS[game]}</h2>
              <p className="text-[11px] text-slate-400 leading-tight">
                {lockedEntries.length} submitted · {pending.length} pending
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-lg font-bold text-white leading-tight">{formatNumber(balance)}</p>
              <p className="text-[11px] text-slate-400 leading-tight">playable</p>
            </div>
            <HelpButton />
          </div>
        </div>
      </header>

      {/* Result banner */}
      {result && (result.open_digit || result.close_digit) && (
        <div className="max-w-2xl mx-auto px-5 pt-5">
          <div className="border border-slate-800 bg-slate-900/80 rounded-2xl p-4 animate-slide-up">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5 text-amber-400" />
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {result.round_date === status?.round_date ? "Today's result" : `Latest result — ${result.round_date}`}
                </p>
              </div>
              <p className="text-xs text-slate-400">{result.round_date}</p>
            </div>
            <div className="flex items-center justify-center gap-2 sm:gap-4 py-2">
              {result.open_patti && <span className="text-base font-bold text-slate-400">{result.open_patti}</span>}
              {result.open_digit && <span className="text-3xl font-bold text-emerald-400">{result.open_digit}</span>}
              {result.close_digit && <span className="text-3xl font-bold text-cyan-400">{result.close_digit}</span>}
              {result.close_patti && <span className="text-base font-bold text-slate-400">{result.close_patti}</span>}
              {!result.open_digit && !result.close_digit && <span className="text-sm text-slate-400">Awaiting results</span>}
            </div>
            <div className="flex justify-center gap-4 mt-1">
              {result.open_digit && <p className="text-[11px] text-slate-400">Open: {result.open_posted_at ? formatDate(result.open_posted_at, { hour: '2-digit', minute: '2-digit' }) : ''}</p>}
              {result.close_digit && <p className="text-[11px] text-slate-400">Close: {result.close_posted_at ? formatDate(result.close_posted_at, { hour: '2-digit', minute: '2-digit' }) : ''}</p>}
            </div>
          </div>
        </div>
      )}

      {checkedStatus && !betOpen && (
        <div className="max-w-2xl mx-auto px-5 pt-5">
          <div className="flex items-center gap-2.5 border border-slate-800 bg-slate-900/80 rounded-2xl p-4">
            <Lock className="w-4 h-4 text-slate-400 shrink-0" />
            <p className="text-sm text-slate-400">
              {status
                ? `This bet type is closed. Open bets close ${formatScheduleTime(status.open_bets_close_at, locale)}; close bets close ${formatScheduleTime(status.close_bets_close_at, locale)} (IST). You can still view results below.`
                : `Betting is unavailable because the game schedule could not be loaded${statusError ? `: ${statusError}` : '.'}`}
            </p>
            {!status && statusErrorDetails && <p className="mt-1 text-xs text-rose-400/70">{statusErrorDetails}</p>}
            {!status && <button type="button" onClick={() => void refresh()} className="ml-auto text-xs font-semibold text-slate-300">Retry</button>}
          </div>
        </div>
      )}
      {restriction && (
        <div className="max-w-2xl mx-auto px-5 pt-4">
          <div className="rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            {restriction.kind === 'cooldown' ? 'Betting break active' : 'Self-exclusion active'} until {formatLimitEnd(restriction.until)}. Betting is disabled.
          </div>
        </div>
      )}

      {status && (
        <div className="max-w-2xl mx-auto px-5 pt-4">
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
            {([
              ['Open bets', status.open_bets_open, status.open_bets_close_ts, status.open_bets_close_at],
              ['Close bets', status.close_bets_open, status.close_bets_close_ts, status.close_bets_close_at],
            ] as const).map(([label, isOpen, cutoffTs, cutoffAt]) => {
              const tone = isOpen ? countdownTone(cutoffTs, nowMs) : 'closed';
              return (
                <p key={label} className={tone === 'red' || tone === 'closed' ? 'text-rose-400' : tone === 'amber' ? 'text-amber-400' : 'text-slate-400'}>
                  {label} · {formatScheduleTime(cutoffAt, locale)} IST · {formatBetWindow(isOpen, cutoffTs, status.bets_open_at, nowMs)}
                  <CountdownAnnouncement cutoff={cutoffTs} opensAt={status.bets_open_at} isOpen={isOpen} nowMs={nowMs} label={label} />
                </p>
              );
            })}
          </div>
        </div>
      )}

      <main className="max-w-2xl mx-auto px-5 py-6 space-y-6 relative z-10">
        {/* Bet type tabs */}
        <div className="flex gap-1 border border-slate-800 rounded-2xl bg-slate-900/80 p-1 overflow-x-auto">
          {tabs.map((t) => {
            const colors = tabColorMap[t.color];
            const typeCutoff = status
              ? isCloseBet(t.id) ? status.close_bets_close_ts : status.open_bets_close_ts
              : '';
            const typeClosed = !status
              || (isCloseBet(t.id) ? !status.close_bets_open : !status.open_bets_open)
              || countdownTone(typeCutoff, nowMs) === 'closed';
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                disabled={typeClosed}
                className={`flex flex-col items-center px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex-1 ${
                  tab === t.id
                    ? colors.active
                    : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                <span>{t.label}</span>
                <span className={`text-[10px] ${tab === t.id ? 'text-white/70' : 'text-slate-400'}`}>{t.multiplier}x</span>
              </button>
            );
          })}
        </div>

        {/* Bet info banner */}
        <div className="flex items-center gap-2 px-1">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <p className="text-xs text-slate-400">{betInfo.description}</p>
        </div>

        {/* Manual entry */}
        {betOpen && (
          <section className="border border-slate-800 rounded-2xl bg-slate-900/80 p-4">
            <div className="flex items-center gap-2 mb-3">
              {betInfo.inputType === 'digit' ? <Hash className="w-3.5 h-3.5 text-emerald-400" /> :
               betInfo.inputType === 'jodi' ? <Grid3x3 className="w-3.5 h-3.5 text-amber-400" /> :
               <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />}
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide">Add picks</h3>
            </div>

            {betInfo.inputType !== 'patti_combo' && (
              <p className="text-xs text-slate-400 mb-3">
                Tap a number to add it with the stake below. Tap again to remove.
              </p>
            )}

            {(betInfo.inputType === 'digit' || betInfo.inputType === 'jodi') && (
              <div className="mb-4">
                {loading ? (
                  <CardSkeleton />
                ) : (
                  renderGrid()
                )}
              </div>
            )}

            {/* Balance selector */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <label htmlFor="selection-stake" className="text-xs text-slate-400 whitespace-nowrap">Stake per pick:</label>
              <input
                id="selection-stake"
                type="number"
                min={1}
                max={betLimits.maxPerBet}
                step={1}
                inputMode="numeric"
                value={manualPoints}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                onChange={(e) => setManualPoints(e.target.value)}
                className="w-20 px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1">
                {betLimits.quickStakes.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setManualPoints(String(v))}
                    className="px-2 py-1 rounded-md bg-slate-800 text-slate-400 text-xs font-medium hover:bg-slate-700 hover:text-white transition-colors"
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {pendingSorted.length > 0 && (
              <button
                type="button"
                onClick={() => setPending((items) => items.map((pick) => ({
                  ...pick,
                  points: Number(manualPoints) || 0,
                })))}
                className="text-xs text-cyan-400 hover:text-cyan-300 mb-3"
              >
                Apply {manualPoints || 'stake'} to all pending picks
              </button>
            )}

            {/* Manual entry for patti_combo */}
            {betInfo.inputType === 'patti_combo' && (
              <div className="space-y-3 mb-3">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-slate-400 mb-1">Patti (000-999)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{3}"
                      value={manualPatti}
                      onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                      onChange={(e) => setManualPatti(e.target.value.replace(/\D/g, '').slice(0, 3))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleManualAdd(); }}
                      placeholder="e.g. 123"
                      maxLength={3}
                      className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
                    />
                  </div>
                  <div className="w-20">
                    <label className="block text-xs text-slate-400 mb-1">Digit</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]"
                      value={manualDigit}
                      onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                      onChange={(e) => setManualDigit(e.target.value.replace(/\D/g, '').slice(0, 1))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleManualAdd(); }}
                      placeholder="e.g. 6"
                      maxLength={1}
                      className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
                    />
                  </div>
                </div>
                <button
                  onClick={handleManualAdd}
                  disabled={!manualPatti || manualPatti.length < 3 || !manualDigit}
                  className="px-4 py-2.5 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-400 disabled:opacity-40 transition-colors flex items-center gap-1 w-full justify-center"
                >
                  <Plus className="w-4 h-4" /> Add {manualPatti && manualDigit ? `${manualPatti}-${manualDigit}` : 'pick'}
                </button>
              </div>
            )}

            {/* Pending picks */}
            {pendingSorted.length > 0 && (
              <div className="space-y-2">
                {invalidEntry && (
                  <p className="text-xs text-rose-400">Each pick must have a whole-number stake from 1 to {betLimits.maxPerBet}.</p>
                )}
                {exceedsSubmitLimit && (
                  <p className="text-xs text-rose-400">Total stake exceeds the {betLimits.maxPerSubmit} per-submit limit.</p>
                )}
                {pendingSorted.map((p) => (
                  <div key={p.number} className="flex items-center gap-3 border border-slate-700 rounded-lg bg-slate-800/50 px-3 py-2 animate-scale-in">
                    <span className="font-bold text-white w-12 sm:w-14">{p.number}</span>
                    <input
                      type="number"
                      min={1}
                      max={betLimits.maxPerBet}
                      step={1}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={p.points}
                      onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                      onChange={(e) => updatePendingPoints(p.number, e.target.value === '' ? 0 : Number(e.target.value))}
                      className="flex-1 max-w-[100px] px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
                    />
                    <span className="text-xs text-emerald-400 font-medium">{betInfo.multiplier}x = {p.points * betInfo.multiplier}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${p.number} pick`}
                      onClick={() => removePending(p.number)}
                      className="tap-target text-slate-400 hover:text-rose-400 transition-colors text-lg leading-none"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between text-xs pt-1">
                  <button onClick={clearPending} className="text-slate-400 hover:text-slate-300">Clear all</button>
                  <span className="text-slate-400">
                    Cost: <span className="font-bold text-white">{newTotal}</span> points
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* Submit button */}
        {betOpen && pendingSorted.length > 0 && (
          <div className="space-y-2 animate-slide-up">
            {insufficient && (
              <p className="text-sm text-rose-400 text-center">
                Not enough balance. You have {balance} but picks cost {newTotal}.
              </p>
            )}
            <button
              onClick={() => { setMessage(null); setConfirmationOpen(true); }}
              disabled={saving || !betOpen}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-sm font-bold hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  Review {pendingSorted.length} pick{pendingSorted.length > 1 ? 's' : ''} · {newTotal} points
                </>
              )}
            </button>
          </div>
        )}

        {/* Submitted (locked) picks */}
        {lockedEntries.length > 0 && (
          <section>
            <div className="flex items-center gap-1.5 mb-3">
              <Lock className="w-3 h-3 text-slate-400" />
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide">Submitted picks — {betInfo.label}</h3>
            </div>
            <div className="border border-slate-800 rounded-2xl bg-slate-900/80 divide-y divide-slate-800">
              {lockedEntries.map(([number, points]) => (
                <div key={number} className="flex items-center justify-between px-4 py-3">
                  <span className="font-bold text-white">{number}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-slate-400">{points} balance</span>
                    <span className="text-xs text-emerald-400 font-medium">→ {points * betInfo.multiplier} balance</span>
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between px-4 py-3 bg-slate-900/50">
                <span className="text-xs text-slate-400">Total spent</span>
                <span className="text-sm font-medium text-slate-300">{lockedTotal} balance</span>
              </div>
            </div>
          </section>
        )}

        {message && (!confirmationOpen || message.kind === 'ok') && (
          <div role={message.kind === 'err' ? 'alert' : 'status'} className={`flex items-start gap-2 text-sm rounded-xl px-4 py-3 animate-scale-in ${
            message.kind === 'ok'
              ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-900'
              : 'text-rose-400 bg-rose-950/40 border border-rose-900'
          }`}>
            {message.kind === 'ok' && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <span>{message.text}</span>
          </div>
        )}
      </main>
      {confirmationOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6">
          <section
            ref={confirmationRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bet-slip-title"
            className="w-full max-w-lg max-h-full overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <h2 id="bet-slip-title" className="text-lg font-bold text-white">{t('betslip.title')}</h2>
            <p className="mt-1 text-xs text-amber-300">{t('betslip.locked')}</p>
            <div className="mt-4 max-h-56 overflow-y-auto divide-y divide-slate-800 rounded-xl border border-slate-800">
              {pendingSorted.map((pick, index) => (
                <div key={pick.number} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <span className="font-bold text-white">{pick.number}</span>
                  <span className="text-slate-400">{interpolate(t('betslip.stake'), { points: formatNumber(pick.points) })}</span>
                  <span className="text-emerald-400">{interpolate(t('betslip.potentialWin'), { amount: formatNumber(betSlip.potentialWins[index]) })}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2 rounded-xl bg-slate-800/70 p-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">{t('betslip.pickCount')}</span><span>{betSlip.pickCount}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">{t('betslip.totalCost')}</span><span className="font-bold text-white">{interpolate(t('betslip.totalCostValue'), { points: formatNumber(newTotal) })}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">{t('betslip.balanceAfter')}</span><span /></div>
              <div className="flex justify-between pl-3 text-xs"><span className="text-slate-400">{t('betslip.play')}</span><span>{formatNumber(betSlip.playAfterBet)}</span></div>
              <div className="flex justify-between pl-3 text-xs"><span className="text-slate-400">{t('betslip.wallet')}</span><span>{formatNumber(betSlip.walletAfterBet)}</span></div>
            </div>
            {(insufficient || invalidEntry || exceedsSubmitLimit) && (
              <div className="mt-3 space-y-1 text-xs text-rose-300">
                {insufficient && <p>{interpolate(t('betslip.notEnough'), { balance: formatNumber(balance), total: formatNumber(newTotal) })}</p>}
                {invalidEntry && <p>{interpolate(t('betslip.stakeRange'), { max: formatNumber(betLimits.maxPerBet) })}</p>}
                {exceedsSubmitLimit && <p>{interpolate(t('betslip.submitLimit'), { max: formatNumber(betLimits.maxPerSubmit) })}</p>}
                {insufficient && (
                  <button type="button" onClick={onAddFunds} className="pt-1 text-xs font-semibold text-emerald-300 hover:text-emerald-200">
                    {t('betslip.addFunds')}
                  </button>
                )}
              </div>
            )}
            {message?.kind === 'err' && (
              <div role="alert" className="mt-3 rounded-xl border border-rose-900 bg-rose-950/40 px-3 py-2.5 text-sm text-rose-300">
                <p>{message.text}</p>
                {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
                {message.action === 'add_funds' && (
                  <button type="button" onClick={onAddFunds} className="mt-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200">
                    {t('betslip.addFunds')}
                  </button>
                )}
              </div>
            )}
            <div className="sticky bottom-0 mt-5 grid grid-cols-2 gap-3 bg-slate-900 pb-[env(safe-area-inset-bottom)]">
              <button
                type="button"
                onClick={() => { setConfirmationOpen(false); setMessage(null); }}
                disabled={saving}
                className="rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {t('betslip.back')}
              </button>
              <button
                type="button"
                onClick={() => { void handleSave(); }}
                disabled={saving || !betOpen || insufficient || invalidEntry || exceedsSubmitLimit || pendingSorted.length === 0}
                className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-3 text-sm font-bold text-white hover:from-emerald-400 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('betslip.confirm')}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
