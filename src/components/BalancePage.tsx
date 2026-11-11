import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import WithdrawalForm, { type WalletStatus } from '@/components/WithdrawalForm';
import { friendlyError, friendlyErrorDetails, rawErrorMessage } from '@/lib/errors';
import { useUserRequests } from '@/lib/useUserRequests';
import RequestTimeline from '@/components/RequestTimeline';
import { QRCodeSVG } from 'qrcode.react';
import HelpButton from '@/components/HelpButton';
import { CardSkeleton } from '@/components/Skeleton';
import { useDialogA11y } from '@/lib/useDialogA11y';
import { useFormat } from '@/i18n/useFormat';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import {
  ArrowLeft, Loader2, Wallet, Gift, TrendingDown,
  Plus, Send, Lock, CheckCircle2, Sparkles,
  Upload, Smartphone, X, Check, Copy, AlertCircle, ReceiptText,
} from 'lucide-react';

interface BalancePageProps {
  onBack: () => void;
  onBalanceChanged: () => void;
  onMyBets?: () => void;
  /** Admin-only shortcut to Admin → Settings (shown when deposits are not set up). */
  onOpenAdminSettings?: () => void;
}

interface Breakdown {
  signup_earned: number;
  selections_spent: number;
  winnings_total: number;
  deposits_total: number;
  withdrawn_total: number;
  play_balance: number;
  wallet: number;
  pending_withdrawals: number;
  pending_add_funds: number;
  max_add_funds_amount: number;
}

interface Txn {
  id: string;
  amount: number;
  status: string;
  upi_id?: string;
  payment_ref?: string;
  screenshot_path?: string | null;
  created_at: string;
}

type ModalMode = 'withdraw' | 'add' | null;

const DEFAULT_MERCHANT_NAME = 'BetZone';

