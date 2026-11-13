import { Ban, Coins, Plus, Shield, TrendingUp, Users, Wallet } from 'lucide-react';
import type { AdminGameOption } from './gameOptions';
import { BET_TYPES, type BetType, type Game } from '@/types';
import { CardSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';

export interface AdminStats {
  total_users: number;
  banned_users: number;
  admin_count: number;
  total_points: number;
  total_wallet: number;
  pending_withdrawals_count: number;
  pending_withdrawals_amount: number;
  pending_addfunds_count: number;
  pending_addfunds_amount: number;
  round_date: string;
  selection_counts: Record<Game, Record<BetType, number>>;
}

interface StatsTabProps {
  games: AdminGameOption[];
  stats: AdminStats | null;
  loading: boolean;
  roundDate: string;
  onRoundDateChange: (date: string) => void;
}

export default function StatsTab({ games, stats, loading, roundDate, onRoundDateChange }: StatsTabProps) {
  if (loading) {
    return <div className="grid grid-cols-2 gap-3"><CardSkeleton /><CardSkeleton /><CardSkeleton /><CardSkeleton /></div>;
  }
  if (!stats) return null;

  return (
    <section className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={Users} label="Total users" value={stats.total_users} color="cyan" />
        <StatCard icon={Ban} label="Banned users" value={stats.banned_users} color="rose" />
        <StatCard icon={Coins} label="Play balance" value={stats.total_points} color="amber" />
        <StatCard icon={Wallet} label="Wallet balance" value={stats.total_wallet} color="emerald" />
      </div>

      <div>
        <label className="block text-xs text-ink-muted mb-1.5">Selection round date (IST)</label>
        <input
          type="date"
          value={roundDate}
          onChange={(event) => onRoundDateChange(event.target.value)}
          className="w-full px-4 py-3 rounded-control bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
        />
      </div>

      <div className="border border-surface-border rounded-card bg-surface/80 p-4 space-y-3">
        <h4 className="text-xs font-medium text-ink-muted uppercase tracking-wide">Pending requests</h4>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-3 p-3 rounded-control bg-amber-950/30 border border-amber-900">
            <Wallet className="w-4 h-4 text-amber-400" />
            <div>
              <p className="text-lg font-bold text-amber-300">{stats.pending_withdrawals_count}</p>
              <p className="text-xs text-amber-600">Withdrawals ({stats.pending_withdrawals_amount} balance)</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-control bg-cyan-950/30 border border-cyan-900">
            <Plus className="w-4 h-4 text-cyan-400" />
            <div>
              <p className="text-lg font-bold text-cyan-300">{stats.pending_addfunds_count}</p>
              <p className="text-xs text-cyan-600">Add funds ({stats.pending_addfunds_amount} balance)</p>
            </div>
          </div>
        </div>
      </div>

      <div className="border border-surface-border rounded-card bg-surface/80 p-4 space-y-3">
        <h4 className="text-xs font-medium text-ink-muted uppercase tracking-wide">Selections by game and bet type · {stats.round_date}</h4>
        {games.map(({ game, label }) => (
          <div key={game} className="space-y-2">
            <p className="text-xs font-medium text-ink-soft">{label}</p>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(BET_TYPES) as BetType[]).map((betType) => (
                <div key={betType} className="flex items-center gap-2 p-2.5 rounded-lg bg-surface-raised/50 border border-surface-strong/50">
                  <TrendingUp className="w-3.5 h-3.5 text-ink-muted" />
                  <div>
                    <p className="text-sm font-semibold text-ink-strong">{stats.selection_counts?.[game]?.[betType] ?? 0}</p>
                    <p className="text-xs text-ink-muted">{BET_TYPES[betType].label}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 p-3 rounded-control bg-surface-raised/50 border border-surface-strong">
        <Shield className="w-4 h-4 text-amber-400" />
        <p className="text-xs text-ink-muted">{stats.admin_count} admin(s) on this platform.</p>
      </div>
    </section>
  );
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: typeof Users;
  label: string;
  value: number;
  color: 'cyan' | 'rose' | 'amber' | 'emerald';
}) {
  const { formatNumber } = useFormat();
  const colors = {
    cyan: 'bg-cyan-950/40 text-cyan-400 border-cyan-900',
    rose: 'bg-rose-950/40 text-rose-400 border-rose-900',
    amber: 'bg-amber-950/40 text-amber-400 border-amber-900',
    emerald: 'bg-emerald-950/40 text-emerald-400 border-emerald-900',
  }[color];
  return (
    <div className={`border rounded-control p-4 ${colors}`}>
      <Icon className="w-4 h-4 mb-2" />
      <p className="text-2xl font-bold">{formatNumber(value)}</p>
      <p className="text-xs opacity-70">{label}</p>
    </div>
  );
}
