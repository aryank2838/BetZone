import { useState } from 'react';
import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { formatCountdown } from '@/lib/countdown';
import {
  estimatePayout, isBettable, subjectTeam, yesShare,
  type SportEvent, type SportSide,
} from '@/lib/sportsPool';
import { teamColor, teamInitials } from '@/lib/sportsLook';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { useToast } from '@/components/ui/toastContext';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-4 py-3 text-base font-semibold tabular-nums text-ink-strong focus:outline-none';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const QUICK_AMOUNTS = [50, 100, 500, 1000];

const SIDE = {
  yes: { focus: 'focus:border-emerald-400', text: 'text-emerald-300', strong: 'text-emerald-200', border: 'border-emerald-500/60', bg: 'bg-emerald-500/10', ring: 'ring-emerald-400', bar: 'bg-emerald-500', button: '!bg-emerald-500 !text-slate-950 hover:!bg-emerald-400' },
  no: { focus: 'focus:border-rose-400', text: 'text-rose-300', strong: 'text-rose-200', border: 'border-rose-500/60', bg: 'bg-rose-500/10', ring: 'ring-rose-400', bar: 'bg-rose-500', button: '!bg-rose-500 !text-white hover:!bg-rose-400' },
} as const;

const REFUND_REASONS: Record<string, TranslationKey> = {
  one_sided: 'sports.reason.oneSided',
  cancelled_or_postponed: 'sports.reason.cancelled',
  start_moved_earlier: 'sports.reason.startMoved',
  no_result: 'sports.reason.noResult',
};

function refundReasonKey(reason: string | null): TranslationKey {
  if (reason && REFUND_REASONS[reason]) return REFUND_REASONS[reason];
  return 'sports.reason.support';
}

function TeamBadge({ name }: { name: string }) {
  const color = teamColor(name);
  return (
    <span
      className="mx-auto grid h-12 w-12 place-items-center rounded-full border-2 text-sm font-extrabold tracking-wide"
      style={{ color, borderColor: `${color}99`, backgroundColor: `${color}1f` }}
      aria-hidden="true"
    >
      {teamInitials(name)}
    </span>
  );
}

function StatusPill({ event, nowMs, open }: { event: SportEvent; nowMs: number; open: boolean }) {
  const { t } = useT();
  const { formatDate } = useFormat();
  const startsMs = Date.parse(event.starts_at);
  const base = 'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide';

  if (event.state === 'void') {
    return <span className={`${base} border-surface-strong text-ink-muted`}>{t('sports.refundedShort')}</span>;
  }
  if (event.state === 'settled') {
    return <span className={`${base} border-sky-500/50 bg-sky-500/10 text-sky-200`}>{t('sports.finished')}</span>;
  }
  if (open) {
    const left = startsMs - nowMs;
    const soon = left < HOUR;
    return (
      <span className={`${base} tabular-nums ${soon ? 'border-amber-500/60 bg-amber-500/15 text-amber-200' : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'}`}>
        {left < DAY
          ? interpolate(t('sports.closesShort'), { time: formatCountdown(event.starts_at, nowMs) })
          : interpolate(t('sports.closesShort'), { time: formatDate(startsMs, { weekday: 'short', day: 'numeric', month: 'short' }) })}
      </span>
    );
  }
  if (event.provider_status === 'live') {
    return (
      <span className={`${base} border-red-500/60 bg-red-500/15 text-red-200`}>
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:hidden" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
        </span>
        {t('sports.live')}
      </span>
    );
  }
  return <span className={`${base} border-surface-strong text-ink-soft`}>{t('sports.waiting')}</span>;
}