export default function BalancePage({ onBack, onBalanceChanged, onMyBets, onOpenAdminSettings }: BalancePageProps) {
  const { formatNumber, formatDate } = useFormat();
  const { profile } = useAuth();
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [withdrawals, setWithdrawals] = useState<Txn[]>([]);
  const [addFunds, setAddFunds] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalMode>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [amount, setAmount] = useState('');
  const [upiOrRef, setUpiOrRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string; raw?: string } | null>(null);

  // Screenshot upload state
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [merchantUpiId, setMerchantUpiId] = useState('');
  const [merchantName, setMerchantName] = useState(DEFAULT_MERCHANT_NAME);
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [approvalTimeNote, setApprovalTimeNote] = useState('');
  const userRequests = useUserRequests();
  const { limits } = useMyLimits();
  const restriction = activePlayRestriction(limits);
  const selfExcluded = !!(limits?.self_excluded_until && Date.parse(limits.self_excluded_until) > Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bd, wallet, wd, af, upi, mname, approvalNote] = await Promise.all([
        supabase.rpc('get_balance_breakdown'),
        supabase.rpc('get_wallet_status'),
        supabase.from('withdrawals').select('id, amount, status, upi_id, created_at').order('created_at', { ascending: false }).limit(10),
        supabase.from('add_funds_requests').select('id, amount, status, payment_ref, screenshot_path, created_at').order('created_at', { ascending: false }).limit(10),
        supabase.rpc('get_app_setting', { p_key: 'merchant_upi_id' }),
        supabase.rpc('get_app_setting', { p_key: 'merchant_name' }),
        supabase.rpc('get_app_setting', { p_key: 'approval_time_note' }),
      ]);
      const loadError = bd.error ?? wallet.error ?? wd.error ?? af.error ?? upi.error ?? mname.error ?? approvalNote.error;
      if (loadError) {
        const friendly = friendlyErrorDetails(loadError);
        setMessage({ kind: 'err', text: friendly.message, raw: friendly.raw });
      } else {
        setMessage(null);
      }
      if (!bd.error && bd.data) setBreakdown(bd.data as Breakdown);
      if (!wallet.error && wallet.data) setWalletStatus(wallet.data as WalletStatus);
      if (!wd.error && wd.data) setWithdrawals(wd.data as Txn[]);
      if (!af.error && af.data) setAddFunds(af.data as Txn[]);
      setMerchantUpiId(typeof upi.data === 'string' ? upi.data : '');
      setMerchantName(typeof mname.data === 'string' && mname.data ? mname.data : DEFAULT_MERCHANT_NAME);
      setApprovalTimeNote(typeof approvalNote.data === 'string' ? approvalNote.data : '');
    } catch (error) {
      const friendly = friendlyErrorDetails(error);
      setMessage({ kind: 'err', text: friendly.message, raw: friendly.raw });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const resetModal = useCallback(() => {
    setModal(null);
    setAmount('');
    setUpiOrRef('');
    setScreenshotFile(null);
    setScreenshotPreview(null);
    setMessage(null);
  }, []);
  const closeModal = useCallback(() => {
    if (!submitting && !uploadingScreenshot) resetModal();
  }, [resetModal, submitting, uploadingScreenshot]);
  useDialogA11y(modal !== null, modalRef, closeModal);

  const handleScreenshotSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setMessage({ kind: 'err', text: 'Please choose a photo (JPG, PNG or WebP).' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage({ kind: 'err', text: 'This photo is too big. Please choose one under 5 MB.' });
      return;
    }
    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onloadend = () => setScreenshotPreview(reader.result as string);
    reader.readAsDataURL(file);
    setMessage(null);
  };

  const uploadScreenshot = async (): Promise<string | null> => {
    if (!screenshotFile || !profile) return null;
    if (addFunds.some((request) => request.status === 'pending')) {
      setMessage({ kind: 'err', text: 'You already have a payment being checked. Please wait for it to finish before adding money again.' });
      return null;
    }
    const EXT: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const ext = EXT[screenshotFile.type];
    if (!ext) {
      setMessage({ kind: 'err', text: 'Please choose a photo (JPG, PNG or WebP).' });
      return null;
    }

    setUploadingScreenshot(true);
    try {
      const filePath = `${profile.id}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from('payment-screenshots')
        .upload(filePath, screenshotFile, { contentType: screenshotFile.type });
      if (error) throw error;
      setUploadingScreenshot(false);
      return filePath;
    } catch (err) {
      setUploadingScreenshot(false);
      const friendly = friendlyError(err);
      setMessage({
        kind: 'err',
        text: `Screenshot upload failed: ${friendly.message}`,
        raw: friendly.key === 'errors.generic' ? rawErrorMessage(err) : undefined,
      });
      return null;
    }
  };

  const buildUpiDeepLink = (amountVal: number): string => {
    const params = new URLSearchParams({
      pa: merchantUpiId,
      pn: merchantName,
      am: String(amountVal),
      cu: 'INR',
    });
    return `upi://pay?${params.toString()}`;
  };

  const buildAppDeepLink = (amountVal: number, app: 'phonepe' | 'gpay' | 'paytm' | 'bhim'): string => {
    const base = buildUpiDeepLink(amountVal);
    // For app-specific schemes, replace the upi:// prefix
    if (app === 'gpay') return `tez://upi/pay?${base.split('?')[1]}`;
    if (app === 'phonepe') return `phonepe://pay?${base.split('?')[1]}`;
    if (app === 'paytm') return `paytmmp://pay?${base.split('?')[1]}`;
    return base;
  };

  const copyUpiId = async () => {
    try {
      await navigator.clipboard.writeText(merchantUpiId);
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2000);
    } catch {
      setMessage({ kind: 'err', text: "Couldn't copy. Please copy the UPI ID yourself." });
    }
  };

  const handleSubmit = async () => {
    if (modal !== 'add') return;
    const parsedAmount = Number(amount);
    if (!/^[0-9]+$/.test(amount) || !Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
      setMessage({ kind: 'err', text: 'Please enter an amount in whole rupees, like 500.' });
      return;
    }
    if (!breakdown || parsedAmount > breakdown.max_add_funds_amount) {
      setMessage({ kind: 'err', text: `You can add up to ₹${breakdown ? formatNumber(breakdown.max_add_funds_amount) : '—'} at a time.` });
      return;
    }
    if (!/^[0-9A-Za-z]{8,30}$/.test(upiOrRef.trim())) {
      setMessage({ kind: 'err', text: 'Please enter the UTR number from your payment app. It is 8–30 letters or numbers, usually 12 digits.' });
      return;
    }
    if (!screenshotFile) {
      setMessage({ kind: 'err', text: 'Please upload a screenshot of your payment.' });
      return;
    }
    if (!merchantUpiId) {
      setMessage({ kind: 'err', text: 'Adding money isn\'t available right now.' });
      return;
    }

    setSubmitting(true);
    setMessage(null);
    let uploadedScreenshotPath: string | null = null;
    try {
      const path = await uploadScreenshot();
      if (!path) {
        setSubmitting(false);
        return;
      }
      uploadedScreenshotPath = path;
      const { error } = await supabase.rpc('request_add_funds', {
        p_amount: parsedAmount,
        p_payment_ref: upiOrRef.trim(),
        p_screenshot_path: path,
      });
      if (error) throw error;
      uploadedScreenshotPath = null;
      resetModal();
      await load();
      await userRequests.refresh();
      onBalanceChanged();
      setMessage({ kind: 'ok', text: 'Thanks! We\'re checking your payment. The money will be added to your balance once it\'s confirmed.' });
    } catch (err) {
      const friendly = friendlyError(err);
      const msg = friendly.message;
      let raw = friendly.key === 'errors.generic' ? rawErrorMessage(err) : undefined;
      if (uploadedScreenshotPath) {
        const { error: removeError } = await supabase.storage
          .from('payment-screenshots')
          .remove([uploadedScreenshotPath]);
        if (removeError) {
          console.error('Failed to remove orphaned payment screenshot', removeError);
          raw = [raw, `Screenshot cleanup failed: ${removeError.message}`].filter(Boolean).join(' ');
        }
      }
      setMessage({ kind: 'err', text: msg, raw });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />

      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-5 py-3.5 flex items-center gap-3">
          <button onClick={onBack} className="tap-target text-slate-400 hover:text-white transition-colors p-1" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="font-bold text-white leading-tight">Balance</h2>
            <p className="text-[11px] text-slate-400 leading-tight">All your balance in one place</p>
          </div>
          {onMyBets && (
            <button type="button" onClick={onMyBets} className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800">
              <ReceiptText className="h-3.5 w-3.5" /> My bets
            </button>
          )}
          <HelpButton />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8 space-y-8 relative z-10">
        {loading ? (
          <div className="space-y-4"><CardSkeleton /><CardSkeleton /></div>
        ) : breakdown ? (
          <>
            {restriction && (
              <div className="rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
                {restriction.kind === 'cooldown' ? 'You are on a betting break' : 'You have paused your account'} until {formatLimitEnd(restriction.until)}.
                {selfExcluded && ' You can\'t add money during this time, but you can still withdraw.'}
              </div>
            )}
            {/* Hero total */}
            <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 p-6 animate-slide-up">
              <div className="absolute top-0 right-0 opacity-5">
                <Wallet className="w-32 h-32 -mr-8 -mt-8" />
              </div>
              <div className="relative">
                <p className="text-xs font-medium uppercase tracking-widest text-slate-400 mb-1">Your total balance</p>
                <div className="flex items-baseline gap-2">
                  <p className="text-5xl font-bold tracking-tight text-white">₹{formatNumber(breakdown.play_balance + breakdown.wallet)}</p>
                </div>
                <div className="flex gap-6 mt-5">
                  <div>
                    <p className="text-[11px] text-slate-400">For betting only</p>
                    <p className="text-lg font-semibold text-cyan-400">₹{formatNumber(breakdown.play_balance)}</p>
                  </div>
                  <div className="border-l border-slate-700 pl-6">
                    <p className="text-[11px] text-slate-400">Can be withdrawn</p>
                    <p className="text-lg font-semibold text-emerald-400">₹{formatNumber(breakdown.wallet)}</p>
                  </div>
                </div>
              </div>
            </section>

            {/* Action buttons */}
            <section className="grid grid-cols-2 gap-3 animate-slide-up" style={{ animationDelay: '50ms' }}>
              <button
                onClick={() => { setModal('add'); setMessage(null); setAmount(''); setUpiOrRef(''); setScreenshotFile(null); setScreenshotPreview(null); }}
                disabled={selfExcluded || !merchantUpiId}
                className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-bold hover:from-emerald-400 hover:to-emerald-500 transition-all shadow-lg shadow-emerald-500/15 disabled:opacity-40"
              >
                <Plus className="w-4 h-4" /> Add money
              </button>
              <button
                onClick={() => { setModal('withdraw'); setMessage(null); setAmount(''); setUpiOrRef(''); }}
                className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold hover:bg-slate-700 hover:border-slate-600 transition-all"
              >
                <Send className="w-4 h-4" /> Withdraw
              </button>
            </section>

            {!merchantUpiId && !selfExcluded && (
              <div role="status" className="rounded-xl border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
                {profile?.is_admin ? (
                  <>
                    <p>Add money is switched off because your UPI ID isn't saved yet. Players can't add money until you save it.</p>
                    {onOpenAdminSettings && (
                      <button type="button" onClick={onOpenAdminSettings} className="mt-2 min-h-[44px] rounded-lg border border-amber-700 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-900/40">
                        Open Admin → Settings
                      </button>
                    )}
                  </>
                ) : (
                  <p>Adding money isn't available right now. Please try again later, or contact support.</p>
                )}
              </div>
            )}
            {selfExcluded && (
              <p className="rounded-xl border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
                You paused your account, so you can't add money until {formatLimitEnd(limits!.self_excluded_until!)}.
              </p>
            )}
            {message && !modal && (
              <div role={message.kind === 'err' ? 'alert' : 'status'} className={`flex items-start gap-2 text-sm rounded-xl px-4 py-3 animate-scale-in ${message.kind === 'ok' ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-900' : 'text-rose-400 bg-rose-950/40 border border-rose-900'}`}>
                {message.kind === 'ok' && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
                <div><p>{message.text}</p>{message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}</div>
              </div>
            )}
            {approvalTimeNote && (
              <p className="rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs text-slate-300">{approvalTimeNote}</p>
            )}
            {modal === 'add' && (!merchantUpiId || selfExcluded) && (
              <p className="rounded-lg border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
                {selfExcluded ? `You can't add money until ${formatLimitEnd(limits!.self_excluded_until!)}.` : 'Adding money isn\'t available right now.'}
              </p>
            )}

            {/* Breakdown cards */}
            <section className="animate-slide-up" style={{ animationDelay: '100ms' }}>
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Where your money came from</h3>
              <div className="space-y-2.5">
                <BreakdownRow icon={<Gift className="w-4 h-4 text-amber-400" />} label="Welcome bonus" value={breakdown.signup_earned} sub="Given once when you joined" />
                <BreakdownRow icon={<Plus className="w-4 h-4 text-cyan-400" />} label="Money added" value={breakdown.deposits_total} sub="Payments we've checked and added" />
                <BreakdownRow icon={<TrendingDown className="w-4 h-4 text-rose-400" />} label="Spent on bets" value={-breakdown.selections_spent} sub="Total amount you've bet" />
                <BreakdownRow icon={<Sparkles className="w-4 h-4 text-emerald-400" />} label="Winnings" value={breakdown.winnings_total} sub="Total you've won" />
                <BreakdownRow icon={<Send className="w-4 h-4 text-slate-400" />} label="Withdrawn" value={-breakdown.withdrawn_total} sub="Money sent to your UPI" />
              </div>
            </section>

            <RequestTimeline requests={userRequests.requests} error={userRequests.error} />

            {/* History */}
            <section>
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Your payments</h3>
              {withdrawals.length === 0 && addFunds.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-sm text-slate-400">You haven't added or withdrawn money yet.</p>
                  <button
                    type="button"
                    onClick={() => { setModal('add'); setMessage(null); setAmount(''); setUpiOrRef(''); }}
                    disabled={!merchantUpiId || selfExcluded}
                    className="mt-3 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-emerald-300 disabled:opacity-40"
                  >
                    Add money
                  </button>
                </div>
              ) : (
                <div className="border border-slate-800 rounded-2xl bg-slate-900/80 divide-y divide-slate-800">
                  {[...withdrawals.map(w => ({ ...w, type: 'withdraw' })), ...addFunds.map(a => ({ ...a, type: 'add' }))]
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                    .map((txn) => (
                      <div key={txn.id} className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {txn.type === 'withdraw' ? <Send className="w-3.5 h-3.5 text-slate-400" /> : <Plus className="w-3.5 h-3.5 text-emerald-400" />}
                          <div>
                            <p className="text-sm font-medium text-slate-200">
                              {txn.type === 'withdraw' ? 'Withdrawal' : 'Money added'} — ₹{txn.amount}
                            </p>
                            <p className="text-[11px] text-slate-400">{formatDate(txn.created_at)}</p>
                          </div>
                        </div>
                        <span className={`text-xs capitalize px-2 py-1 rounded-full font-medium ${
                          txn.status === 'approved' ? 'bg-emerald-950 text-emerald-400' :
                          txn.status === 'rejected' ? 'bg-rose-950 text-rose-400' :
                          'bg-amber-950 text-amber-400'
                        }`}>{txn.status === 'approved' ? 'Done' : txn.status === 'rejected' ? 'Rejected' : 'Being checked'}</span>
                      </div>
                    ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <p className="text-center text-slate-400 py-12">We couldn't load your balance. Please check your internet and try again.</p>
        )}
      </main>

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]" onClick={() => !submitting && !uploadingScreenshot && resetModal()}>
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="balance-modal-title"
            className="w-full max-w-md max-h-[90vh] overflow-y-auto bg-slate-900 rounded-t-2xl sm:rounded-2xl border border-slate-800 p-6 space-y-4 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 id="balance-modal-title" className="text-lg font-bold text-white">{modal === 'withdraw' ? 'Withdraw money' : 'Add money'}</h3>
              <button type="button" aria-label="Close dialog" onClick={closeModal} className="tap-target text-slate-400 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {modal === 'add' && (
              <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5">
                <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                <p className="text-xs text-slate-400">Money you add can be used for betting once we've checked your payment. You can add up to ₹{breakdown ? formatNumber(breakdown.max_add_funds_amount) : '—'} at a time.</p>
              </div>
            )}

            {modal === 'withdraw' ? (
              <WithdrawalForm
                status={walletStatus}
                onSubmittingChange={setSubmitting}
                onSubmitted={async () => {
                  resetModal();
                  await load();
                  await userRequests.refresh();
                  onBalanceChanged();
                  setMessage({ kind: 'ok', text: 'Withdrawal request sent. We\'ll send the money to your UPI ID after checking it.' });
                }}
              />
            ) : (
              <>
                <div>
                  <label htmlFor="add-funds-amount" className="block text-xs text-slate-400 mb-1.5">How much do you want to add? (₹)</label>
                  <input
                    id="add-funds-amount"
                    type="text" inputMode="numeric" value={amount}
                    pattern="[0-9]*"
                    onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                    onChange={(e) => { setAmount(e.target.value); setMessage(null); }}
                    disabled={!merchantUpiId || selfExcluded}
                    placeholder="e.g. 500"
                    className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none disabled:opacity-40"
                  />
                </div>

            {/* UPI Deep Link for Add Funds */}
            {modal === 'add' && !!breakdown && /^[0-9]+$/.test(amount) && Number(amount) > 0 && Number(amount) <= breakdown.max_add_funds_amount && (
              <div className="space-y-3 animate-fade-in">
                {merchantUpiId ? (
                  <div className="border border-emerald-900 bg-emerald-950/30 rounded-xl p-4 space-y-3">
                  <div className="flex justify-center rounded-lg bg-white p-3">
                    <QRCodeSVG value={buildUpiDeepLink(Number(amount))} size={160} level="M" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-4 h-4 text-emerald-400" />
                    <p className="text-sm font-medium text-emerald-300">Step 1: Pay with UPI</p>
                  </div>
                  <div className="flex items-center justify-between gap-2 bg-slate-900/60 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide">Send money to this UPI ID</p>
                      <p className="text-sm font-mono font-medium text-emerald-400 truncate">{merchantUpiId}</p>
                    </div>
                    <button
                      onClick={copyUpiId}
                      className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
                    >
                      {copiedUpi ? <><Check className="w-3 h-3 text-emerald-400" /> Copied</> : <><Copy className="w-3 h-3" /> Copy UPI ID</>}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <p className="text-[11px] text-amber-300">Pay exactly <span className="font-bold">₹{amount}</span> to {merchantName}</p>
                  </div>
                  <p className="text-xs text-slate-400 text-center">Tap your UPI app to pay ₹{amount}, or scan the QR code</p>
                  <div className="grid grid-cols-2 gap-2">
                    <a
                      href={buildAppDeepLink(Number(amount), 'phonepe')}
                      className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-violet-600/90 text-white text-sm font-semibold hover:bg-violet-500 transition-colors"
                    >
                      <Smartphone className="w-4 h-4" /> PhonePe
                    </a>
                    <a
                      href={buildAppDeepLink(Number(amount), 'gpay')}
                      className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-blue-600/90 text-white text-sm font-semibold hover:bg-blue-500 transition-colors"
                    >
                      <Smartphone className="w-4 h-4" /> Google Pay
                    </a>
                    <a
                      href={buildAppDeepLink(Number(amount), 'paytm')}
                      className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-sky-700/90 text-white text-sm font-semibold hover:bg-sky-600 transition-colors"
                    >
                      <Smartphone className="w-4 h-4" /> Paytm
                    </a>
                    <a
                      href={buildAppDeepLink(Number(amount), 'bhim')}
                      className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-emerald-600/90 text-white text-sm font-semibold hover:bg-emerald-500 transition-colors"
                    >
                      <Smartphone className="w-4 h-4" /> BHIM / Other
                    </a>
                  </div>
                    <p className="text-[11px] text-slate-400 text-center">
                      If the app doesn't open, copy the UPI ID above and pay from your UPI app yourself.
                    </p>
                    <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-300">
                      <li>Pay ₹{amount} to the UPI ID above, or scan the QR code.</li>
                      <li>Take a screenshot of the "Payment successful" screen.</li>
                      <li>In your payment app, open the payment and copy the UTR number (usually 12 digits).</li>
                      <li>Upload the screenshot and paste the UTR number below, then tap Send for checking.</li>
                    </ol>
                    </div>
                ) : (
                  <div className="flex items-center gap-2 bg-amber-950/30 border border-amber-900/50 rounded-lg px-3 py-2">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <p className="text-xs text-amber-300">Payments can't be received right now. Please don't send any money, and contact support.</p>
                  </div>
                )}

                {/* Screenshot upload */}
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Step 2: Payment screenshot <span className="text-rose-300">(required)</span></label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleScreenshotSelect}
                    disabled={!merchantUpiId || selfExcluded}
                    className="hidden"
                  />
                  {screenshotPreview ? (
                    <div className="relative rounded-xl overflow-hidden border border-slate-700">
                      <img src={screenshotPreview} alt="Payment screenshot" className="w-full max-h-48 object-cover" />
                      <button
                        onClick={() => { setScreenshotFile(null); setScreenshotPreview(null); setMessage(null); }}
                        className="tap-target absolute top-2 right-2 w-7 h-7 rounded-full bg-slate-900/80 flex items-center justify-center text-slate-400 hover:text-white"
                      >
                        <X className="w-4 h-4" />
                      </button>
                      <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/90 text-white text-xs font-medium">
                        <Check className="w-3 h-3" /> Screenshot added
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!merchantUpiId || selfExcluded}
                      className="w-full py-6 rounded-xl border-2 border-dashed border-slate-700 hover:border-emerald-700 transition-colors flex flex-col items-center gap-2 text-slate-400 hover:text-slate-400"
                    >
                      <Upload className="w-5 h-5" />
                      <span className="text-xs">Tap to add a screenshot of your payment</span>
                    </button>
                  )}
                </div>
              </div>
            )}

                <div>
                  <label htmlFor="add-funds-reference" className="block text-xs text-slate-400 mb-1.5">Step 3: UTR number <span className="text-rose-300">(required)</span></label>
                  <input
                    id="add-funds-reference"
                    type="text" value={upiOrRef} disabled={!merchantUpiId}
                    onChange={(e) => { setUpiOrRef(e.target.value); setMessage(null); }}
                    placeholder="e.g. 412345678901"
                    className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none disabled:opacity-40"
                  />
                </div>

                <p className="text-[11px] text-slate-400">
                  Find the UTR number in your payment app's transaction details. We'll check your payment and add the money to your balance.
                </p>

                {message && (
                  <div className={`text-sm ${message.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`} role={message.kind === 'err' ? 'alert' : 'status'}>
                    <p>{message.text}</p>{message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
                  </div>
                )}

                <button
                  onClick={handleSubmit}
                  disabled={
                    !merchantUpiId || selfExcluded || submitting || uploadingScreenshot ||
                    !screenshotFile || !/^[0-9A-Za-z]{8,30}$/.test(upiOrRef.trim()) ||
                    !/^[0-9]+$/.test(amount) ||
                    Number(amount) < 1 ||
                    !breakdown ||
                    Number(amount) > breakdown.max_add_funds_amount
                  }
                  className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-sm font-bold hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-40 transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/15"
                >
                  {submitting || uploadingScreenshot ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send for checking'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BreakdownRow({ icon, label, value, sub }: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
}) {
  const { formatNumber } = useFormat();
  return (
    <div className="flex items-center gap-3 border border-slate-800 rounded-2xl bg-slate-900/80 p-4">
      <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-sm font-semibold ${value < 0 ? 'text-rose-400' : 'text-white'}`}>
          {value > 0 ? '+' : ''}{formatNumber(value)} balance
        </p>
      </div>
    </div>
  );
}
