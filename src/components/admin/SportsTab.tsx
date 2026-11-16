import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { subjectTeam } from '@/lib/sportsPool';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import { Card, SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';

/** Competitions on football-data.org's free plan. */
const FOOTBALL_COMPETITIONS: Array<{ code: string; name: string }> = [
  { code: 'PL', name: 'Premier League' },
  { code: 'CL', name: 'Champions League' },
  { code: 'PD', name: 'La Liga' },
  { code: 'SA', name: 'Serie A' },
  { code: 'BL1', name: 'Bundesliga' },
  { code: 'FL1', name: 'Ligue 1' },
  { code: 'DED', name: 'Eredivisie' },
  { code: 'PPL', name: 'Primeira Liga' },
  { code: 'ELC', name: 'Championship' },
  { code: 'BSA', name: 'Brasileirão' },
  { code: 'EC', name: 'European Championship' },
  { code: 'WC', name: 'World Cup' },
];

interface SportSettings {
  football_enabled: boolean;
  cricket_enabled: boolean;
  fee_percent: number;
  football_competitions: string[];
  min_bet: number;
  max_bet: number;
  updated_at: string;
}

interface SyncStatus {
  sport: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  events_seen: number;
}

interface AdminSportEvent {
  id: string;
  sport: string;
  competition_name: string;
  home_team: string;
  away_team: string;
  subject_side: 'home' | 'away';
  starts_at: string;
  state: 'open' | 'closed' | 'settled' | 'void';
  provider_status: string;
  home_score: string | null;
  away_score: string | null;
  result_winner: string | null;
  outcome: 'yes' | 'no' | null;
  void_reason: string | null;
  fee_percent: number;
  fee_taken: number | null;
  yes_total: number;
  no_total: number;
  hidden: boolean;
  bettors: number;
}

const inputClass = 'w-full min-w-0 px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none';
const NINETY_MIN = 90 * 60 * 1000;

function ago(iso: string | null) {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function when(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const STATE_TONE: Record<AdminSportEvent['state'], BadgeTone> = {
  open: 'success', closed: 'warning', settled: 'info', void: 'neutral',
};

export default function SportsTab() {
  const [settings, setSettings] = useState<SportSettings | null>(null);
  const [draft, setDraft] = useState<SportSettings | null>(null);
  const [sync, setSync] = useState<SyncStatus[]>([]);
  const [events, setEvents] = useState<AdminSportEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string; raw?: string } | null>(null);

  const showError = (err: unknown) => {
    const friendly = friendlyError(err);
    setMessage({ kind: 'err', text: friendly.message, raw: friendly.key === 'errors.generic' ? rawErrorMessage(err) : undefined });
  };

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('admin_get_sports');
    setLoading(false);
    if (error) { showError(error); return; }
    const body = data as { settings: SportSettings; sync: SyncStatus[]; events: AdminSportEvent[] };
    setSettings(body.settings);
    setDraft(body.settings);
    setSync(body.sync ?? []);
    setEvents(body.events ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    const { error } = await supabase.rpc('admin_set_sport_settings', {
      p_settings: {
        football_enabled: draft.football_enabled,
        cricket_enabled: draft.cricket_enabled,
        fee_percent: draft.fee_percent,
        min_bet: draft.min_bet,
        max_bet: draft.max_bet,
        football_competitions: draft.football_competitions,
      },
    });
    setSaving(false);
    if (error) { showError(error); return; }
    setMessage({ kind: 'ok', text: 'Sports settings saved. A new fee applies to matches imported from now on.' });
    await load();
  };

  const refund = async (event: AdminSportEvent) => {
    const reason = window.prompt(`Refund every bet on ${event.home_team} vs ${event.away_team}? Type a short reason:`);
    if (reason === null) return;
    setBusyId(event.id);
    setMessage(null);
    const { error } = await supabase.rpc('admin_void_sport_event', { p_event_id: event.id, p_reason: reason });
    setBusyId(null);
    if (error) { showError(error); return; }
    setMessage({ kind: 'ok', text: `All bets on ${event.home_team} vs ${event.away_team} refunded.` });
    await load();
  };

  const settle = async (event: AdminSportEvent, winner: 'home' | 'away' | 'draw') => {
    const label = winner === 'draw' ? 'a draw' : `${winner === 'home' ? event.home_team : event.away_team} won`;
    if (!window.confirm(`Pay out ${event.home_team} vs ${event.away_team} as: ${label}? This cannot be undone.`)) return;
    setBusyId(event.id);
    setMessage(null);
    const { error } = await supabase.rpc('admin_settle_sport_event', { p_event_id: event.id, p_winner: winner });
    setBusyId(null);
    if (error) { showError(error); return; }
    setMessage({ kind: 'ok', text: `${event.home_team} vs ${event.away_team} paid out.` });
    await load();
  };

  if (loading && !settings) return <ListSkeleton rows={4} />;

  const toggleCompetition = (code: string) => {
    if (!draft) return;
    const has = draft.football_competitions.includes(code);
    setDraft({ ...draft, football_competitions: has ? draft.football_competitions.filter((c) => c !== code) : [...draft.football_competitions, code] });
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const open = events.filter((e) => e.state === 'open' || e.state === 'closed');
  const done = events.filter((e) => e.state === 'settled' || e.state === 'void');
  const feeEarned = done.reduce((sum, e) => sum + (e.fee_taken ?? 0), 0);

  return (
    <div className="space-y-6">
      {message && (
        <Alert tone={message.kind === 'ok' ? 'success' : 'error'} details={message.raw}>{message.text}</Alert>
      )}

      <Card className="space-y-2">
        <SectionTitle action={
          <Button variant="ghost" onClick={() => { void load(); }} icon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>
        }>Automatic updates</SectionTitle>
        {(['football', 'cricket'] as const).map((sport) => (
          <SyncLine key={sport} label={sport === 'football' ? 'Football' : 'Cricket'} row={sync.find((row) => row.sport === sport)} />
        ))}
      </Card>

      {draft && (
        <Card className="space-y-4">
          <SectionTitle>Settings</SectionTitle>
          <label className="flex items-center justify-between gap-3 text-sm text-ink-strong">
            <span>Football betting on</span>
            <input type="checkbox" className="h-5 w-5" checked={draft.football_enabled}
              onChange={(e) => setDraft({ ...draft, football_enabled: e.target.checked })} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm text-ink-strong">
            <span>Cricket betting on</span>
            <input type="checkbox" className="h-5 w-5" checked={draft.cricket_enabled}
              onChange={(e) => setDraft({ ...draft, cricket_enabled: e.target.checked })} />
          </label>
          <p className="text-xs text-ink-muted">
            Cricket covers India men&apos;s and women&apos;s senior matches and the IPL. Betting closes at the earliest
            start time the feed gives. A tie or draw counts as No; a Super Over winner counts as the winner.
          </p>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink-soft">Football leagues</legend>
            <div className="grid grid-cols-2 gap-2">
              {FOOTBALL_COMPETITIONS.map((c) => (
                <label key={c.code} className="flex items-center gap-2 text-sm text-ink-soft">
                  <input type="checkbox" checked={draft.football_competitions.includes(c.code)} onChange={() => toggleCompetition(c.code)} />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-3 gap-3">
            <label className="text-xs text-ink-soft">Fee % of losing pool
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={draft.fee_percent}
                onChange={(e) => setDraft({ ...draft, fee_percent: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </label>
            <label className="text-xs text-ink-soft">Min bet ₹
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={draft.min_bet}
                onChange={(e) => setDraft({ ...draft, min_bet: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </label>
            <label className="text-xs text-ink-soft">Max per match ₹
              <input className={`${inputClass} mt-1`} inputMode="numeric" value={draft.max_bet}
                onChange={(e) => setDraft({ ...draft, max_bet: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </label>
          </div>
          <Button onClick={() => { void save(); }} loading={saving} disabled={!dirty}>Save sports settings</Button>
        </Card>
      )}

      <section>
        <SectionTitle>Open and in-play matches ({open.length})</SectionTitle>
        {open.length === 0 ? <p className="text-sm text-ink-muted">No open matches.</p> : (
          <ul className="space-y-3">
            {open.map((event) => (
              <MatchRow key={event.id} event={event} busy={busyId === event.id} onRefund={refund} onSettle={settle} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Finished in the last 7 days · fee earned ₹{feeEarned}</SectionTitle>
        {done.length === 0 ? <p className="text-sm text-ink-muted">Nothing finished yet.</p> : (
          <ul className="space-y-3">
            {done.map((event) => (
              <MatchRow key={event.id} event={event} busy={false} onRefund={refund} onSettle={settle} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SyncLine({ label, row }: { label: string; row: SyncStatus | undefined }) {
  if (!row) {
    return <p className="text-sm text-ink-muted">{label}: not synced yet. It starts on the next scheduled run once its key is set.</p>;
  }
  const stale = !row.last_success_at || Date.now() - Date.parse(row.last_success_at) > 60 * 60 * 1000;
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-soft">
        {label}: last update {ago(row.last_success_at)} · {row.events_seen} matches checked
      </p>
      {row.last_error && (
        <Alert tone="error" details={row.last_error}>The last {label.toLowerCase()} update failed ({ago(row.last_run_at)}).</Alert>
      )}
      {!row.last_error && stale && (
        <Alert tone="warning">{label} has not updated for over an hour. Check the sync schedule.</Alert>
      )}
    </div>
  );
}

function MatchRow({ event, busy, onRefund, onSettle }: {
  event: AdminSportEvent;
  busy: boolean;
  onRefund: (event: AdminSportEvent) => void;
  onSettle: (event: AdminSportEvent, winner: 'home' | 'away' | 'draw') => void;
}) {
  const active = event.state === 'open' || event.state === 'closed';
  const canSettle = event.state === 'closed' && Date.now() > Date.parse(event.starts_at) + NINETY_MIN;
  const score = event.home_score != null && event.away_score != null ? ` · ${event.home_score}–${event.away_score}` : '';
  let detail = '';
  if (event.state === 'settled') detail = `Result ${event.outcome === 'yes' ? 'Yes' : 'No'} · fee ₹${event.fee_taken ?? 0}`;
  if (event.state === 'void') detail = `Refunded: ${event.void_reason ?? ''}`;
  if (event.state === 'closed' && event.result_winner) detail = `Result received (${event.result_winner}), paying out after 30 min`;

  return (
    <li>
      <Card className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-ink-muted">{event.competition_name} · {when(event.starts_at)}{score}</p>
            <p className="font-semibold text-ink-strong">{event.home_team} vs {event.away_team}</p>
            <p className="text-xs text-ink-soft">Will {subjectTeam(event)} win?</p>
          </div>
          <Badge tone={STATE_TONE[event.state]}>{event.state}</Badge>
        </div>
        <p className="text-sm text-ink-soft">
          Yes ₹{event.yes_total} · No ₹{event.no_total} · {event.bettors} {event.bettors === 1 ? 'player' : 'players'} · fee {event.fee_percent}%
        </p>
        {detail && <p className="text-xs text-ink-muted">{detail}</p>}
        {active && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy} onClick={() => onRefund(event)}>Refund all</Button>
            {canSettle && (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => onSettle(event, 'home')}>{event.home_team} won</Button>
                <Button variant="ghost" disabled={busy} onClick={() => onSettle(event, 'draw')}>Draw</Button>
                <Button variant="ghost" disabled={busy} onClick={() => onSettle(event, 'away')}>{event.away_team} won</Button>
              </>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}
