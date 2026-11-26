import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Handshake, RefreshCw, UserPlus, Users } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { rawErrorMessage } from '@/lib/errors';
import { weekLabel, type PartnerClosedWeek, type PartnerLiveWeek } from '@/lib/partner';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { Card, SectionTitle } from '@/components/ui/Card';
import { ListSkeleton } from '@/components/Skeleton';
import { useFormat } from '@/i18n/useFormat';

export interface AdminPartner {
  user_id: string;
  name: string;
  email: string | null;
  code: string;
  share_percent: number;
  active: boolean;
  payout_upi: string | null;
  created_at: string;
  player_count: number;
  week: PartnerLiveWeek;
  due_total: number;
  weeks: Array<PartnerClosedWeek & { id: string }>;
}

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-3 py-2.5 text-sm text-ink-strong focus:border-brand-400 focus:outline-none';
const LOCALE = 'en-IN';

export default function PartnersTab() {
  const { formatNumber, formatDate } = useFormat();
  const [partners, setPartners] = useState<AdminPartner[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [newLookup, setNewLookup] = useState('');
  const [newPercent, setNewPercent] = useState('50');
  const [moveLookup, setMoveLookup] = useState('');
  const [movePartner, setMovePartner] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [percentEdits, setPercentEdits] = useState<Record<string, string>>({});
  const [utrs, setUtrs] = useState<Record<string, string>>({});

  const rupees = (value: number) => `${value < 0 ? '−' : ''}₹${formatNumber(Math.abs(value))}`;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('admin_list_partners');
    if (error) setNotice({ kind: 'err', text: rawErrorMessage(error) });
    else setPartners((data as AdminPartner[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, call: () => PromiseLike<{ data: unknown; error: unknown }>, success: (data: unknown) => string) => {
    setBusy(key);
    setNotice(null);
    try {
      const { data, error } = await call();
      if (error) throw error;
      setNotice({ kind: 'ok', text: success(data) });
      await load();
      return true;
    } catch (caught) {
      setNotice({ kind: 'err', text: rawErrorMessage(caught) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addPartner = async () => {
    const percent = Number(newPercent);
    if (!newLookup.trim()) { setNotice({ kind: 'err', text: 'Enter the player\'s invite code or email.' }); return; }
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) { setNotice({ kind: 'err', text: 'Share must be a whole number from 1 to 100.' }); return; }
    const ok = await run('add', () => supabase.rpc('admin_save_partner', { p_lookup: newLookup.trim(), p_share_percent: percent }), (data) => {
      const tagged = (data as { tagged_players?: number } | null)?.tagged_players ?? 0;
      return tagged > 0 ? `Partner saved. ${tagged} player${tagged === 1 ? '' : 's'} they had already invited are now theirs.` : 'Partner saved.';
    });
    if (ok) setNewLookup('');
  };

  const savePercent = (partner: AdminPartner) => {
    const percent = Number(percentEdits[partner.user_id] ?? partner.share_percent);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) { setNotice({ kind: 'err', text: 'Share must be a whole number from 1 to 100.' }); return; }
    void run(`pct-${partner.user_id}`, () => supabase.rpc('admin_save_partner', { p_lookup: partner.code, p_share_percent: percent }),
      () => `${partner.name} now gets ${percent}%. Finished weeks keep the old share.`);
  };

  const pause = (partner: AdminPartner) => {
    if (!window.confirm(`Pause ${partner.name}? They stop earning from the next week. Their players stay theirs.`)) return;
    void run(`pause-${partner.user_id}`, () => supabase.rpc('admin_pause_partner', { p_user_id: partner.user_id }), () => `${partner.name} is paused.`);
  };

  const resume = (partner: AdminPartner) => {
    void run(`pct-${partner.user_id}`, () => supabase.rpc('admin_save_partner', { p_lookup: partner.code, p_share_percent: partner.share_percent }),
      () => `${partner.name} is earning again from this week.`);
  };

  const markPaid = (partner: AdminPartner, week: AdminPartner['weeks'][number]) => {
    const utr = (utrs[week.id] ?? '').trim();
    if (!/^[A-Za-z0-9]{6,40}$/.test(utr)) { setNotice({ kind: 'err', text: 'Enter the UTR / reference number of your payment (6–40 letters or digits).' }); return; }
    void run(`paid-${week.id}`, () => supabase.rpc('admin_mark_partner_week_paid', { p_week_id: week.id, p_utr: utr }),
      () => `Marked ${rupees(week.share)} to ${partner.name} as paid.`);
  };

  const movePlayer = async () => {
    if (!moveLookup.trim()) { setNotice({ kind: 'err', text: 'Enter the player\'s invite code or email.' }); return; }
    const ok = await run('move', () => supabase.rpc('admin_assign_player_partner', { p_lookup: moveLookup.trim(), p_partner_id: movePartner || null }), (data) => {
      const name = (data as { player_name?: string } | null)?.player_name || 'Player';
      const partner = partners.find((item) => item.user_id === movePartner);
      return partner ? `${name} is now ${partner.name}'s player.` : `${name} is no longer under a partner.`;
    });
    if (ok) setMoveLookup('');
  };

  const totalDue = partners.reduce((sum, partner) => sum + partner.due_total, 0);

  return (
    <section className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-ink-strong"><Handshake className="h-5 w-5 text-amber-400" /> Partners</h2>
          <p className="text-xs text-ink-muted">Week = Monday–Saturday (IST). Sunday counts in the next week. Net = bets − winnings − bonuses; losing weeks carry forward.</p>
        </div>
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} disabled={loading} onClick={() => void load()}>Refresh</Button>
      </div>

      {notice && <Alert tone={notice.kind === 'ok' ? 'success' : 'error'}>{notice.text}</Alert>}
      {totalDue > 0 && <Alert tone="warning">You owe partners {rupees(totalDue)} for finished weeks. Pay their UPI, then mark each week paid below.</Alert>}

      <Card className="space-y-3">
        <SectionTitle icon={<UserPlus className="h-4 w-4" aria-hidden="true" />}>Add a partner</SectionTitle>
        <p className="text-xs text-ink-muted">They need a normal player account first. Their invite link becomes their partner link, and players they already invited become theirs.</p>
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem_auto]">
          <input aria-label="Partner's invite code or email" placeholder="Invite code or email" value={newLookup} onChange={(event) => setNewLookup(event.target.value)} className={INPUT} />
          <label className="relative">
            <span className="sr-only">Share percent</span>
            <input type="number" min={1} max={100} inputMode="numeric" value={newPercent} onChange={(event) => setNewPercent(event.target.value)} className={`${INPUT} pr-7`} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">%</span>
          </label>
          <Button loading={busy === 'add'} disabled={busy !== null} onClick={() => void addPartner()}>Make partner</Button>
        </div>
      </Card>

      {loading && partners.length === 0 ? <ListSkeleton rows={2} /> : partners.length === 0 ? (
        <p className="rounded-card border border-dashed border-surface-strong px-4 py-6 text-center text-sm text-ink-muted">No partners yet.</p>
      ) : partners.map((partner) => {
        const expanded = open === partner.user_id;
        const week = partner.week;
        return (
          <Card key={partner.user_id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-ink-strong">
                  {partner.name}
                  {partner.active ? <Badge tone="success">{partner.share_percent}%</Badge> : <Badge tone="neutral">Paused</Badge>}
                  {partner.due_total > 0 && <Badge tone="warning">Owe {rupees(partner.due_total)}</Badge>}
                </p>
                <p className="truncate text-xs text-ink-muted">{partner.email} · code {partner.code} · {formatNumber(partner.player_count)} players</p>
                <p className="text-xs text-ink-muted">Payout UPI: {partner.payout_upi ? <span className="text-ink-soft">{partner.payout_upi}</span> : <span className="text-amber-300">not set yet</span>}</p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-2 rounded-control bg-surface-page/50 p-3 text-sm sm:grid-cols-4">
              <div><dt className="text-[11px] text-ink-muted">This week ({weekLabel(week.week_start, week.week_end, LOCALE)}) bets</dt><dd className="tabular-nums">{rupees(week.bets)}</dd></div>
              <div><dt className="text-[11px] text-ink-muted">Winnings + bonuses</dt><dd className="tabular-nums">−{rupees(week.wins + week.bonuses)}</dd></div>
              <div><dt className="text-[11px] text-ink-muted">Net{week.carry_in < 0 ? ` (carry ${rupees(week.carry_in)})` : ''}</dt><dd className={`tabular-nums ${week.net < 0 ? 'text-rose-300' : ''}`}>{rupees(week.net)}</dd></div>
              <div><dt className="text-[11px] text-ink-muted">Their share so far</dt><dd className="font-semibold tabular-nums text-amber-300">{rupees(week.projected_share)}</dd></div>
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              <label className="relative w-24">
                <span className="sr-only">Share percent for {partner.name}</span>
                <input
                  type="number" min={1} max={100} inputMode="numeric"
                  value={percentEdits[partner.user_id] ?? String(partner.share_percent)}
                  onChange={(event) => setPercentEdits((current) => ({ ...current, [partner.user_id]: event.target.value }))}
                  className={`${INPUT} py-2 pr-7`}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted">%</span>
              </label>
              <Button variant="secondary" loading={busy === `pct-${partner.user_id}`} disabled={busy !== null || !partner.active} onClick={() => savePercent(partner)}>Save share</Button>
              {partner.active
                ? <Button variant="ghost" loading={busy === `pause-${partner.user_id}`} disabled={busy !== null} onClick={() => pause(partner)}>Pause</Button>
                : <Button variant="secondary" disabled={busy !== null} onClick={() => resume(partner)}>Turn back on</Button>}
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : partner.user_id)}
                aria-expanded={expanded}
                className="ml-auto inline-flex min-h-[40px] items-center gap-1 text-sm font-medium text-accent-300 hover:text-accent-200"
              >
                Weeks {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </div>

            {expanded && (
              partner.weeks.length === 0 ? (
                <p className="text-sm text-ink-muted">No finished weeks yet. The first one closes on Saturday night.</p>
              ) : (
                <ul className="divide-y divide-surface-border rounded-control border border-surface-border">
                  {partner.weeks.map((row) => (
                    <li key={row.id} className="space-y-2 px-3 py-2.5 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-ink-strong">{weekLabel(row.week_start, row.week_end, LOCALE)}</span>
                        <span className="font-bold tabular-nums text-amber-300">{rupees(row.share)}</span>
                      </div>
                      <p className="text-xs text-ink-muted">
                        Bets {rupees(row.bets)} · wins {rupees(row.wins)} · bonuses {rupees(row.bonuses)} · net {rupees(row.net)}
                        {row.carry_in < 0 && <> · carry in {rupees(row.carry_in)}</>}
                        {row.carry_out < 0 && <> · carried {rupees(row.carry_out)}</>}
                        {' '}· {row.share_percent}%
                      </p>
                      {row.status === 'paid' && <p className="text-xs text-emerald-300">Paid {row.paid_at ? formatDate(row.paid_at, { day: 'numeric', month: 'short' }) : ''} · UTR {row.paid_utr}</p>}
                      {row.status === 'nothing_due' && <p className="text-xs text-ink-muted">Nothing due</p>}
                      {row.status === 'due' && (
                        <div className="flex gap-2">
                          <input
                            aria-label={`UTR for ${weekLabel(row.week_start, row.week_end, LOCALE)}`}
                            placeholder="UTR / reference no."
                            value={utrs[row.id] ?? ''}
                            onChange={(event) => setUtrs((current) => ({ ...current, [row.id]: event.target.value.replace(/\s/g, '') }))}
                            className={`${INPUT} py-2`}
                          />
                          <Button loading={busy === `paid-${row.id}`} disabled={busy !== null} onClick={() => markPaid(partner, row)}>Mark paid</Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )
            )}
          </Card>
        );
      })}

      {partners.length > 0 && (
        <Card className="space-y-3">
          <SectionTitle icon={<Users className="h-4 w-4" aria-hidden="true" />}>Move a player</SectionTitle>
          <p className="text-xs text-ink-muted">Put an existing player under a partner, or take them off one. Their past weeks are not changed.</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
            <input aria-label="Player's invite code or email" placeholder="Player's invite code or email" value={moveLookup} onChange={(event) => setMoveLookup(event.target.value)} className={INPUT} />
            <select aria-label="Partner" value={movePartner} onChange={(event) => setMovePartner(event.target.value)} className={INPUT}>
              <option value="">No partner (yours)</option>
              {partners.map((partner) => <option key={partner.user_id} value={partner.user_id}>{partner.name}</option>)}
            </select>
            <Button variant="secondary" loading={busy === 'move'} disabled={busy !== null} onClick={() => void movePlayer()}>Move</Button>
          </div>
        </Card>
      )}
    </section>
  );
}
