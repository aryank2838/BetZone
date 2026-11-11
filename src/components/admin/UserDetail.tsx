import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CardSkeleton } from '@/components/Skeleton';
import { formatDate } from '@/i18n/format';
import { useFormat } from '@/i18n/useFormat';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { BET_TYPES, type BetType } from '@/types';
import { LEDGER_REASON_LABELS, ledgerMetadataSummary, picksSummary } from './userDetailFormat';

interface UserRecord {
  id: string;
  display_name: string;
  points: number;
  wallet: number;
  is_admin: boolean;
  is_banned: boolean;
  created_at: string;
  age_confirmed: boolean;
  terms_accepted_at: string | null;
  terms_version: string | null;
}

interface LimitsRecord {
  daily_deposit_limit: number | null;
  daily_loss_limit: number | null;
  pending_deposit_limit: number | null;
  pending_loss_limit: number | null;
  pending_effective_at: string | null;
  cooldown_until: string | null;
  self_excluded_until: string | null;
}

interface LedgerRow { id: string; delta: number; reason: string; metadata: unknown; created_at: string }
interface BetRow { id: string; game: string; round_date: string; bet_type: string; selections: unknown; total_points: number; created_at: string }
interface DepositRow { id: string; amount: number; status: string; payment_ref: string; created_at: string; processed_at: string | null; reject_reason: string | null }
interface WithdrawalRow { id: string; amount: number; status: string; upi_id: string; created_at: string; processed_at: string | null; reject_reason: string | null }
interface TicketRow { id: string; category: string; request_ref: string | null; message: string; status: string; admin_note: string | null; created_at: string; closed_at: string | null }

interface UserDetailData {
  profile: UserRecord;
  limits: LimitsRecord | null;
  ledger: LedgerRow[];
  bets: BetRow[];
  deposits: DepositRow[];
  withdrawals: WithdrawalRow[];
  tickets: TicketRow[];
}