export default function SportEventCard({ event, nowMs, minBet, maxBet, onPlaced, onAddFunds }: {
  event: SportEvent;
  nowMs: number;
  minBet: number;
  maxBet: number;
  onPlaced: () => Promise<void>;
  onAddFunds: () => void;
}) {
  const { t } = useT();
  const { formatNumber, formatDate } = useFormat();
  const [side, setSide] = useState<SportSide | null>(null);
  const team = subjectTeam(event);
  const open = isBettable(event, nowMs);
  const share = yesShare(event.yes_total, event.no_total);
  const startsMs = Date.parse(event.starts_at);
  const total = event.yes_total + event.no_total;
  const hasScore = event.home_score != null && event.away_score != null;
  const finished = event.state === 'settled' || event.state === 'void';
  const sportIcon = event.sport === 'cricket' ? '🏏' : '⚽';
  const sideLabel = (s: SportSide) => t(s === 'yes' ? 'sports.yes' : 'sports.no');

  const myBets = (['yes', 'no'] as SportSide[])
    .map((s) => ({ side: s, amount: s === 'yes' ? event.my_yes : event.my_no }))
    .filter((bet) => bet.amount > 0);

  return (
    <article
      className={`overflow-hidden rounded-card border bg-surface/80 ${
        open ? 'border-surface-strong' : event.state === 'void' ? 'border-dashed border-surface-strong opacity-80' : 'border-surface-border'
      }`}
      aria-label={`${event.home_team} vs ${event.away_team}`}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3.5">
        <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          <span aria-hidden="true">{sportIcon} </span>{event.competition_name}
        </p>
        <StatusPill event={event} nowMs={nowMs} open={open} />
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pb-3 pt-3">
        {[event.home_team, event.away_team].map((name, index) => (
          <div key={name + index} className={`min-w-0 text-center ${index === 1 ? 'order-3' : ''}`}>
            <TeamBadge name={name} />
            <p className={`mt-1.5 line-clamp-2 text-sm font-semibold leading-tight ${name === team ? 'text-ink-strong' : 'text-ink-soft'}`}>{name}</p>
          </div>
        ))}
        <div className="order-2 min-w-[76px] text-center">
          {hasScore ? (
            <p className="text-[26px] font-extrabold tabular-nums leading-none text-ink-strong">
              {event.home_score}<span className="px-1 text-ink-muted">–</span>{event.away_score}
            </p>
          ) : (
            <>
              <p className="text-xs font-medium text-ink-muted">{formatDate(startsMs, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
              <p className="text-base font-bold tabular-nums text-ink-strong">{formatDate(startsMs, { hour: 'numeric', minute: '2-digit' })}</p>
            </>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-surface-border px-4 pb-4 pt-3">
        <p className="text-center text-base font-bold text-ink-strong">{interpolate(t('sports.question'), { team })}</p>

        {event.state === 'settled' && (
          <div className={`flex items-center justify-center gap-2 rounded-control px-3 py-2 text-sm font-semibold ${
            event.outcome === 'yes' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-rose-500/15 text-rose-200'
          }`}>
            {event.outcome === 'yes'
              ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              : <XCircle className="h-4 w-4" aria-hidden="true" />}
            {interpolate(t(event.outcome === 'yes' ? 'sports.resultYes' : 'sports.resultNo'), { team })}
          </div>
        )}
        {event.state === 'void' && (
          <div className="flex items-center justify-center gap-2 rounded-control bg-surface-raised px-3 py-2 text-center text-sm text-ink-soft">
            <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
            {interpolate(t('sports.refunded'), { reason: t(refundReasonKey(event.void_reason)) })}
          </div>
        )}

        {open ? (
          <div className="grid grid-cols-2 gap-2">
            {(['yes', 'no'] as SportSide[]).map((s) => {
              const look = SIDE[s];
              const est = estimatePayout({ stake: 100, side: s, yesTotal: event.yes_total, noTotal: event.no_total, feePercent: event.fee_percent });
              const pct = s === 'yes' ? share : 100 - share;
              const selected = side === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSide(selected ? null : s)}
                  className={`rounded-control border-2 px-3 py-2.5 text-left transition-colors ${look.border} ${look.bg} ${
                    selected ? `ring-2 ring-offset-2 ring-offset-surface ${look.ring}` : 'hover:brightness-125'
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-1">
                    <span className={`text-base font-extrabold uppercase ${look.strong}`}>{sideLabel(s)}</span>
                    {total > 0 && <span className={`text-xs font-semibold tabular-nums ${look.text}`}>{pct}%</span>}
                  </span>
                  <span className="mt-0.5 block text-xs tabular-nums text-ink-soft">
                    {est.refund ? t('sports.beFirst') : interpolate(t('sports.per100'), { amount: formatNumber(est.payout) })}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div>
          <div className="flex h-2 overflow-hidden rounded-full bg-surface-raised" aria-hidden="true">
            {total > 0 && <div className={SIDE.yes.bar} style={{ width: `${share}%` }} />}
            {total > 0 && <div className={SIDE.no.bar} style={{ width: `${100 - share}%` }} />}
          </div>
          {total > 0 ? (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-ink-muted">
              <span className={finished || !open ? SIDE.yes.text : ''}>
                {!open && `${sideLabel('yes')} ${share}% · `}₹{formatNumber(event.yes_total)}
              </span>
              <span>{interpolate(t('sports.totalPool'), { amount: formatNumber(total) })}</span>
              <span className={finished || !open ? SIDE.no.text : ''}>
                ₹{formatNumber(event.no_total)}{!open && ` · ${sideLabel('no')} ${100 - share}%`}
              </span>
            </div>
          ) : (
            <p className="mt-1.5 text-center text-[11px] text-ink-muted">{interpolate(t('sports.totalPool'), { amount: '0' })}</p>
          )}
        </div>

        {myBets.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {myBets.map((bet) => {
              const won = event.state === 'settled' && event.outcome === bet.side;
              const lost = event.state === 'settled' && event.outcome !== bet.side;
              return (
                <span
                  key={bet.side}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    won ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                      : lost ? 'border-rose-500/40 bg-rose-500/10 text-rose-200/80'
                        : 'border-surface-strong bg-surface-raised text-ink-soft'
                  }`}
                >
                  {interpolate(t('sports.yourBet'), { side: sideLabel(bet.side), amount: formatNumber(bet.amount) })}
                  {won && ` · ${t('sports.youWon')}`}
                  {lost && ` · ${t('sports.youLost')}`}
                </span>
              );
            })}
          </div>
        )}

        {open && side && (
          <BetForm
            event={event}
            side={side}
            minBet={minBet}
            maxBet={maxBet}
            onCancel={() => setSide(null)}
            onPlaced={async () => { setSide(null); await onPlaced(); }}
            onAddFunds={onAddFunds}
          />
        )}
      </div>
    </article>
  );
}

function BetForm({ event, side, minBet, maxBet, onCancel, onPlaced, onAddFunds }: {
  event: SportEvent;
  side: SportSide;
  minBet: number;
  maxBet: number;
  onCancel: () => void;
  onPlaced: () => Promise<void>;
  onAddFunds: () => void;
}) {
  const { t } = useT();
  const { formatNumber } = useFormat();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ text: string; raw?: string; addFunds?: boolean } | null>(null);
  const value = /^[0-9]+$/.test(amount) ? Number(amount) : 0;
  const valid = value >= minBet && value <= maxBet;
  const look = SIDE[side];
  const sideLabel = t(side === 'yes' ? 'sports.yes' : 'sports.no');
  const question = interpolate(t('sports.question'), { team: subjectTeam(event) });
  const est = estimatePayout({ stake: value, side, yesTotal: event.yes_total, noTotal: event.no_total, feePercent: event.fee_percent });
  const quick = QUICK_AMOUNTS.filter((q) => q >= minBet && q <= maxBet);

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('place_sport_bet', { p_event_id: event.id, p_side: side, p_amount: value });
      if (rpcError) throw rpcError;
      toast.show(interpolate(t('sports.placed'), { amount: formatNumber(value), side: sideLabel }), 'success');
      await onPlaced();
    } catch (err) {
      const friendly = friendlyError(err);
      setError({
        text: friendly.message,
        raw: friendly.key === 'errors.generic' ? rawErrorMessage(err) : undefined,
        addFunds: friendly.action === 'add_funds',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`space-y-3 rounded-control border-2 p-3 ${look.border} ${look.bg}`}>
      <p className="text-sm font-semibold text-ink-strong">
        {interpolate(t('sports.betTitle'), { side: sideLabel, question })}
      </p>
      <div>
        <label htmlFor={`sport-amount-${event.id}`} className="mb-1.5 block text-xs font-medium text-ink-soft">{t('sports.amount')}</label>
        <input
          id={`sport-amount-${event.id}`}
          type="text" inputMode="numeric" pattern="[0-9]*" autoFocus
          value={amount}
          onChange={(e) => { setAmount(e.target.value.replace(/\D/g, '')); setError(null); }}
          placeholder={`₹${minBet * 10}`}
          className={`${INPUT} ${look.focus}`}
        />
        {quick.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {quick.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => { setAmount(String(q)); setError(null); }}
                className={`min-h-[36px] rounded-full border px-3.5 text-[13px] font-semibold tabular-nums ${
                  value === q ? `${look.border} ${look.strong} bg-surface-page/60` : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
                }`}
              >
                ₹{formatNumber(q)}
              </button>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-xs text-ink-muted">
          {interpolate(t('sports.amountHint'), { min: formatNumber(minBet), max: formatNumber(maxBet) })}
        </p>
      </div>
      {valid && (
        <div className="rounded-control bg-surface-page/60 px-3 py-2 text-xs">
          <p className={`font-semibold ${est.refund ? 'text-ink-soft' : look.strong}`}>
            {est.refund
              ? t('sports.estimateRefund')
              : interpolate(t('sports.estimate'), { amount: formatNumber(est.payout), stake: formatNumber(value) })}
          </p>
          <p className="mt-1 text-ink-muted">{t('sports.estimateNote')}</p>
        </div>
      )}
      {error && (
        <Alert tone="error" details={error.raw} action={error.addFunds ? (
          <Button variant="secondary" onClick={onAddFunds}>{t('dashboard.addFunds')}</Button>
        ) : undefined}>{error.text}</Alert>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>{t('sports.cancel')}</Button>
        <Button className={look.button} onClick={() => { void submit(); }} disabled={!valid} loading={submitting}>
          {interpolate(t('sports.place'), { amount: formatNumber(value) })}
        </Button>
      </div>
    </div>
  );
}
