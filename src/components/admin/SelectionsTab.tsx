import { ListChecks, Users } from 'lucide-react';
import type { AdminGameOption } from './gameOptions';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';
import type { Game, SelectionEntry } from '@/types';

export interface AdminSelection {
  id: string;
  user_id: string;
  user_name: string;
  bet_type: string;
  round_date: string;
  selections: SelectionEntry[];
  total_points: number;
  updated_at: string;
}

interface SelectionsTabProps {
  games: AdminGameOption[];
  game: Game;
  roundDate: string;
  selections: AdminSelection[];
  loading: boolean;
  onGameChange: (game: Game) => void;
  onRoundDateChange: (date: string) => void;
}

export default function SelectionsTab({
  games,
  game,
  roundDate,
  selections,
  loading,
  onGameChange,
  onRoundDateChange,
}: SelectionsTabProps) {
  const { formatDate } = useFormat();
  return (
    <section className="space-y-4 animate-fade-in">
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs text-ink-muted mb-1.5">Game</label>
          <select
            value={game}
            onChange={(event) => onGameChange(event.target.value as Game)}
            className="w-full px-4 py-3 rounded-control bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
          >
            {games.map((option) => <option key={option.game} value={option.game}>{option.label}</option>)}
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs text-ink-muted mb-1.5">Round date (IST)</label>
          <input
            type="date"
            value={roundDate}
            onChange={(event) => onRoundDateChange(event.target.value)}
            className="w-full px-4 py-3 rounded-control bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
          />
        </div>
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : selections.length === 0 ? (
        <div className="border border-dashed border-surface-border rounded-control py-8 px-4 text-center">
          <ListChecks className="w-5 h-5 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-ink-muted">No selections for this round.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {selections.map((selection) => (
            <div key={selection.id} className="border border-surface-border rounded-control bg-surface/80 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Users className="w-3.5 h-3.5 text-ink-muted" />
                  <span className="text-sm font-medium text-ink-strong">{selection.user_name || 'Unnamed'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs px-1.5 py-0.5 rounded-md bg-surface-raised text-ink-muted font-medium">{selection.bet_type}</span>
                  <span className="text-sm font-bold text-ink-strong">{selection.total_points} balance</span>
                </div>
              </div>
              <p className="text-xs text-ink-muted mb-2">Round date: {selection.round_date}</p>
              <div className="flex flex-wrap gap-1.5 mb-1">
                {selection.selections.map((pick, index) => (
                  <span key={`${pick.number}-${index}`} className="px-2 py-1 rounded-md bg-surface-raised text-ink-soft text-xs font-medium">
                    {pick.number} ({pick.points})
                  </span>
                ))}
              </div>
              <p className="text-xs text-ink-muted">
                Updated {formatDate(selection.updated_at, { dateStyle: 'short', timeStyle: 'short' })}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