const when = (value: string | null) => (value ? formatDate(value, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const statusTone = (status: string) => status === 'approved' || status === 'closed' ? 'text-emerald-400'
  : status === 'rejected' ? 'text-rose-400' : 'text-amber-300';

export default function UserDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const { formatNumber } = useFormat();
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error: rpcError } = await supabase.rpc('admin_get_user_detail', { p_user_id: userId });
        if (!active) return;
        if (rpcError) {
          const friendly = friendlyErrorDetails(rpcError);
          setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
        } else setDetail(data as UserDetailData);
      } catch (rpcError) {
        if (!active) return;
        const friendly = friendlyErrorDetails(rpcError);
        setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [userId]);

  return (
    <section className="space-y-5 animate-fade-in">
      <button type="button" onClick={onBack} className="tap-target flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Back to users</button>
      {loading ? <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div> : error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : detail && <>
        <header className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="text-lg font-semibold">{detail.profile.display_name || 'Unnamed user'}</h3>
          <p className="mt-1 break-all text-xs text-slate-400">{detail.profile.id}</p>
          <p className="mt-2 text-sm text-slate-300">Play balance {formatNumber(detail.profile.points)} · Wallet {formatNumber(detail.profile.wallet)}</p>
          <p className="mt-1 text-xs text-slate-400">Joined {when(detail.profile.created_at)} · {detail.profile.is_banned ? 'Banned' : 'Active'} · {detail.profile.is_admin ? 'Admin' : 'User'}</p>
          <p className="mt-1 text-xs text-slate-400">Age confirmed: {detail.profile.age_confirmed ? 'Yes' : 'No'} · Terms: {detail.profile.terms_version ? `${detail.profile.terms_version} (accepted ${when(detail.profile.terms_accepted_at)})` : 'Not accepted'}</p>
        </header>

        <Section title="Play limits">
          {detail.limits ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              <Field label="Daily deposit limit" value={detail.limits.daily_deposit_limit ?? 'None'} />
              <Field label="Daily loss limit" value={detail.limits.daily_loss_limit ?? 'None'} />
              {detail.limits.pending_effective_at && <Field label="Pending change" value={`deposit ${detail.limits.pending_deposit_limit ?? 'none'}, loss ${detail.limits.pending_loss_limit ?? 'none'} from ${when(detail.limits.pending_effective_at)}`} />}
              <Field label="Cooldown until" value={when(detail.limits.cooldown_until)} />
              <Field label="Self-excluded until" value={when(detail.limits.self_excluded_until)} />
            </dl>
          ) : <Empty text="No play limits set." />}
        </Section>

        <Section title="Recent ledger (up to 100)">
          {detail.ledger.length ? detail.ledger.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{LEDGER_REASON_LABELS[row.reason] ?? row.reason}</span>{ledgerMetadataSummary(row.metadata) && <span className="block text-slate-400">{ledgerMetadataSummary(row.metadata)}</span>}</>}
              right={<><span className={row.delta < 0 ? 'text-rose-300' : 'text-emerald-300'}>{row.delta > 0 ? '+' : ''}{formatNumber(row.delta)}</span><span className="block text-slate-400">{when(row.created_at)}</span></>} />
          )) : <Empty text="No ledger entries." />}
        </Section>

        <Section title="Recent bets (up to 50)">
          {detail.bets.length ? detail.bets.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{row.game} · {row.round_date} · {BET_TYPES[row.bet_type as BetType]?.label ?? row.bet_type}</span><span className="block break-all text-slate-400">Picks: {picksSummary(row.selections) || '—'}</span></>}
              right={<><span>Stake {formatNumber(row.total_points)}</span><span className="block text-slate-400">{when(row.created_at)}</span></>} />
          )) : <Empty text="No bets." />}
        </Section>

        <Section title="Deposits (up to 50)">
          {detail.deposits.length ? detail.deposits.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{formatNumber(row.amount)} · UTR {row.payment_ref}</span>{row.reject_reason && <span className="block text-rose-300/80">Reason: {row.reject_reason}</span>}</>}
              right={<><span className={statusTone(row.status)}>{row.status}</span><span className="block text-slate-400">{when(row.created_at)}</span></>} />
          )) : <Empty text="No deposits." />}
        </Section>

        <Section title="Withdrawals (up to 50)">
          {detail.withdrawals.length ? detail.withdrawals.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{formatNumber(row.amount)} to {row.upi_id}</span>{row.reject_reason && <span className="block text-rose-300/80">Reason: {row.reject_reason}</span>}</>}
              right={<><span className={statusTone(row.status)}>{row.status}</span><span className="block text-slate-400">{when(row.created_at)}</span></>} />
          )) : <Empty text="No withdrawals." />}
        </Section>

        <Section title="Support tickets (up to 50)">
          {detail.tickets.length ? detail.tickets.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium capitalize text-slate-200">{row.category}{row.request_ref ? ` · request ${row.request_ref}` : ''}</span><span className="block whitespace-pre-wrap text-slate-400">{row.message}</span>{row.admin_note && <span className="block text-cyan-300">Note: {row.admin_note}</span>}</>}
              right={<><span className={statusTone(row.status)}>{row.status}</span><span className="block text-slate-400">{when(row.created_at)}</span></>} />
          )) : <Empty text="No support tickets." />}
        </Section>
      </>}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4">
    <h4 className="font-semibold">{title}</h4>
    <div className="divide-y divide-slate-800">{children}</div>
  </section>;
}

function Row({ left, right }: { left: ReactNode; right: ReactNode }) {
  return <div className="flex items-start justify-between gap-3 py-2 text-xs">
    <div className="min-w-0">{left}</div>
    <div className="shrink-0 text-right text-slate-300">{right}</div>
  </div>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex justify-between gap-2"><dt className="text-slate-400">{label}</dt><dd className="text-slate-200">{value}</dd></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="py-1 text-xs text-slate-400">{text}</p>;
}
