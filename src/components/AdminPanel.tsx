import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  ArrowLeft, Loader2, Trophy, Users, Wallet, BarChart3, X, ListChecks, Settings,
} from 'lucide-react';
import { BET_TYPES, GAME_LABELS, isValidPatti, pattiDigit, type BetType, type Game, type GameResult } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { friendlyErrorDetails } from '@/lib/errors';
import StatsTab, { type AdminStats } from '@/components/admin/StatsTab';
import SelectionsTab, { type AdminSelection } from '@/components/admin/SelectionsTab';
import SettingsTab from '@/components/admin/SettingsTab';
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

interface AdminPanelProps {
  onBack: () => void;
  initialTab?: 'results' | 'requests' | 'users' | 'selections' | 'stats' | 'settings' | 'support' | 'reports';
}

function errorNotice(error: unknown) {
  const { message, raw } = friendlyErrorDetails(error);
  return { kind: 'err' as const, text: message, raw };
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

const defaultRoundDate = (status: { server_ist_date: string; server_ist_time: string; close_result_next_day: boolean; close_result_at: string } | undefined) => {
  if (!status) return '';
  if (!status.close_result_next_day || status.server_ist_time >= status.close_result_at) return status.server_ist_date;
  const previousDate = new Date(`${status.server_ist_date}T00:00:00Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  return previousDate.toISOString().slice(0, 10);
};

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
  if (loading) return <p className="text-xs text-slate-400">Calculating read-only payout preview…</p>;
  if (error) return <p role="alert" className="text-xs text-rose-300">{error}</p>;
  if (!preview) return null;
  return <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs">
    <p className="font-medium text-slate-200">Preview for patti {preview.patti} · digit {preview.digit ?? '—'}{preview.jodi ? ` · jodi ${preview.jodi}` : ''}</p>
    <div className="space-y-1">{preview.winning_by_bet_type.map((item) => <p key={item.bet_type} className="flex justify-between gap-2 text-slate-400">
      <span>{BET_TYPES[item.bet_type].label} · {item.winning_number ?? '—'} · {item.winning_picks} winning picks</span>
      <span className="text-amber-300">{formatNumber(item.total_payout)} payout</span>
    </p>)}</div>
    {preview.warnings.map((warning) => <p key={warning} className="text-amber-300">Warning: {warning}</p>)}
  </div>;
}

type Tab = 'results' | 'requests' | 'users' | 'selections' | 'stats' | 'settings' | 'support' | 'reports';

export default function AdminPanel({ onBack, initialTab = 'stats' }: AdminPanelProps) {
  const { formatNumber } = useFormat();
  const { statuses: gameStatuses } = useGameStatus();
  const gameOptions = gameStatuses.map((status) => ({ game: status.game, label: status.label || GAME_LABELS[status.game] || status.game }));
  const [tab, setTab] = useState<Tab>(initialTab);
  const [game, setGame] = useState<Game>('test');
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
      setMessage(errorNotice(error));
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
      setMessage(errorNotice(wd.error ?? af.error));
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
    if (error) setMessage(errorNotice(error));
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
    setLoadingStats(true);
    const { data, error } = await supabase.rpc('admin_get_stats', { p_round_date: date });
    if (!error && data) setStats(data as AdminStats);
    if (error) setMessage(errorNotice(error));
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
    if (error) setMessage(errorNotice(error));
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
    if (error) setMessage(errorNotice(error));
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
    if (error) setMessage(errorNotice(error));
    if (!error && data) setSelections(data as AdminSelection[]);
    setLoadingSelections(false);
  };

  useEffect(() => {
    loadLatest(game);
    loadStats(statsRoundDate);
  }, [game, loadStats, statsRoundDate]);

  useEffect(() => { void loadWithdrawals(); }, [loadWithdrawals]);

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
      await loadWithdrawals(); await loadStats();
    } catch (err) { setMessage(errorNotice(err)); }
    finally { setProcessingId(null); }
  };

  const handleAddFunds = async (id: string, status: 'approved' | 'rejected', reason?: string) => {
    setProcessingId(id);
    try {
      const { error } = await supabase.rpc('admin_process_add_funds', { p_request_id: id, p_new_status: status, p_reason: reason ?? null });
      if (error) throw error;
      await loadWithdrawals(); await loadStats();
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
      setMessage(errorNotice(error));
    }
    setScreenshotLoading(false);
  };

  const pending = withdrawals.filter((w) => w.status === 'pending');
  const pendingAddFunds = addFundsReqs.filter((a) => a.status === 'pending');

  const tabs: { id: Tab; label: string; icon: typeof BarChart3; badge?: number }[] = [
    { id: 'stats', label: 'Overview', icon: BarChart3 },
    { id: 'results', label: 'Results', icon: Trophy },
    { id: 'requests', label: 'Requests', icon: Wallet, badge: pending.length + pendingAddFunds.length },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'selections', label: 'Selections', icon: ListChecks },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'support', label: 'Support', icon: Users },
    { id: 'reports', label: 'Reports', icon: BarChart3 },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-amber-500/10 rounded-full blur-[120px] pointer-events-none" />

      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-5 py-3.5 flex items-center gap-3">
          <button onClick={onBack} className="tap-target text-slate-400 hover:text-white transition-colors p-1" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="font-bold text-white leading-tight">Admin Panel</h2>
            <p className="text-[11px] text-slate-400 leading-tight">Full control center</p>
          </div>
          <div className="ml-auto"><HelpButton /></div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-6 space-y-6 relative z-10">
        {/* Tab bar */}
        <div className="flex gap-1 border border-slate-800 rounded-2xl bg-slate-900/80 p-1 overflow-x-auto">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {t.badge ? (
                  <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-xs font-semibold ${tab === t.id ? 'bg-emerald-500 text-white' : 'bg-amber-950 text-amber-400'}`}>
                    {t.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

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
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Game</label>
              <select
                value={game}
                onChange={(e) => {
                  const nextGame = e.target.value as Game;
                  setGame(nextGame);
                  setRoundDate(defaultRoundDate(gameStatuses.find((status) => status.game === nextGame)));
                }}
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
              >
                {gameStatuses.map((status) => (
                  <option key={status.game} value={status.game}>{status.label || GAME_LABELS[status.game] || status.game}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Round date</label>
              <input
                type="date"
                value={roundDate}
                onChange={(e) => setRoundDate(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none"
              />
            </div>

            {latestResult && (
              <div className="border border-slate-800 rounded-2xl bg-slate-900/80 p-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <Trophy className="w-3.5 h-3.5 text-amber-400" />
                  <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                    {latestResult.round_date === gameStatuses.find((status) => status.game === game)?.server_ist_date
                      ? `Today's result — ${latestResult.round_date}`
                      : `Latest result — ${latestResult.round_date}`}
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 sm:gap-4 py-3">
                  {latestResult.open_patti && <span className="text-sm font-bold text-slate-400">{latestResult.open_patti}</span>}
                  {latestResult.open_digit && <span className="text-3xl font-bold text-emerald-400">{latestResult.open_digit}</span>}
                  {latestResult.close_digit && <span className="text-3xl font-bold text-cyan-400">{latestResult.close_digit}</span>}
                  {latestResult.close_patti && <span className="text-sm font-bold text-slate-400">{latestResult.close_patti}</span>}
                  {!latestResult.open_digit && !latestResult.close_digit && <span className="text-sm text-slate-400">No results yet</span>}
                </div>
                <div className="flex justify-center gap-3">
                  {latestResult.open_digit && <span className={`text-xs px-2 py-0.5 rounded-full ${latestResult.open_processed ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-400'}`}>Open {latestResult.open_processed ? 'paid' : 'pending'}</span>}
                  {latestResult.close_digit && <span className={`text-xs px-2 py-0.5 rounded-full ${latestResult.close_processed ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-400'}`}>Close {latestResult.close_processed ? 'paid' : 'pending'}</span>}
                </div>
              </div>
            )}

            <div className="border border-amber-900/70 rounded-2xl bg-amber-950/20 p-4 space-y-3">
              <div>
                <h3 className="text-xs font-medium text-amber-300 uppercase tracking-wide">Round Exposure — {roundDate}</h3>
                <p className="text-xs text-slate-400 mt-1">
                  Per-user cap: {exposure ? formatNumber(exposure.max_user_round_points) : '—'} balance
                  <span className="mx-2 text-slate-400">·</span>
                  Per-number payout cap: {exposure ? formatNumber(exposure.max_number_liability) : '—'} balance
                </p>
              </div>
              {loadingExposure ? (
                <div className="flex items-center justify-center py-4 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /></div>
              ) : exposureError ? (
                <div className="text-sm text-rose-400">
                  <p>{exposureError}</p>
                  {exposureErrorDetails && <p className="mt-1 text-xs text-rose-400/70">{exposureErrorDetails}</p>}
                </div>
              ) : exposure ? (
                <div className="space-y-3">
                  <p className="text-xs text-amber-200">
                    Combined worst-case payout (reporting only): Open {formatNumber(exposure.phase_exposure.open_worst_case)} · Close {formatNumber(exposure.phase_exposure.close_worst_case)}
                  </p>
                  {Array.from(new Set(exposure.exposure.map((item) => item.bet_type))).map((betType) => (
                    <div key={betType}>
                      <h4 className="text-xs font-medium text-slate-300 mb-1.5">{BET_TYPES[betType].label} — {formatNumber(exposure.stake_totals?.find((item) => item.bet_type === betType)?.total_stake ?? 0)} total staked · top numbers by potential payout</h4>
                      <div className="space-y-1">
                        {exposure.exposure.filter((item) => item.bet_type === betType).map((item) => (
                          <div key={`${item.bet_type}-${item.number}`} className="flex items-center justify-between text-xs">
                            <span className="text-slate-400">{item.number} <span className="text-slate-400">({formatNumber(item.total_stake)} staked)</span></span>
                            <span className="font-semibold text-amber-300">{formatNumber(item.potential_payout)} balance</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {exposure.exposure.length === 0 && <p className="text-sm text-slate-400">No bets have been placed for this round.</p>}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No bets have been placed for this round.</p>
              )}
            </div>

            {/* Post Open Result */}
            <div className="border border-slate-800 rounded-2xl bg-slate-900/80 p-5">
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Post Open Result</h3>
              <div className="mb-4">
                <label className="block text-xs text-slate-400 mb-1.5">Open Patti</label>
                <input type="text" value={openPatti} onChange={(e) => setOpenPatti(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="e.g. 123" maxLength={3}
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
                <label className="block text-xs text-slate-400 mt-3 mb-1.5">Open Digit</label>
                <input type="text" inputMode="numeric" value={openDigit} onChange={(e) => setOpenDigit(e.target.value.replace(/\D/g, '').slice(0, 1))} placeholder="0-9" maxLength={1}
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
                {openPatti && <p className="text-xs text-slate-400 mt-2">{isValidPatti(openPatti) ? `Patti digit: ${pattiDigit(openPatti)}${openDigit && Number(openDigit) !== pattiDigit(openPatti) ? ' — entered digit does not match' : ''}` : 'Invalid patti'}</p>}
                  <ResultPreviewCard {...openPreview} />
                </div>
                <button onClick={() => { setConfirmPhase('open'); setConfirmPatti(''); }} disabled={posting || !isValidPatti(openPatti) || !/^[0-9]$/.test(openDigit) || Number(openDigit) !== pattiDigit(openPatti) || !roundDate}
                  className="w-full py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
                  {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Trophy className="w-4 h-4" /> Review Open Payouts</>}
              </button>
            </div>

            {/* Post Close Result */}
            <div className="border border-slate-800 rounded-2xl bg-slate-900/80 p-5">
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Post Close Result</h3>
              <div className="mb-4">
                <label className="block text-xs text-slate-400 mb-1.5">Close Patti</label>
                <input type="text" value={closePatti} onChange={(e) => setClosePatti(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="e.g. 135" maxLength={3}
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
                <label className="block text-xs text-slate-400 mt-3 mb-1.5">Close Digit</label>
                <input type="text" inputMode="numeric" value={closeDigit} onChange={(e) => setCloseDigit(e.target.value.replace(/\D/g, '').slice(0, 1))} placeholder="0-9" maxLength={1}
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:border-cyan-400 focus:ring-0 focus:outline-none" />
                {closePatti && <p className="text-xs text-slate-400 mt-2">{isValidPatti(closePatti) ? `Patti digit: ${pattiDigit(closePatti)}${closeDigit && Number(closeDigit) !== pattiDigit(closePatti) ? ' — entered digit does not match' : ''}` : 'Invalid patti'}</p>}
                <ResultPreviewCard {...closePreview} />
              </div>
              <button onClick={() => { setConfirmPhase('close'); setConfirmPatti(''); }} disabled={posting || !isValidPatti(closePatti) || !/^[0-9]$/.test(closeDigit) || Number(closeDigit) !== pattiDigit(closePatti) || !roundDate}
                className="w-full py-2.5 rounded-xl bg-cyan-600 text-white text-sm font-medium hover:bg-cyan-500 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
                {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Trophy className="w-4 h-4" /> Review Close Payouts</>}
              </button>
            </div>

            {message && (
              <div className={`text-sm ${message.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
                <p>{message.text}</p>
                {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
              </div>
            )}
            {payoutResult && payoutResult.status === 'processed' && (
              <div className="border border-emerald-900 bg-emerald-950/30 rounded-xl p-4 text-sm">
                <p className="font-medium text-emerald-400">{payoutResult.phase === 'open' ? 'Open' : 'Close'} payouts processed</p>
                <p className="text-emerald-500 mt-1"><span className="font-bold">{payoutResult.winners}</span> winner(s), <span className="font-bold">{payoutResult.total_paid}</span> balance paid out.</p>
              </div>
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
            onProcessWithdrawal={(id, status, reason) => { void handleWithdrawal(id, status, reason); }}
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
        {tab === 'support' && <SupportTab />}
        {tab === 'reports' && <ReportsTab />}
      </main>

      {tab === 'users' && detailUser && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-slate-950 p-5">
          <div className="mx-auto max-w-2xl py-4">
            <UserDetail userId={detailUser.id} onBack={() => setDetailUser(null)} />
          </div>
        </div>
      )}

      {confirmPhase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={() => !posting && setConfirmPhase(null)}>
          <section ref={resultConfirmRef} role="dialog" aria-modal="true" aria-labelledby="result-confirm-title" className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3 id="result-confirm-title" className="text-lg font-bold">Confirm {confirmPhase} result</h3>
              <p className="mt-1 text-sm text-rose-300">Posting pays winning picks immediately. Payouts cannot be undone.</p>
            </header>
            <ResultPreviewCard {...(confirmPhase === 'open' ? openPreview : closePreview)} />
            <div className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-3">
              <p className="mb-2 text-xs font-medium text-amber-200">Round exposure · {roundDate}</p>
              {loadingExposure ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : exposureError ? (
                <p role="alert" className="text-xs text-rose-300">{exposureError}{exposureErrorDetails && ` ${exposureErrorDetails}`}</p>
              ) : exposure?.exposure.length ? exposure.exposure.map((item) => (
                <p key={`${item.bet_type}-${item.number}`} className="flex justify-between gap-2 py-0.5 text-xs text-slate-300">
                  <span>{BET_TYPES[item.bet_type].label} · {item.number} · stake {item.total_stake}</span>
                  <span>{item.potential_payout} potential payout</span>
                </p>
              )) : <p className="text-xs text-slate-400">No exposed picks.</p>}
            </div>
            <label className="block text-xs text-slate-300">
              Type <strong>{confirmPhase === 'open' ? openPatti : closePatti}</strong> to confirm
              <input value={confirmPatti} onChange={(event) => setConfirmPatti(event.target.value)} autoComplete="off" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-white" />
            </label>
            {message?.kind === 'err' && <p role="alert" className="text-xs text-rose-300">{message.text}{message.raw && ` ${message.raw}`}</p>}
            <div className="flex gap-2">
              <button type="button" disabled={posting} onClick={() => setConfirmPhase(null)} className="flex-1 rounded-lg border border-slate-700 py-2.5 text-sm text-slate-300">Back</button>
              <button type="button" disabled={posting || confirmPatti !== (confirmPhase === 'open' ? openPatti : closePatti) || (confirmPhase === 'open' ? openPreview.loading || !openPreview.preview || openPreview.preview.patti !== openPatti || openPreview.preview.warnings.length > 0 : closePreview.loading || !closePreview.preview || closePreview.preview.patti !== closePatti || closePreview.preview.warnings.length > 0)} onClick={() => void (confirmPhase === 'open' ? handlePostOpen() : handlePostClose())} className="flex-1 rounded-lg bg-rose-700 py-2.5 text-sm font-semibold text-white disabled:opacity-40">
                {posting ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Post and pay'}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Adjust balance modal */}
      {adjustTarget && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4" onClick={() => !adjusting && setAdjustTarget(null)}>
          <div className="bg-slate-900 rounded-2xl border border-slate-800 w-full max-w-sm p-6 space-y-4 animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white">Adjust {adjustTarget.type === 'points' ? 'play balance' : 'wallet balance'}</h3>
              <button onClick={() => !adjusting && setAdjustTarget(null)} className="tap-target text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-800 border border-slate-700">
              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-sm font-semibold text-slate-300">
                {adjustTarget.user.display_name.charAt(0).toUpperCase() || '?'}
              </div>
              <div>
                <p className="text-sm font-medium text-white">{adjustTarget.user.display_name || 'Unnamed'}</p>
                <p className="text-xs text-slate-400">Current balance: {adjustTarget.type === 'points' ? adjustTarget.user.points : adjustTarget.user.wallet}</p>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Balance adjustment (use negative to deduct)</label>
              <input type="number" step={1} value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} placeholder="e.g. 500 or -200"
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Reason</label>
              <input type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="e.g. Bonus credit / correction"
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none" />
            </div>
            <button onClick={handleAdjust} disabled={adjusting || pendingConfirm !== null}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-sm font-bold hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-40 transition-all flex items-center justify-center gap-2">
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
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => { setScreenshotUrl(null); setScreenshotLoading(false); }}>
          <div className="relative max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setScreenshotUrl(null); setScreenshotLoading(false); }} className="tap-target absolute -top-10 right-0 text-slate-400 hover:text-white">
              <X className="w-6 h-6" />
            </button>
            {screenshotLoading ? (
              <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-8 h-8 animate-spin" /></div>
            ) : (
              <img src={screenshotUrl!} alt="Payment screenshot" className="w-full rounded-xl border border-slate-700" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
