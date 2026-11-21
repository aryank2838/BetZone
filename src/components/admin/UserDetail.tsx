import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { CardSkeleton } from '@/components/Skeleton';
import { formatDate } from '@/i18n/format';
import { useFormat } from '@/i18n/useFormat';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import { BET_TYPES, type BetType } from '@/types';
import { subjectTeam, type MySportBet } from '@/lib/sportsPool';
import { LEDGER_REASON_LABELS, ledgerMetadataSummary, picksSummary } from './userDetailFormat';
import ConfirmDialog from './ConfirmDialog';
import UserReferrals from './UserReferrals';

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
  email?: string | null;
  email_verified_at?: string | null;
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
  /** Missing until the database update that adds it is applied. */
  sport_bets?: MySportBet[];
}

const SPORT_STATUS_TONE: Record<MySportBet['status'], string> = {
  open: 'text-amber-300', won: 'text-emerald-400', lost: 'text-rose-400', refunded: 'text-ink-muted',
};

const when = (value: string | null) => (value ? formatDate(value, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const statusTone = (status: string) => status === 'approved' || status === 'closed' ? 'text-emerald-400'
  : status === 'rejected' ? 'text-rose-400' : 'text-amber-300';

export default function UserDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const { formatNumber } = useFormat();
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmVerify, setConfirmVerify] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');

  const markVerified = async () => {
    setVerifying(true);
    setVerifyError('');
    try {
      const { data, error: rpcError } = await supabase.rpc('admin_mark_email_verified', { p_user_id: userId });
      if (rpcError) throw rpcError;
      const verifiedAt = (data as { email_verified_at?: string } | null)?.email_verified_at ?? new Date().toISOString();
      setDetail((current) => current && { ...current, profile: { ...current.profile, email_verified_at: verifiedAt } });
      setConfirmVerify(false);
    } catch (rpcError) {
      const friendly = friendlyErrorDetails(rpcError);
      setVerifyError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      setConfirmVerify(false);
    } finally {
      setVerifying(false);
    }
  };

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

  const sportBets = detail?.sport_bets ?? [];
  const sportTotals = sportBets.reduce((totals, bet) => {
    totals.staked += bet.amount;
    if (bet.status === 'open') { totals.open += 1; totals.openStake += bet.amount; }
    if (bet.status === 'won') { totals.returned += bet.payout; totals.net += bet.payout - bet.amount; }
    if (bet.status === 'lost') totals.net -= bet.amount;
    return totals;
  }, { staked: 0, returned: 0, net: 0, open: 0, openStake: 0 });

  return (
    <section className="space-y-5 animate-fade-in">
      <button type="button" onClick={onBack} className="tap-target flex items-center gap-2 text-sm text-ink-muted hover:text-ink-strong"><ArrowLeft className="h-4 w-4" /> Back to users</button>
      {loading ? <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div> : error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : detail && <>
        <header className="rounded-control border border-surface-border bg-surface p-4">
          <h3 className="text-lg font-semibold">{detail.profile.display_name || 'Unnamed user'}</h3>
          <p className="mt-1 break-all text-xs text-ink-muted">{detail.profile.id}</p>
          <p className="mt-2 text-sm text-ink-soft">Play balance {formatNumber(detail.profile.points)} · Wallet {formatNumber(detail.profile.wallet)}</p>
          <p className="mt-1 text-xs text-ink-muted">Joined {when(detail.profile.created_at)} · {detail.profile.is_banned ? 'Banned' : 'Active'} · {detail.profile.is_admin ? 'Admin' : 'User'}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            <span className="break-all">Email: {detail.profile.email || '—'}</span>
            <span aria-hidden="true">·</span>
            {detail.profile.email_verified_at
              ? <span className="text-emerald-300">Verified {when(detail.profile.email_verified_at)}</span>
              : <>
                <span className="text-amber-300">Not verified (can't withdraw yet)</span>
                <button type="button" onClick={() => setConfirmVerify(true)} className="tap-target rounded-lg border border-surface-strong px-2.5 py-1 text-xs font-semibold text-ink-strong hover:bg-surface-raised">Mark email verified</button>
              </>}
          </div>
          {verifyError && <p role="alert" className="mt-1 text-xs text-rose-300">{verifyError}</p>}
          <p className="mt-1 text-xs text-ink-muted">Age confirmed: {detail.profile.age_confirmed ? 'Yes' : 'No'} · Terms: {detail.profile.terms_version ? `${detail.profile.terms_version} (accepted ${when(detail.profile.terms_accepted_at)})` : 'Not accepted'}</p>
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

        <UserReferrals userId={userId} />

        <Section title="Recent ledger (up to 100)">
          {detail.ledger.length ? detail.ledger.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{LEDGER_REASON_LABELS[row.reason] ?? row.reason}</span>{ledgerMetadataSummary(row.metadata) && <span className="block text-ink-muted">{ledgerMetadataSummary(row.metadata)}</span>}</>}
              right={<><span className={row.delta < 0 ? 'text-rose-300' : 'text-emerald-300'}>{row.delta > 0 ? '+' : ''}{formatNumber(row.delta)}</span><span className="block text-ink-muted">{when(row.created_at)}</span></>} />
          )) : <Empty text="No ledger entries." />}
        </Section>

        <Section title="Recent bets (up to 50)">
          {detail.bets.length ? detail.bets.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{row.game} · {row.round_date} · {BET_TYPES[row.bet_type as BetType]?.label ?? row.bet_type}</span><span className="block break-all text-ink-muted">Picks: {picksSummary(row.selections) || '—'}</span></>}
              right={<><span>Stake {formatNumber(row.total_points)}</span><span className="block text-ink-muted">{when(row.created_at)}</span></>} />
          )) : <Empty text="No bets." />}
        </Section>

        <Section title="Sports bets (up to 50)">
          {sportBets.length > 0 && (
            <p className="pb-2 text-xs text-ink-muted">
              {sportTotals.open > 0 && <><span className="text-amber-300">{sportTotals.open} waiting ({formatNumber(sportTotals.openStake)})</span> · </>}
              Staked {formatNumber(sportTotals.staked)} · Won back {formatNumber(sportTotals.returned)} ·{' '}
              <span className={sportTotals.net >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                Player net {sportTotals.net >= 0 ? '+' : '−'}{formatNumber(Math.abs(sportTotals.net))}
              </span>
            </p>
          )}
          {sportBets.length ? sportBets.map((row) => (
            <Row key={row.id}
              left={<>
                <span className="font-medium text-slate-200">{row.event.home_team} vs {row.event.away_team}</span>
                <span className="block text-ink-muted">
                  {row.event.competition_name} · {when(row.event.starts_at)}
                  {row.event.home_score != null && row.event.away_score != null && ` · ${row.event.home_score}–${row.event.away_score}`}
                </span>
                <span className="block text-ink-muted">
                  Will {subjectTeam(row.event)} win? <span className={row.side === 'yes' ? 'text-emerald-300' : 'text-rose-300'}>{row.side === 'yes' ? 'Yes' : 'No'}</span>
                </span>
              </>}
              right={<>
                <span>Stake {formatNumber(row.amount)}</span>
                <span className={`block ${SPORT_STATUS_TONE[row.status]}`}>
                  {row.status === 'won' ? `Won ${formatNumber(row.payout)}`
                    : row.status === 'refunded' ? `Refunded ${formatNumber(row.payout)}`
                      : row.status === 'lost' ? 'Lost' : 'Waiting'}
                </span>
                <span className="block text-ink-muted">{when(row.created_at)}</span>
              </>} />
          )) : <Empty text="No sports bets." />}
        </Section>

        <Section title="Deposits (up to 50)">
          {detail.deposits.length ? detail.deposits.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{formatNumber(row.amount)} · UTR {row.payment_ref}</span>{row.reject_reason && <span className="block text-rose-300/80">Reason: {row.reject_reason}</span>}</>}
              right={<><span className={statusTone(row.status)}>{row.status}</span><span className="block text-ink-muted">{when(row.created_at)}</span></>} />
          )) : <Empty text="No deposits." />}
        </Section>

        <Section title="Withdrawals (up to 50)">
          {detail.withdrawals.length ? detail.withdrawals.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium text-slate-200">{formatNumber(row.amount)} to {row.upi_id}</span>{row.reject_reason && <span className="block text-rose-300/80">Reason: {row.reject_reason}</span>}</>}
              right={<><span className={statusTone(row.status)}>{row.status}</span><span className="block text-ink-muted">{when(row.created_at)}</span></>} />
          )) : <Empty text="No withdrawals." />}
        </Section>

        <Section title="Support tickets (up to 50)">
          {detail.tickets.length ? detail.tickets.map((row) => (
            <Row key={row.id}
              left={<><span className="font-medium capitalize text-slate-200">{row.category}{row.request_ref ? ` · request ${row.request_ref}` : ''}</span><span className="block whitespace-pre-wrap text-ink-muted">{row.message}</span>{row.admin_note && <span className="block text-cyan-300">Note: {row.admin_note}</span>}</>}
              right={<><span className={statusTone(row.status)}>{row.status}</span><span className="block text-ink-muted">{when(row.created_at)}</span></>} />
          )) : <Empty text="No support tickets." />}
        </Section>
      </>}
      {confirmVerify && detail && (
        <ConfirmDialog
          content={{
            title: 'Mark email as verified?',
            rows: [['Player', detail.profile.display_name || 'Unnamed user'], ['Email', detail.profile.email || '—']],
            warning: 'Only do this if you are sure the player owns this email, for example they wrote to you from it. It lets them request withdrawals.',
            confirmLabel: 'Mark verified',
            danger: false,
          }}
          busy={verifying}
          onConfirm={() => void markVerified()}
          onCancel={() => setConfirmVerify(false)}
        />
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="space-y-2 rounded-control border border-surface-border bg-surface p-4">
    <h4 className="font-semibold">{title}</h4>
    <div className="divide-y divide-slate-800">{children}</div>
  </section>;
}

function Row({ left, right }: { left: ReactNode; right: ReactNode }) {
  return <div className="flex items-start justify-between gap-3 py-2 text-xs">
    <div className="min-w-0">{left}</div>
    <div className="shrink-0 text-right text-ink-soft">{right}</div>
  </div>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return <div className="flex justify-between gap-2"><dt className="text-ink-muted">{label}</dt><dd className="text-slate-200">{value}</dd></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="py-1 text-xs text-ink-muted">{text}</p>;
}
