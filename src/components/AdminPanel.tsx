import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Loader2, Trophy, Users, Wallet, BarChart3, X, ListChecks, Settings, MoreHorizontal, LifeBuoy, FileText,
} from 'lucide-react';
import { BET_TYPES, GAME_LABELS, isValidPatti, pattiDigit, type BetType, type Game, type GameResult } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { friendlyErrorDetails } from '@/lib/errors';
import StatsTab, { type AdminStats } from '@/components/admin/StatsTab';
import SelectionsTab, { type AdminSelection } from '@/components/admin/SelectionsTab';
import SettingsTab from '@/components/admin/SettingsTab';
import HolidaySettings from '@/components/admin/HolidaySettings';
import UsersTab, { type AdminUser } from '@/components/admin/UsersTab';
import RequestsTab, { type AddFundsRequest, type AdminListFilter, type WithdrawalRequest } from '@/components/admin/RequestsTab';
import SupportTab from '@/components/admin/SupportTab';
import HelpButton from '@/components/HelpButton';
import ReportsTab from '@/components/admin/ReportsTab';
import UserDetail from '@/components/admin/UserDetail';
import { useDialogA11y } from '@/lib/useDialogA11y';
import { useFormat } from '@/i18n/useFormat';
import ConfirmDialog from '@/components/admin/ConfirmDialog';
import { confirmationContent, type AdminConfirmation } from '@/components/admin/confirmations';
import type { AdminSettingRow } from '@/components/admin/SettingsTab';
import PageHeader from '@/components/ui/PageHeader';
import Button from '@/components/ui/Button';
import Alert from '@/components/ui/Alert';
import { Card } from '@/components/ui/Card';
import { useAdminAlerts } from '@/lib/adminAlertsContext';
import { formatClockTime } from '@/lib/countdown';
import { currentResultRound } from '@/lib/adminOverview';

export type AdminTab = 'results' | 'requests' | 'users' | 'selections' | 'stats' | 'settings' | 'support' | 'reports';

interface AdminPanelProps {
  onBack: () => void;
  initialTab?: AdminTab;
  /** Preselects this game on the Results tab (e.g. from an overdue-result reminder). */
  initialGame?: Game;
}

/** Technical text for admins: message plus Postgres/PostgREST code, details and hint. */
function technicalErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const record = error as Record<string, unknown>;
  const parts = [record.message, record.code && `code ${String(record.code)}`, record.details, record.hint]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.join(' · ') || 'No details were returned (check your internet connection).';
}

/** Admin-only error notice: names what failed and always shows the technical detail. */
function errorNotice(error: unknown, action?: string) {
  const { message } = friendlyErrorDetails(error);
  console.error(action ? `Admin: could not ${action}` : 'Admin action failed', error);
  return {
    kind: 'err' as const,
    text: action ? `Couldn't ${action}. ${message}` : message,
    raw: technicalErrorText(error),
  };
}

interface PayoutResult {
  status: string;
  phase?: string;
  winners: number;
  total_paid: number;
}

interface ExposureNumber {
  bet_type: BetType;
  number: string;
  total_stake: number;
  potential_payout: number;
}

interface ExposureResponse {
  max_user_round_points: number;
  max_number_liability: number;
  exposure: ExposureNumber[];
  stake_totals: Array<{ bet_type: BetType; total_stake: number }>;
  phase_exposure: {
    open_worst_case: number;
    close_worst_case: number;
  };
}

interface ResultPreview {
  patti: string;
  digit: string | null;
  jodi: string | null;
  winning_by_bet_type: Array<{
    bet_type: BetType;
    winning_number: string | null;
    winning_picks: number;
    total_payout: number;
  }>;
  warnings: string[];
}

const defaultRoundDate = currentResultRound;

const SETTING_LABELS: Record<string, string> = {
  merchant_upi_id: 'UPI ID',
  merchant_name: 'Merchant name',
  approval_time_note: 'Expected approval note',
  support_whatsapp: 'Support WhatsApp',
  support_email: 'Support email',
  max_user_round_points: 'Per-user round stake limit',
  max_number_liability: 'Per-number liability limit',
};
const settingLabel = (key: string) => SETTING_LABELS[key] ?? key;

const requestListArgs = (filter: AdminListFilter, offset: number) => ({
  p_limit: 50,
  p_offset: offset,
  p_status: filter.status || null,
  p_from: filter.from || null,
  p_to: filter.to || null,
  p_search: filter.search || null,
});

function useAdminResultPreview(game: Game, roundDate: string, phase: 'open' | 'close', patti: string) {
  const [preview, setPreview] = useState<ResultPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError('');
    if (!roundDate || patti.length !== 3) {
      setLoading(false);
      return () => { active = false; };
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          const { data, error: rpcError } = await supabase.rpc('admin_preview_result', {
            p_game: game, p_round_date: roundDate, p_phase: phase, p_patti: patti,
          });
          if (!active) return;
          if (rpcError) {
            const friendly = friendlyErrorDetails(rpcError);
            setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
          } else setPreview({ ...(data as Omit<ResultPreview, 'patti'>), patti });
        } catch (rpcError) {
          if (!active) return;
          const friendly = friendlyErrorDetails(rpcError);
          setError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [game, roundDate, phase, patti]);
  return { preview, loading, error };
}

function ResultPreviewCard({ preview, loading, error }: {
  preview: ResultPreview | null;
  loading: boolean;
  error: string;
}) {
  const { formatNumber } = useFormat();
  if (loading) return <p className="text-xs text-ink-muted">Calculating read-only payout preview…</p>;
  if (error) return <p role="alert" className="text-xs text-rose-300">{error}</p>;
  if (!preview) return null;
  return <div className="space-y-2 rounded-lg border border-surface-strong bg-surface-page/60 p-3 text-xs">
    <p className="font-medium text-slate-200">Preview for patti {preview.patti} · digit {preview.digit ?? '—'}{preview.jodi ? ` · jodi ${preview.jodi}` : ''}</p>
    <div className="space-y-1">{preview.winning_by_bet_type.map((item) => <p key={item.bet_type} className="flex justify-between gap-2 text-ink-muted">
      <span>{BET_TYPES[item.bet_type].label} · {item.winning_number ?? '—'} · {item.winning_picks} winning picks</span>
      <span className="text-amber-300">{formatNumber(item.total_payout)} payout</span>
    </p>)}</div>
    {preview.warnings.map((warning) => <p key={warning} className="text-amber-300">Warning: {warning}</p>)}
  </div>;
}

