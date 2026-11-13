import { useId, useState } from 'react';
import { CalendarOff, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { formatHolidayDate, isOnHoliday } from '@/lib/holiday';
import type { GameStatus } from '@/types';
import { GAME_LABELS } from '@/types';

interface HolidaySettingsProps {
  statuses: GameStatus[];
  onChanged: () => void;
}

const inputClass = 'w-full min-w-0 px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none';

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function GameHolidayRow({ status, onChanged }: { status: GameStatus; onChanged: () => void }) {
  const id = useId();
  const onHoliday = isOnHoliday(status);
  const tomorrow = addDays(status.server_ist_date, 1);
  const [reopensOn, setReopensOn] = useState(status.holiday_reopens_on ?? tomorrow);
  const [note, setNote] = useState(status.holiday_note ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string; raw?: string } | null>(null);
  const label = status.label || GAME_LABELS[status.game] || status.game;

  const save = async (nextReopensOn: string | null) => {
    if (nextReopensOn === null && !window.confirm(`End the holiday for ${label} now? Betting will open again on the normal schedule.`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await supabase.rpc('admin_set_game_holiday', {
        p_game: status.game,
        p_reopens_on: nextReopensOn,
        p_note: nextReopensOn ? note : null,
      });
      if (error) {
        const friendly = friendlyError(error);
        setMessage({ kind: 'err', text: friendly.message, raw: friendly.key === 'errors.generic' ? rawErrorMessage(error) : undefined });
      } else {
        setMessage({
          kind: 'ok',
          text: nextReopensOn ? `${label} is on holiday. It restarts on ${formatHolidayDate(nextReopensOn)}.` : `${label} holiday ended.`,
        });
        onChanged();
      }
    } catch (error) {
      const friendly = friendlyError(error);
      setMessage({ kind: 'err', text: friendly.message, raw: rawErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-control border border-surface-border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-strong">{label}</p>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${onHoliday ? 'bg-amber-950 text-amber-300' : 'bg-emerald-950 text-emerald-400'}`}>
          {onHoliday && status.holiday_reopens_on ? `On holiday until ${formatHolidayDate(status.holiday_reopens_on)}` : 'Running normally'}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-date`} className="block text-xs text-ink-muted mb-1.5">Game restarts on (IST)</label>
          <input id={`${id}-date`} type="date" min={tomorrow} value={reopensOn} onChange={(event) => setReopensOn(event.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`${id}-note`} className="block text-xs text-ink-muted mb-1.5">Note for players (optional)</label>
          <input id={`${id}-note`} type="text" maxLength={160} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Diwali holiday" className={inputClass} />
        </div>
      </div>
      <p className="text-xs text-ink-muted">No bets are accepted until the restart date. On that date betting opens again by itself at the normal time.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={saving || !reopensOn} onClick={() => void save(reopensOn)}
          className="tap-target px-4 py-2.5 rounded-lg bg-amber-600 text-ink-strong text-sm font-medium hover:bg-amber-500 disabled:opacity-40">
          {onHoliday ? 'Update holiday' : 'Start holiday'}
        </button>
        {onHoliday && (
          <button type="button" disabled={saving} onClick={() => void save(null)}
            className="tap-target px-4 py-2.5 rounded-lg border border-surface-strong text-slate-200 text-sm font-medium hover:bg-surface-raised disabled:opacity-40">
            End holiday now
          </button>
        )}
      </div>
      {message && (
        <div role={message.kind === 'err' ? 'alert' : 'status'} className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2.5 ${message.kind === 'ok' ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-900' : 'text-rose-400 bg-rose-950/40 border border-rose-900'}`}>
          {message.kind === 'ok' && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          <div>
            <p>{message.text}</p>
            {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HolidaySettings({ statuses, onChanged }: HolidaySettingsProps) {
  return (
    <section className="mt-4 border border-surface-border rounded-card bg-surface/80 p-5 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <CalendarOff className="w-4 h-4 text-amber-400" />
        <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wide">Holidays</h3>
      </div>
      {statuses.length === 0
        ? <p className="text-sm text-ink-muted">Loading games…</p>
        : statuses.map((status) => (
          <GameHolidayRow key={`${status.game}-${status.holiday_reopens_on ?? 'none'}`} status={status} onChanged={onChanged} />
        ))}
    </section>
  );
}
