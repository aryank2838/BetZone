import { Ban, Coins, Loader2, Search, Shield, UserCog, Wallet } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';

export interface AdminUser {
  id: string;
  display_name: string;
  email: string;
  points: number;
  wallet: number;
  is_admin: boolean;
  is_banned: boolean;
  created_at: string;
}

interface UsersTabProps {
  users: AdminUser[];
  search: string;
  status: string;
  from: string;
  to: string;
  loading: boolean;
  hasMore: boolean;
  actionId: string | null;
  message: { kind: 'ok' | 'err'; text: string; raw?: string } | null;
  onSearchChange: (value: string) => void;
  onFilterChange: (filter: { status: string; from: string; to: string }) => void;
  onSearch: () => void;
  onLoadMore: () => void;
  onViewDetail: (user: AdminUser) => void;
  onAdjust: (user: AdminUser, type: 'points' | 'wallet') => void;
  onToggleBan: (user: AdminUser) => void;
  onSetAdmin: (user: AdminUser, isAdmin: boolean) => void;
}

export default function UsersTab(props: UsersTabProps) {
  const { formatNumber, formatDate } = useFormat();
  const { users, search, status, from, to, loading, hasMore, actionId, message, onSearchChange, onFilterChange, onSearch, onLoadMore, onViewDetail, onAdjust, onToggleBan, onSetAdmin } = props;
  return (
    <section className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') onSearch(); }}
            placeholder="Search by name or email..."
            className="w-full pl-9 pr-3 py-2.5 rounded-control bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
          />
        </div>
        <select value={status} onChange={(event) => onFilterChange({ status: event.target.value, from, to })} className="rounded-control border border-surface-strong bg-surface-raised px-3 py-2.5 text-sm text-ink-strong">
          <option value="">All statuses</option><option value="active">Active</option><option value="banned">Banned</option><option value="admin">Admins</option><option value="non_admin">Non-admins</option>
        </select>
        <label className="text-xs text-ink-muted">Created from (IST)<input type="date" value={from} onChange={(event) => onFilterChange({ status, from: event.target.value, to })} className="mt-1 w-full rounded-lg border border-surface-strong bg-surface-raised p-2 text-xs text-ink-strong" /></label>
        <label className="text-xs text-ink-muted">Created to (IST)<input type="date" value={to} onChange={(event) => onFilterChange({ status, from, to: event.target.value })} className="mt-1 w-full rounded-lg border border-surface-strong bg-surface-raised p-2 text-xs text-ink-strong" /></label>
        <button onClick={onSearch} disabled={loading} className="col-span-2 rounded-control bg-slate-700 px-4 min-h-tap py-2.5 text-sm font-medium text-ink-strong hover:bg-slate-600 disabled:opacity-40 transition-colors">Apply filters</button>
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : users.length === 0 ? (
        <p className="text-sm text-ink-muted text-center py-6">No users found.</p>
      ) : (
        <div className="space-y-2">
          {users.map((user) => (
            <div key={user.id} className="border border-surface-border rounded-control bg-surface/80 p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ${user.is_banned ? 'bg-rose-950 text-rose-400' : user.is_admin ? 'bg-amber-950 text-amber-400' : 'bg-surface-raised text-ink-muted'}`}>
                    {user.display_name.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-ink-strong">{user.display_name || 'Unnamed'}</p>
                      {user.is_admin && <Shield className="w-3 h-3 text-amber-400" />}
                      {user.is_banned && <Ban className="w-3 h-3 text-rose-400" />}
                    </div>
                    <p className="text-xs text-ink-muted">{user.email}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-ink-muted">Play: {formatNumber(user.points)} | Wallet: {formatNumber(user.wallet)}</p>
                  <p className="text-xs text-ink-muted">{formatDate(user.created_at)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => onViewDetail(user)} className="px-3 min-h-tap py-2.5 rounded-lg bg-cyan-950 text-cyan-300 text-sm font-medium hover:bg-cyan-900 transition-colors">View details</button>
                <button onClick={() => onAdjust(user, 'points')} className="px-3 min-h-tap py-2.5 rounded-lg bg-surface-raised text-ink-soft text-sm font-medium hover:bg-surface-strong transition-colors flex items-center gap-1">
                  <Coins className="w-3 h-3" /> Adjust play balance
                </button>
                <button onClick={() => onAdjust(user, 'wallet')} className="px-3 min-h-tap py-2.5 rounded-lg bg-surface-raised text-ink-soft text-sm font-medium hover:bg-surface-strong transition-colors flex items-center gap-1">
                  <Wallet className="w-3 h-3" /> Adjust wallet
                </button>
                <button onClick={() => onSetAdmin(user, !user.is_admin)} disabled={actionId === user.id} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 disabled:opacity-40 ${user.is_admin ? 'bg-amber-950 text-amber-400 hover:bg-amber-900' : 'bg-cyan-950 text-cyan-400 hover:bg-cyan-900'}`}>
                  <UserCog className="w-3 h-3" /> {user.is_admin ? 'Remove admin' : 'Make admin'}
                </button>
                <button onClick={() => onToggleBan(user)} disabled={actionId === user.id} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 disabled:opacity-40 ${user.is_banned ? 'bg-emerald-950 text-emerald-400 hover:bg-emerald-900' : 'bg-rose-950 text-rose-400 hover:bg-rose-900'}`}>
                  {actionId === user.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                  {user.is_banned ? 'Unban' : 'Ban'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {message && (
        <div role={message.kind === 'err' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
          <p>{message.text}</p>
          {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
        </div>
      )}
      {!loading && hasMore && (
        <button onClick={onLoadMore} className="w-full min-h-tap py-2.5 rounded-control border border-surface-border bg-surface/80 text-sm font-medium text-ink-muted hover:bg-surface-raised">
          Load more users
        </button>
      )}
    </section>
  );
}