type Tab = AdminTab;

/** The four top-level groups. "More" holds the less frequent screens. */
const GROUPS = [
  { id: 'requests', label: 'Requests', icon: Wallet },
  { id: 'results', label: 'Results', icon: Trophy },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'more', label: 'More', icon: MoreHorizontal },
] as const;
type Group = typeof GROUPS[number]['id'];

const MORE_TABS: Array<{ id: Tab; label: string; icon: typeof BarChart3 }> = [
  { id: 'stats', label: 'Overview', icon: BarChart3 },
  { id: 'selections', label: 'Bets', icon: ListChecks },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'support', label: 'Support', icon: LifeBuoy },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const groupOf = (tab: Tab): Group => (tab === 'requests' || tab === 'results' || tab === 'users' ? tab : 'more');

export default function AdminPanel({ onBack, initialTab = 'requests', initialGame }: AdminPanelProps) {
  const alerts = useAdminAlerts();
  const alertsVersion = alerts?.version ?? 0;
  const { formatNumber } = useFormat();
  const { statuses: gameStatuses, refresh: refreshGameStatuses } = useGameStatus();
  const gameOptions = gameStatuses.map((status) => ({ game: status.game, label: status.label || GAME_LABELS[status.game] || status.game }));
  const [tab, setTab] = useState<Tab>(initialTab);
  const [game, setGame] = useState<Game>(initialGame ?? 'test');
  const [roundDate, setRoundDate] = useState('');
  const [openPatti, setOpenPatti] = useState('');
  const [openDigit, setOpenDigit] = useState('');
  const [closePatti, setClosePatti] = useState('');
  const [closeDigit, setCloseDigit] = useState('');
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string; raw?: string } | null>(null);
  const [payoutResult, setPayoutResult] = useState<PayoutResult | null>(null);
  const [latestResult, setLatestResult] = useState<GameResult | null>(null);
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  const [loadingExposure, setLoadingExposure] = useState(false);
  const [exposureError, setExposureError] = useState<string | null>(null);
  const [exposureErrorDetails, setExposureErrorDetails] = useState('');
  const [confirmPhase, setConfirmPhase] = useState<'open' | 'close' | null>(null);
  const [confirmPatti, setConfirmPatti] = useState('');
  const resultConfirmRef = useRef<HTMLElement>(null);
  const closeResultConfirm = useCallback(() => {
    if (!posting) setConfirmPhase(null);
  }, [posting]);
  useDialogA11y(confirmPhase !== null, resultConfirmRef, closeResultConfirm);
  const openPreview = useAdminResultPreview(game, roundDate, 'open', openPatti);
  const closePreview = useAdminResultPreview(game, roundDate, 'close', closePatti);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [addFundsReqs, setAddFundsReqs] = useState<AddFundsRequest[]>([]);
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [statsRoundDate, setStatsRoundDate] = useState('');
  const [selectionDate, setSelectionDate] = useState('');
  const [initializedServerDates, setInitializedServerDates] = useState(false);

  useEffect(() => {
    if (initializedServerDates || gameStatuses.length === 0) return;
    const today = gameStatuses[0].server_ist_date;
    setStatsRoundDate(today);
    setSelectionDate(today);
    // Default the Results round date from the *selected* game's schedule.
    const initialGame = gameStatuses.some((status) => status.game === game) ? game : gameStatuses[0].game;
    setGame(initialGame);
    setRoundDate(defaultRoundDate(gameStatuses.find((status) => status.game === initialGame)));
    setInitializedServerDates(true);
  }, [game, gameStatuses, initializedServerDates]);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [hasMoreUsers, setHasMoreUsers] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [hasMoreWithdrawals, setHasMoreWithdrawals] = useState(false);
  const [hasMoreAddFunds, setHasMoreAddFunds] = useState(false);
  const [loadingMoreRequests, setLoadingMoreRequests] = useState(false);
  const [addFundsFilter, setAddFundsFilter] = useState<AdminListFilter>({ status: 'pending', from: '', to: '', search: '' });
  const [withdrawalFilter, setWithdrawalFilter] = useState<AdminListFilter>({ status: 'pending', from: '', to: '', search: '' });
  const [userStatus, setUserStatus] = useState('');
  const [userFrom, setUserFrom] = useState('');
  const [userTo, setUserTo] = useState('');
  const [detailUser, setDetailUser] = useState<AdminUser | null>(null);

  const [selections, setSelections] = useState<AdminSelection[]>([]);
  const [loadingSelections, setLoadingSelections] = useState(true);

  const [adjustTarget, setAdjustTarget] = useState<{ user: AdminUser; type: 'points' | 'wallet' } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<AdminConfirmation | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [openedScreenshots, setOpenedScreenshots] = useState<Set<string>>(() => new Set());
  const cancelConfirm = useCallback(() => setPendingConfirm(null), []);

  // Settings state
  const [settingsUpiId, setSettingsUpiId] = useState('');
  const [settingsMerchantName, setSettingsMerchantName] = useState('');
  const [settingsApprovalTimeNote, setSettingsApprovalTimeNote] = useState('');
  const [settingsSupportWhatsApp, setSettingsSupportWhatsApp] = useState('');
  const [settingsSupportEmail, setSettingsSupportEmail] = useState('');
  const [settingsMaxUserRoundPoints, setSettingsMaxUserRoundPoints] = useState('50000');
  const [settingsMaxNumberLiability, setSettingsMaxNumberLiability] = useState('1000000');
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<{ kind: 'ok' | 'err'; text: string; raw?: string } | null>(null);
  const [settingsMeta, setSettingsMeta] = useState<Record<string, AdminSettingRow>>({});

  const loadSettings = useCallback(async (options: { keepMessage?: boolean } = {}) => {
    setSettingsLoading(true);
    if (!options.keepMessage) setSettingsMessage(null);
    const { data, error } = await supabase.rpc('admin_get_settings');
    if (error) {
      setSettingsMessage(errorNotice(error));
      setSettingsLoading(false);
      return;
    }
    const byKey: Record<string, AdminSettingRow> = {};
    for (const row of (data as AdminSettingRow[] | null) ?? []) byKey[row.key] = row;
    const value = (key: string, fallback = '') => (typeof byKey[key]?.value === 'string' ? byKey[key].value as string : fallback);
    setSettingsMeta(byKey);
    setSettingsUpiId(value('merchant_upi_id'));
    setSettingsMerchantName(value('merchant_name'));
    setSettingsApprovalTimeNote(value('approval_time_note'));
    setSettingsSupportWhatsApp(value('support_whatsapp'));
    setSettingsSupportEmail(value('support_email'));
    // Unset limits fall back to the database defaults used by get_setting_int.
    setSettingsMaxUserRoundPoints(value('max_user_round_points', '50000'));
    setSettingsMaxNumberLiability(value('max_number_liability', '1000000'));
    setSettingsLoading(false);
  }, []);

  const saveSetting = async (key: string, value: string) => {
    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const { error } = await supabase.rpc('admin_set_app_setting', { p_key: key, p_value: value.trim() });
      if (error) throw error;
      setSettingsMessage({ kind: 'ok', text: `${settingLabel(key)} updated successfully.` });
      await loadSettings({ keepMessage: true });
    } catch (err) {
      setSettingsMessage(errorNotice(err));
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleSaveSetting = async (key: string, value: string) => {
    const isLimit = key === 'max_user_round_points' || key === 'max_number_liability';
    const isApprovalNote = key === 'approval_time_note';
    const isSupportContact = key === 'support_whatsapp' || key === 'support_email';
    const label = settingLabel(key);
    if (!value.trim() && !isApprovalNote && !isSupportContact) {
      setSettingsMessage({ kind: 'err', text: `${label} cannot be empty.` });
      return;
    }
    if (isApprovalNote && value.trim().length > 120) {
      setSettingsMessage({ kind: 'err', text: `${label} cannot exceed 120 characters.` });
      return;
    }
    if (isLimit && !/^[1-9]\d*$/.test(value.trim())) {
      setSettingsMessage({ kind: 'err', text: `${label} must be a positive whole number.` });
      return;
    }
    const savedUpi = typeof settingsMeta.merchant_upi_id?.value === 'string' ? settingsMeta.merchant_upi_id.value : '';
    if (key === 'merchant_upi_id' && value.trim() !== savedUpi) {
      setPendingConfirm({ kind: 'merchant_upi', oldValue: savedUpi, newValue: value.trim() });
      return;
    }
    await saveSetting(key, value);
  };

  const loadLatest = async (g: string) => {
    const { data, error } = await supabase.rpc('get_latest_results', { p_game: g });
    if (error) {
      setMessage(errorNotice(error, 'load the latest result'));
      setLatestResult(null);
      return;
    }
    if (data) setLatestResult(data as GameResult);
    else setLatestResult(null);
  };

  const loadExposure = async (g: Game, date: string) => {
    if (!date) return;
    setLoadingExposure(true);
    setExposureError(null);
    setExposureErrorDetails('');
    const { data, error } = await supabase.rpc('admin_get_exposure', {
      p_game: g,
      p_round_date: date,
    });
    if (error) {
      setExposure(null);
      const friendly = friendlyErrorDetails(error);
      setExposureError(friendly.message);
      setExposureErrorDetails(friendly.raw ?? '');
    } else if (data) {
      setExposure(data as ExposureResponse);
    } else {
      setExposure(null);
      setExposureError('Exposure data was not returned.');
    }
    setLoadingExposure(false);
  };

  const loadWithdrawals = useCallback(async () => {
    setLoadingWithdrawals(true);
    const [wd, af] = await Promise.all([
      supabase.rpc('admin_list_withdrawals', requestListArgs(withdrawalFilter, 0)),
      supabase.rpc('admin_list_add_funds', requestListArgs(addFundsFilter, 0)),
    ]);
    if (wd.error || af.error) {
      setMessage(errorNotice(wd.error ?? af.error, wd.error ? 'load withdrawal requests' : 'load add-money requests'));
    }
    if (!wd.error && wd.data) {
      const rows = wd.data as WithdrawalRequest[];
      setWithdrawals(rows);
      setHasMoreWithdrawals(rows.length === 50);
    }
    if (!af.error && af.data) {
      const rows = af.data as AddFundsRequest[];
      setAddFundsReqs(rows);
      setHasMoreAddFunds(rows.length === 50);
    }
    setLoadingWithdrawals(false);
  }, [withdrawalFilter, addFundsFilter]);

  const loadMoreRequests = async (kind: 'withdrawals' | 'addFunds') => {
    if (loadingMoreRequests) return;
    setLoadingMoreRequests(true);
    const offset = kind === 'withdrawals' ? withdrawals.length : addFundsReqs.length;
    const { data, error } = kind === 'withdrawals'
      ? await supabase.rpc('admin_list_withdrawals', requestListArgs(withdrawalFilter, offset))
      : await supabase.rpc('admin_list_add_funds', requestListArgs(addFundsFilter, offset));
    if (error) setMessage(errorNotice(error, 'load more requests'));
    if (!error && data) {
      if (kind === 'withdrawals') {
        const rows = data as WithdrawalRequest[];
        setWithdrawals((previous) => [...previous, ...rows]);
        setHasMoreWithdrawals(rows.length === 50);
      } else {
        const rows = data as AddFundsRequest[];
        setAddFundsReqs((previous) => [...previous, ...rows]);
        setHasMoreAddFunds(rows.length === 50);
      }
    }
    setLoadingMoreRequests(false);
  };

  const loadStats = useCallback(async (date = statsRoundDate) => {
    // The round date is filled in once the game schedule loads; asking before
    // that sent an empty date, which the database rejects ("invalid input
    // syntax for type date") and showed "Something went wrong" on every tab.
    if (!date) return;
    setLoadingStats(true);
    const { data, error } = await supabase.rpc('admin_get_stats', { p_round_date: date });
    if (!error && data) setStats(data as AdminStats);
    if (error) setMessage(errorNotice(error, 'load stats'));
    setLoadingStats(false);
  }, [statsRoundDate]);

  const loadUsers = useCallback(async (search: string) => {
    setLoadingUsers(true);
    const { data, error } = await supabase.rpc('admin_list_users', {
      p_search: search || null,
      p_status: userStatus || null,
      p_from: userFrom || null,
      p_to: userTo || null,
      p_limit: 50,
      p_offset: 0,
    });
    if (error) setMessage(errorNotice(error, 'load users'));
    if (!error && data) {
      const rows = data as AdminUser[];
      setUsers(rows);
      setHasMoreUsers(rows.length === 50);
    }
    setLoadingUsers(false);
  }, [userStatus, userFrom, userTo]);

  const loadMoreUsers = async () => {
    if (loadingUsers || !hasMoreUsers) return;
    setLoadingUsers(true);
    const { data, error } = await supabase.rpc('admin_list_users', {
      p_search: userSearch || null, p_status: userStatus || null,
      p_from: userFrom || null, p_to: userTo || null, p_limit: 50, p_offset: users.length,
    });
    if (error) setMessage(errorNotice(error, 'load more users'));
    if (!error && data) {
      const rows = data as AdminUser[];
      setUsers((previous) => [...previous, ...rows]);
      setHasMoreUsers(rows.length === 50);
    }
    setLoadingUsers(false);
  };

  const loadSelections = async (g: string, date: string) => {
    if (!date) return;
    setLoadingSelections(true);
    const { data, error } = await supabase.rpc('admin_list_selections', { p_game: g, p_round_date: date });
    if (error) setMessage(errorNotice(error, 'load bets for this round'));
    if (!error && data) setSelections(data as AdminSelection[]);
    setLoadingSelections(false);
  };

  useEffect(() => {
    loadLatest(game);
    loadStats(statsRoundDate);
  }, [game, loadStats, statsRoundDate]);

  useEffect(() => { void loadWithdrawals(); }, [loadWithdrawals]);

  // A request was added or changed (live update): reload the lists and counts.
  const firstAlertsVersion = useRef(alertsVersion);
  useEffect(() => {
    if (alertsVersion === firstAlertsVersion.current) return;
    void loadWithdrawals();
    void loadStats();
  }, [alertsVersion, loadWithdrawals, loadStats]);

  useEffect(() => {
    if (tab === 'results') loadExposure(game, roundDate);
  }, [tab, game, roundDate]);

  useEffect(() => {
    if (tab === 'users') loadUsers(userSearch);
    if (tab === 'selections') loadSelections(game, selectionDate);
    if (tab === 'settings') loadSettings();
  }, [tab, game, roundDate, selectionDate, loadUsers, loadSettings, userSearch]);

  const handlePostOpen = async () => {
    const p = openPatti.trim();
    const digit = openDigit.trim();
    if (!roundDate) { setMessage({ kind: 'err', text: 'Select the round date.' }); return; }
    if (!isValidPatti(p)) { setMessage({ kind: 'err', text: 'Enter a valid sorted patti.' }); return; }
    if (!/^[0-9]$/.test(digit) || Number(digit) !== pattiDigit(p)) {
      setMessage({ kind: 'err', text: 'The digit must match the patti.' });
      return;
    }
    if (confirmPatti !== p) { setMessage({ kind: 'err', text: 'Type the patti exactly to confirm posting.' }); return; }

    setPosting(true);
    setMessage(null);
    setPayoutResult(null);
    try {
      const { data, error } = await supabase.rpc('admin_post_open_result', {
        p_game: game,
        p_round_date: roundDate,
        p_patti: p,
        p_digit: digit,
      });
      if (error) throw error;
      const result = data as PayoutResult;
      setPayoutResult(result);
      setMessage({ kind: 'ok', text: `Open result ${p}-${digit} posted for ${roundDate}. Payouts processed.` });
      setOpenPatti('');
      setOpenDigit('');
      setConfirmPhase(null);
      setConfirmPatti('');
      loadLatest(game); loadStats(); await loadExposure(game, roundDate);
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setPosting(false); }
  };

  const handlePostClose = async () => {
    const p = closePatti.trim();
    const digit = closeDigit.trim();
    if (!roundDate) { setMessage({ kind: 'err', text: 'Select the round date.' }); return; }
    if (!isValidPatti(p)) { setMessage({ kind: 'err', text: 'Enter a valid sorted patti.' }); return; }
    if (!/^[0-9]$/.test(digit) || Number(digit) !== pattiDigit(p)) {
      setMessage({ kind: 'err', text: 'The digit must match the patti.' });
      return;
    }
    if (confirmPatti !== p) { setMessage({ kind: 'err', text: 'Type the patti exactly to confirm posting.' }); return; }

    setPosting(true);
    setMessage(null);
    setPayoutResult(null);
    try {
      const { data, error } = await supabase.rpc('admin_post_close_result', {
        p_game: game,
        p_round_date: roundDate,
        p_patti: p,
        p_digit: digit,
      });
      if (error) throw error;
      const result = data as PayoutResult;
      setPayoutResult(result);
      setMessage({ kind: 'ok', text: `Close result ${p}-${digit} posted for ${roundDate}. Payouts processed.` });
      setClosePatti('');
      setCloseDigit('');
      setConfirmPhase(null);
      setConfirmPatti('');
      loadLatest(game); loadStats(); await loadExposure(game, roundDate);
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setPosting(false); }
  };

  const handleWithdrawal = async (id: string, status: 'approved' | 'rejected', reason?: string) => {
    setProcessingId(id);
    try {
      const { error } = await supabase.rpc('admin_process_withdrawal', { p_withdrawal_id: id, p_new_status: status, p_reason: reason ?? null });
      if (error) throw error;
      await loadWithdrawals(); await loadStats(); void alerts?.refresh();
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setProcessingId(null); }
  };

  const handleAddFunds = async (id: string, status: 'approved' | 'rejected', reason?: string) => {
    setProcessingId(id);
    try {
      const { error } = await supabase.rpc('admin_process_add_funds', { p_request_id: id, p_new_status: status, p_reason: reason ?? null });
      if (error) throw error;
      await loadWithdrawals(); await loadStats(); void alerts?.refresh();
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setProcessingId(null); }
  };

  const handleToggleBan = async (user: AdminUser) => {
    setActionId(user.id);
    try {
      const { error } = await supabase.rpc('admin_toggle_ban', { p_user_id: user.id });
      if (error) throw error;
      await loadUsers(userSearch); await loadStats();
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setActionId(null); }
  };

  const handleSetAdmin = async (user: AdminUser, isAdmin: boolean) => {
    setActionId(user.id);
    try {
      const { error } = await supabase.rpc('admin_set_admin', { p_user_id: user.id, p_is_admin: isAdmin });
      if (error) throw error;
      await loadUsers(userSearch); await loadStats();
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setActionId(null); }
  };

  // Validates the adjustment form, then asks for confirmation (C1) before sending.
  const handleAdjust = () => {
    if (!adjustTarget) return;
    const delta = Number(adjustDelta);
    if (!Number.isInteger(delta) || delta === 0) { setMessage({ kind: 'err', text: 'Enter a non-zero whole number.' }); return; }
    if (adjustReason.trim().length < 5) { setMessage({ kind: 'err', text: 'A reason of at least 5 characters is required.' }); return; }
    setMessage(null);
    setPendingConfirm({ kind: 'adjust', user: adjustTarget.user, target: adjustTarget.type, delta, reason: adjustReason.trim() });
  };

  const applyAdjustment = async (user: AdminUser, target: 'points' | 'wallet', delta: number, reason: string) => {
    setAdjusting(true);
    try {
      const { error } = await supabase.rpc('admin_adjust_points', { p_user_id: user.id, p_delta: delta, p_reason: reason, p_target: target });
      if (error) throw error;
      setAdjustTarget(null); setAdjustDelta(''); setAdjustReason('');
      await loadUsers(userSearch); await loadStats();
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setAdjusting(false); }
  };

  const runConfirmed = async (confirmation: AdminConfirmation) => {
    setConfirmBusy(true);
    try {
      switch (confirmation.kind) {
        case 'approve_add_funds': await handleAddFunds(confirmation.request.id, 'approved'); break;
        case 'approve_withdrawal': await handleWithdrawal(confirmation.request.id, 'approved'); break;
        case 'toggle_ban': await handleToggleBan(confirmation.user); break;
        case 'set_admin': await handleSetAdmin(confirmation.user, confirmation.isAdmin); break;
        case 'adjust': await applyAdjustment(confirmation.user, confirmation.target, confirmation.delta, confirmation.reason); break;
        case 'merchant_upi': await saveSetting('merchant_upi_id', confirmation.newValue); break;
      }
    } finally {
      setConfirmBusy(false);
      setPendingConfirm(null);
    }
  };

  const viewScreenshot = async (path: string) => {
    setScreenshotLoading(true);
    setScreenshotUrl(null);
    try {
      const { data, error } = await supabase.storage.from('payment-screenshots').createSignedUrl(path, 300);
      if (error) throw error;
      setScreenshotUrl(data.signedUrl);
      setOpenedScreenshots((current) => new Set(current).add(path));
    } catch (error) {
      setScreenshotUrl(null);
      setMessage(errorNotice(error, 'open the screenshot'));
    }
    setScreenshotLoading(false);
  };

  const pending = withdrawals.filter((w) => w.status === 'pending');
  const pendingAddFunds = addFundsReqs.filter((a) => a.status === 'pending');

  const waitingCount = alerts ? alerts.waiting : pending.length + pendingAddFunds.length;
  const activeGroup = groupOf(tab);
  const selectTab = (next: Tab) => { setTab(next); setMessage(null); };
  const selectedStatus = gameStatuses.find((status) => status.game === game);
  const fieldClass = 'min-h-tap w-full rounded-control border border-surface-strong bg-surface-raised px-4 text-base text-ink-strong focus:border-brand-400 focus:outline-none';
  const digitClass = 'min-h-tap w-full rounded-control border border-surface-strong bg-surface-raised px-4 text-center font-mono text-2xl tracking-[0.3em] text-ink-strong focus:border-brand-400 focus:outline-none';

  const resultForm = (phase: 'open' | 'close') => {
    const patti = phase === 'open' ? openPatti : closePatti;
    const digit = phase === 'open' ? openDigit : closeDigit;
    const setPatti = phase === 'open' ? setOpenPatti : setClosePatti;
    const setDigit = phase === 'open' ? setOpenDigit : setCloseDigit;
    const preview = phase === 'open' ? openPreview : closePreview;
    const resultTime = phase === 'open' ? selectedStatus?.open_result_at : selectedStatus?.close_result_at;
    const ready = isValidPatti(patti) && /^[0-9]$/.test(digit) && Number(digit) === pattiDigit(patti) && !!roundDate;
    return (
      <Card>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="font-bold text-ink-strong">Post {phase} result</h3>
          {resultTime && <span className="text-xs text-ink-muted">Due {formatClockTime(resultTime)} IST</span>}
        </div>
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <label className="text-sm text-ink-muted">{phase === 'open' ? 'Open' : 'Close'} patti
            <input type="text" inputMode="numeric" value={patti} onChange={(e) => setPatti(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder={phase === 'open' ? '123' : '135'} maxLength={3} className={`mt-1 ${digitClass}`} />
          </label>
          <label className="text-sm text-ink-muted">Digit
            <input type="text" inputMode="numeric" value={digit} onChange={(e) => setDigit(e.target.value.replace(/\D/g, '').slice(0, 1))} placeholder="0" maxLength={1} className={`mt-1 ${digitClass}`} />
          </label>
        </div>
        {patti && (
          <p className={`mt-2 text-sm ${isValidPatti(patti) && (!digit || Number(digit) === pattiDigit(patti)) ? 'text-ink-muted' : 'text-rose-300'}`}>
            {isValidPatti(patti) ? `Patti digit: ${pattiDigit(patti)}${digit && Number(digit) !== pattiDigit(patti) ? ' — entered digit does not match' : ''}` : 'Invalid patti'}
          </p>
        )}
        <div className="mt-3"><ResultPreviewCard {...preview} /></div>
        <Button
          size="lg"
          fullWidth
          className="mt-4"
          loading={posting}
          disabled={!ready}
          icon={<Trophy className="h-4 w-4" aria-hidden="true" />}
          onClick={() => { setConfirmPhase(phase); setConfirmPatti(''); }}
        >
          Review {phase} payouts
        </Button>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-surface-page text-ink">
      <PageHeader
        title="Admin Panel"
        subtitle={alerts?.live ? 'Live updates on' : 'Updates every minute'}
        onBack={onBack}
        actions={<HelpButton />}
      />

      <nav aria-label="Admin sections" className="border-b border-surface-border bg-surface-page">
        <div className="mx-auto grid max-w-2xl grid-cols-4 gap-1 px-2 py-2 sm:px-5">
          {GROUPS.map((group) => {
            const Icon = group.icon;
            const active = activeGroup === group.id;
            const badge = group.id === 'requests' ? waitingCount : 0;
            return (
              <button
                key={group.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => selectTab(group.id === 'more' ? (activeGroup === 'more' ? tab : 'stats') : group.id)}
                className={`relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-control text-sm font-semibold transition-colors ${
                  active ? 'bg-surface-raised text-ink-strong' : 'text-ink-muted hover:bg-surface hover:text-ink-soft'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {group.label}
                {badge > 0 && (
                  <span className="absolute right-1 top-1 min-w-[20px] rounded-full bg-amber-500 px-1.5 text-xs font-bold leading-5 text-slate-950">
                    {badge}<span className="sr-only"> waiting</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-5">
        {activeGroup === 'more' && (
          <div className="flex flex-wrap gap-2" aria-label="More admin screens">
            {MORE_TABS.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => selectTab(item.id)}
                  className={`inline-flex min-h-tap items-center gap-1.5 rounded-full border px-4 text-sm font-medium ${
                    active ? 'border-brand-600 bg-brand-950 text-brand-200' : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" /> {item.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Stats tab */}
        {tab === 'stats' && (
          <StatsTab
            games={gameOptions}
            stats={stats}
            loading={loadingStats}
            roundDate={statsRoundDate}
            onRoundDateChange={setStatsRoundDate}
          />
        )}

        {/* Results tab */}
        {tab === 'results' && (
          <section className="space-y-4 animate-fade-in">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-sm text-ink-muted">Game
                <select
                  value={game}
                  onChange={(e) => {
                    const nextGame = e.target.value as Game;
                    setGame(nextGame);
                    setRoundDate(defaultRoundDate(gameStatuses.find((status) => status.game === nextGame)));
                  }}
                  className={`mt-1 ${fieldClass}`}
                >
                  {gameStatuses.map((status) => (
                    <option key={status.game} value={status.game}>{status.label || GAME_LABELS[status.game] || status.game}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-ink-muted">Round date
                <input type="date" value={roundDate} onChange={(e) => setRoundDate(e.target.value)} className={`mt-1 ${fieldClass}`} />
              </label>
            </div>

            {latestResult && (
              <Card>
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  <Trophy className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
                  {latestResult.round_date === selectedStatus?.server_ist_date ? `Today's result — ${latestResult.round_date}` : `Latest result — ${latestResult.round_date}`}
                </p>
                <div className="flex items-center justify-center gap-3 py-3 sm:gap-4">
                  {latestResult.open_patti && <span className="text-base font-bold text-ink-muted">{latestResult.open_patti}</span>}
                  {latestResult.open_digit && <span className="text-3xl font-bold text-brand-400">{latestResult.open_digit}</span>}
                  {latestResult.close_digit && <span className="text-3xl font-bold text-accent-400">{latestResult.close_digit}</span>}
                  {latestResult.close_patti && <span className="text-base font-bold text-ink-muted">{latestResult.close_patti}</span>}
                  {!latestResult.open_digit && !latestResult.close_digit && <span className="text-sm text-ink-muted">No results yet</span>}
                </div>
                <div className="flex justify-center gap-3">
                  {latestResult.open_digit && <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${latestResult.open_processed ? 'bg-brand-950 text-brand-300' : 'bg-amber-950 text-amber-300'}`}>Open {latestResult.open_processed ? 'paid' : 'pending'}</span>}
                  {latestResult.close_digit && <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${latestResult.close_processed ? 'bg-brand-950 text-brand-300' : 'bg-amber-950 text-amber-300'}`}>Close {latestResult.close_processed ? 'paid' : 'pending'}</span>}
                </div>
              </Card>
            )}

            <section className="space-y-3 rounded-card border border-amber-900/70 bg-amber-950/20 p-5">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-300">Round exposure — {roundDate}</h3>
                <p className="mt-1 text-xs text-ink-muted">
                  Per-user cap: {exposure ? `₹${formatNumber(exposure.max_user_round_points)}` : '—'}
                  <span className="mx-2">·</span>
                  Per-number payout cap: {exposure ? `₹${formatNumber(exposure.max_number_liability)}` : '—'}
                </p>
              </div>
              {loadingExposure ? (
                <div className="flex items-center justify-center py-4 text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /></div>
              ) : exposureError ? (
                <Alert details={exposureErrorDetails}>{exposureError}</Alert>
              ) : exposure && exposure.exposure.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-amber-200">
                    Worst-case payout: open ₹{formatNumber(exposure.phase_exposure.open_worst_case)} · close ₹{formatNumber(exposure.phase_exposure.close_worst_case)}
                  </p>
                  {Array.from(new Set(exposure.exposure.map((item) => item.bet_type))).map((betType) => (
                    <div key={betType}>
                      <h4 className="mb-1.5 text-sm font-medium text-ink-soft">{BET_TYPES[betType].label} · ₹{formatNumber(exposure.stake_totals?.find((item) => item.bet_type === betType)?.total_stake ?? 0)} staked</h4>
                      <div className="space-y-1">
                        {exposure.exposure.filter((item) => item.bet_type === betType).map((item) => (
                          <div key={`${item.bet_type}-${item.number}`} className="flex items-center justify-between text-sm">
                            <span className="text-ink-muted"><span className="font-mono text-ink-soft">{item.number}</span> (₹{formatNumber(item.total_stake)} staked)</span>
                            <span className="font-semibold text-amber-300">₹{formatNumber(item.potential_payout)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-ink-muted">No bets have been placed for this round.</p>
              )}
            </section>

            {resultForm('open')}
            {resultForm('close')}

            {message && <Alert tone={message.kind === 'ok' ? 'success' : 'error'} details={message.raw}>{message.text}</Alert>}
            {payoutResult && payoutResult.status === 'processed' && (
              <Alert tone="success" title={`${payoutResult.phase === 'open' ? 'Open' : 'Close'} payouts processed`}>
                {payoutResult.winners} winner(s), ₹{formatNumber(payoutResult.total_paid)} paid out.
              </Alert>
            )}
          </section>
        )}

        {/* Requests tab */}
        {tab === 'requests' && (
          <RequestsTab
            withdrawals={withdrawals}
            addFundsRequests={addFundsReqs}
            loading={loadingWithdrawals}
            processingId={processingId}
            loadingMore={loadingMoreRequests}
            hasMoreWithdrawals={hasMoreWithdrawals}
            hasMoreAddFunds={hasMoreAddFunds}
            message={message}
            addFundsFilter={addFundsFilter}
            withdrawalFilter={withdrawalFilter}
            onAddFundsFilterChange={setAddFundsFilter}
            onWithdrawalFilterChange={setWithdrawalFilter}
            onSearch={(kind) => { if (kind === 'withdrawals') { setHasMoreWithdrawals(false); } else setHasMoreAddFunds(false); void loadWithdrawals(); }}
            onProcessWithdrawal={(id, status, reason) => {
              const request = withdrawals.find((item) => item.id === id);
              if (status === 'approved' && request) {
                setPendingConfirm({ kind: 'approve_withdrawal', request });
                return;
              }
              void handleWithdrawal(id, status, reason);
            }}
            onProcessAddFunds={(id, status, reason) => {
              const request = addFundsReqs.find((item) => item.id === id);
              if (status === 'approved' && request) {
                setPendingConfirm({
                  kind: 'approve_add_funds',
                  request,
                  screenshotOpened: !!request.screenshot_path && openedScreenshots.has(request.screenshot_path),
                });
                return;
              }
              void handleAddFunds(id, status, reason);
            }}
            onViewScreenshot={(path) => { void viewScreenshot(path); }}
            onScreenshotSeen={(path) => setOpenedScreenshots((current) => (current.has(path) ? current : new Set(current).add(path)))}
            onLoadMore={(kind) => { void loadMoreRequests(kind); }}
          />
        )}

        {/* Users tab */}
        {tab === 'users' && !detailUser && (
          <UsersTab
            users={users}
            search={userSearch}
            status={userStatus}
            from={userFrom}
            to={userTo}
            loading={loadingUsers}
            hasMore={hasMoreUsers}
            actionId={actionId}
            message={message}
            onSearchChange={setUserSearch}
            onFilterChange={(filter) => { setUserStatus(filter.status); setUserFrom(filter.from); setUserTo(filter.to); }}
            onSearch={() => { void loadUsers(userSearch); }}
            onLoadMore={() => { void loadMoreUsers(); }}
            onViewDetail={setDetailUser}
            onAdjust={(user, type) => { setAdjustTarget({ user, type }); setAdjustDelta(''); setAdjustReason(''); }}
            onToggleBan={(user) => setPendingConfirm({ kind: 'toggle_ban', user })}
            onSetAdmin={(user, isAdmin) => setPendingConfirm({ kind: 'set_admin', user, isAdmin })}
          />
        )}

        {/* Selections tab */}
        {tab === 'selections' && (
          <SelectionsTab
            games={gameOptions}
            game={game}
            roundDate={selectionDate}
            selections={selections}
            loading={loadingSelections}
            onGameChange={setGame}
            onRoundDateChange={setSelectionDate}
          />
        )}

        {/* Settings tab */}
        {tab === 'settings' && (
          <SettingsTab
            upiId={settingsUpiId}
            merchantName={settingsMerchantName}
            approvalTimeNote={settingsApprovalTimeNote}
            supportWhatsApp={settingsSupportWhatsApp}
            supportEmail={settingsSupportEmail}
            maxUserRoundBalance={settingsMaxUserRoundPoints}
            maxNumberLiability={settingsMaxNumberLiability}
            loading={settingsLoading}
            saving={settingsSaving}
            message={settingsMessage}
            onUpiIdChange={setSettingsUpiId}
            onMerchantNameChange={setSettingsMerchantName}
            onApprovalTimeNoteChange={setSettingsApprovalTimeNote}
            onSupportWhatsAppChange={setSettingsSupportWhatsApp}
            onSupportEmailChange={setSettingsSupportEmail}
            onMaxUserRoundBalanceChange={setSettingsMaxUserRoundPoints}
            onMaxNumberLiabilityChange={setSettingsMaxNumberLiability}
            meta={settingsMeta}
            onSave={(key, value) => { void handleSaveSetting(key, value); }}
          />
        )}
        {tab === 'settings' && (
          <HolidaySettings statuses={gameStatuses} onChanged={() => { void refreshGameStatuses(); }} />
        )}
        {tab === 'support' && <SupportTab />}
        {tab === 'reports' && <ReportsTab />}
      </main>

      {tab === 'users' && detailUser && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-surface-page p-5">
          <div className="mx-auto max-w-2xl py-4">
            <UserDetail userId={detailUser.id} onBack={() => setDetailUser(null)} />
          </div>
        </div>
      )}

      {confirmPhase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => !posting && setConfirmPhase(null)}>
          <section ref={resultConfirmRef} role="dialog" aria-modal="true" aria-labelledby="result-confirm-title" className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-card border border-surface-strong bg-surface p-5" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3 id="result-confirm-title" className="text-lg font-bold">Confirm {confirmPhase} result</h3>
              <p className="mt-1 text-sm text-rose-300">Posting pays winning picks immediately. Payouts cannot be undone.</p>
            </header>
            <ResultPreviewCard {...(confirmPhase === 'open' ? openPreview : closePreview)} />
            <div className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-3">
              <p className="mb-2 text-xs font-medium text-amber-200">Round exposure · {roundDate}</p>
              {loadingExposure ? <Loader2 className="h-4 w-4 animate-spin text-ink-muted" /> : exposureError ? (
                <p role="alert" className="text-xs text-rose-300">{exposureError}{exposureErrorDetails && ` ${exposureErrorDetails}`}</p>
              ) : exposure?.exposure.length ? exposure.exposure.map((item) => (
                <p key={`${item.bet_type}-${item.number}`} className="flex justify-between gap-2 py-0.5 text-xs text-ink-soft">
                  <span>{BET_TYPES[item.bet_type].label} · {item.number} · stake {item.total_stake}</span>
                  <span>{item.potential_payout} potential payout</span>
                </p>
              )) : <p className="text-xs text-ink-muted">No exposed picks.</p>}
            </div>
            <label className="block text-sm text-ink-soft">
              Type <strong>{confirmPhase === 'open' ? openPatti : closePatti}</strong> to confirm
              <input value={confirmPatti} inputMode="numeric" onChange={(event) => setConfirmPatti(event.target.value)} autoComplete="off" className="mt-1 min-h-tap w-full rounded-control border border-surface-strong bg-surface-raised px-4 font-mono text-lg text-ink-strong" />
            </label>
            {message?.kind === 'err' && <Alert details={message.raw}>{message.text}</Alert>}
            <div className="grid grid-cols-2 gap-4">
              <Button size="lg" variant="secondary" disabled={posting} onClick={() => setConfirmPhase(null)}>Back</Button>
              <Button
                size="lg"
                variant="danger"
                loading={posting}
                disabled={confirmPatti !== (confirmPhase === 'open' ? openPatti : closePatti) || (confirmPhase === 'open' ? openPreview.loading || !openPreview.preview || openPreview.preview.patti !== openPatti || openPreview.preview.warnings.length > 0 : closePreview.loading || !closePreview.preview || closePreview.preview.patti !== closePatti || closePreview.preview.warnings.length > 0)}
                onClick={() => void (confirmPhase === 'open' ? handlePostOpen() : handlePostClose())}
              >
                Post and pay
              </Button>
            </div>
          </section>
        </div>
      )}

      {/* Adjust balance modal */}
      {adjustTarget && (
        <div className="fixed inset-0 bg-surface-page/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4" onClick={() => !adjusting && setAdjustTarget(null)}>
          <div className="bg-surface rounded-card border border-surface-border w-full max-w-sm p-6 space-y-4 animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-ink-strong">Adjust {adjustTarget.type === 'points' ? 'play balance' : 'wallet balance'}</h3>
              <button onClick={() => !adjusting && setAdjustTarget(null)} className="tap-target text-ink-muted hover:text-ink-strong">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-lg bg-surface-raised border border-surface-strong">
              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-sm font-semibold text-ink-soft">
                {adjustTarget.user.display_name.charAt(0).toUpperCase() || '?'}
              </div>
              <div>
                <p className="text-sm font-medium text-ink-strong">{adjustTarget.user.display_name || 'Unnamed'}</p>
                <p className="text-xs text-ink-muted">Current balance: {adjustTarget.type === 'points' ? adjustTarget.user.points : adjustTarget.user.wallet}</p>
              </div>
            </div>
            <div>
              <label className="block text-xs text-ink-muted mb-1.5">Balance adjustment (use negative to deduct)</label>
              <input type="number" step={1} value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} placeholder="e.g. 500 or -200"
                className="w-full px-4 py-3 rounded-control bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-ink-muted mb-1.5">Reason</label>
              <input type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="e.g. Bonus credit / correction"
                className="w-full px-4 py-3 rounded-control bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
            </div>
            <button onClick={handleAdjust} disabled={adjusting || pendingConfirm !== null}
              className="w-full py-3.5 rounded-control bg-gradient-to-r from-emerald-500 to-cyan-500 text-ink-strong text-sm font-bold hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-40 transition-all flex items-center justify-center gap-2">
              {adjusting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Review adjustment'}
            </button>
            {message && message.kind === 'err' && (
              <div className="text-sm text-rose-400">
                <p>{message.text}</p>
                {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {pendingConfirm && (
        <ConfirmDialog
          content={confirmationContent(pendingConfirm)}
          busy={confirmBusy}
          onCancel={cancelConfirm}
          onConfirm={() => { void runConfirmed(pendingConfirm); }}
        />
      )}

      {/* Screenshot viewer modal */}
      {(screenshotUrl || screenshotLoading) && (
        <div className="fixed inset-0 bg-surface-page/90 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => { setScreenshotUrl(null); setScreenshotLoading(false); }}>
          <div className="relative max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setScreenshotUrl(null); setScreenshotLoading(false); }} className="tap-target absolute -top-10 right-0 text-ink-muted hover:text-ink-strong">
              <X className="w-6 h-6" />
            </button>
            {screenshotLoading ? (
              <div className="flex items-center justify-center py-20 text-ink-muted"><Loader2 className="w-8 h-8 animate-spin" /></div>
            ) : (
              <img src={screenshotUrl!} alt="Payment screenshot" className="w-full rounded-control border border-surface-strong" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
