import { useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertCircle, Check, Copy, Smartphone, Upload, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { formatLimitEnd } from '@/lib/useMyLimits';
import Alert from '@/components/ui/Alert';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/toastContext';
import { useFormat } from '@/i18n/useFormat';
import { interpolate, useT } from '@/i18n/useT';

const INPUT = 'w-full rounded-control border border-surface-strong bg-surface-raised px-4 py-3 text-sm text-ink-strong focus:border-brand-400 focus:outline-none disabled:opacity-40';
const UTR_PATTERN = /^[0-9A-Za-z]{8,30}$/;

function StepLabel({ step, htmlFor, children, required }: { step: number; htmlFor?: string; children: string; required?: boolean }) {
  const { t } = useT();
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-2 text-sm font-medium text-ink-soft">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-950 text-xs font-bold text-brand-300" aria-hidden="true">{step}</span>
      <span>{children} {required && <span className="text-xs font-normal text-rose-300">{t('money.required')}</span>}</span>
    </label>
  );
}

export default function AddMoneyPanel({
  maxAmount, merchantUpiId, merchantName, selfExcludedUntil, hasPendingDeposit, approvalTimeNote, onOpenAdminSettings, onSubmitted,
}: {
  maxAmount: number;
  merchantUpiId: string;
  merchantName: string;
  selfExcludedUntil: string | null;
  hasPendingDeposit: boolean;
  approvalTimeNote: string;
  onOpenAdminSettings?: () => void;
  onSubmitted: () => Promise<void>;
}) {
  const { formatNumber } = useFormat();
  const { t } = useT();
  const toast = useToast();
  const { profile } = useAuth();
  const [amount, setAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<{ text: string; raw?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const unavailable = !merchantUpiId || !!selfExcludedUntil;
  const amountValid = /^[0-9]+$/.test(amount) && Number(amount) > 0 && Number(amount) <= maxAmount;
  const amountValue = amountValid ? Number(amount) : 0;

  if (selfExcludedUntil) {
    return <Alert tone="warning">{interpolate(t('money.selfExcluded'), { date: formatLimitEnd(selfExcludedUntil) })}</Alert>;
  }
  if (!merchantUpiId) {
    return (
      <Alert
        tone="warning"
        action={profile?.is_admin && onOpenAdminSettings ? (
          <Button variant="secondary" onClick={onOpenAdminSettings}>{t('money.openAdminSettings')}</Button>
        ) : undefined}
      >
        {profile?.is_admin ? t('money.adminNoUpi') : t('money.unavailable')}
      </Alert>
    );
  }

  const upiLink = (value: number) => {
    const params = new URLSearchParams({ pa: merchantUpiId, pn: merchantName, am: String(value), cu: 'INR' });
    return `upi://pay?${params.toString()}`;
  };
  const appLink = (value: number, app: 'phonepe' | 'gpay' | 'paytm' | 'bhim') => {
    const query = upiLink(value).split('?')[1];
    if (app === 'gpay') return `tez://upi/pay?${query}`;
    if (app === 'phonepe') return `phonepe://pay?${query}`;
    if (app === 'paytm') return `paytmmp://pay?${query}`;
    return upiLink(value);
  };

  const copyUpiId = async () => {
    try {
      await navigator.clipboard.writeText(merchantUpiId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError({ text: t('money.copyFailed') });
    }
  };

  const handleScreenshotSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError({ text: t('money.photoType') });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError({ text: t('money.photoSize') });
      return;
    }
    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onloadend = () => setScreenshotPreview(reader.result as string);
    reader.readAsDataURL(file);
    setError(null);
  };

  const uploadScreenshot = async (): Promise<string | null> => {
    if (!screenshotFile || !profile) return null;
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[screenshotFile.type];
    if (!ext) {
      setError({ text: t('money.photoType') });
      return null;
    }
    const filePath = `${profile.id}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('payment-screenshots')
      .upload(filePath, screenshotFile, { contentType: screenshotFile.type });
    if (uploadError) {
      const friendly = friendlyError(uploadError);
      setError({
        text: interpolate(t('money.uploadFailed'), { message: friendly.message }),
        raw: friendly.key === 'errors.generic' ? rawErrorMessage(uploadError) : undefined,
      });
      return null;
    }
    return filePath;
  };

  const handleSubmit = async () => {
    if (!/^[0-9]+$/.test(amount) || Number(amount) <= 0) { setError({ text: t('money.amountWhole') }); return; }
    if (Number(amount) > maxAmount) { setError({ text: interpolate(t('money.amountMax'), { max: formatNumber(maxAmount) }) }); return; }
    if (!UTR_PATTERN.test(utr.trim())) { setError({ text: t('errors.reference') }); return; }
    if (!screenshotFile) { setError({ text: t('errors.screenshotRequired') }); return; }
    if (hasPendingDeposit) { setError({ text: t('money.pendingDeposit') }); return; }

    setSubmitting(true);
    setError(null);
    let uploadedPath: string | null = null;
    try {
      uploadedPath = await uploadScreenshot();
      if (!uploadedPath) return;
      const { error: rpcError } = await supabase.rpc('request_add_funds', {
        p_amount: Number(amount),
        p_payment_ref: utr.trim(),
        p_screenshot_path: uploadedPath,
      });
      if (rpcError) throw rpcError;
      uploadedPath = null;
      setAmount('');
      setUtr('');
      setScreenshotFile(null);
      setScreenshotPreview(null);
      toast.show(t('money.addSubmitted'));
      await onSubmitted();
    } catch (caught) {
      const friendly = friendlyError(caught);
      let raw = friendly.key === 'errors.generic' ? rawErrorMessage(caught) : undefined;
      if (uploadedPath) {
        const { error: removeError } = await supabase.storage.from('payment-screenshots').remove([uploadedPath]);
        if (removeError) {
          console.error('Failed to remove orphaned payment screenshot', removeError);
          raw = [raw, `Screenshot cleanup failed: ${removeError.message}`].filter(Boolean).join(' ');
        }
      }
      setError({ text: friendly.message, raw });
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !unavailable && !submitting && amountValid && !!screenshotFile && UTR_PATTERN.test(utr.trim());

  return (
    <div className="space-y-4">
      {hasPendingDeposit && <Alert tone="info">{t('money.pendingDeposit')}</Alert>}
      {approvalTimeNote && <Alert tone="info">{approvalTimeNote}</Alert>}

      <Card className="space-y-5">
        <div>
          <StepLabel step={1} htmlFor="add-funds-amount">{t('money.howMuch')}</StepLabel>
          <input
            id="add-funds-amount"
            type="text" inputMode="numeric" pattern="[0-9]*" value={amount}
            onChange={(event) => { setAmount(event.target.value); setError(null); }}
            placeholder={t('money.amountPlaceholder')}
            className={INPUT}
          />
          <p className="mt-1.5 text-xs text-ink-muted">{interpolate(t('money.addLimit'), { max: formatNumber(maxAmount) })}</p>
        </div>

        {!amountValid && (
          <div>
            <StepLabel step={2}>{t('money.payStepEmpty')}</StepLabel>
            <p className="rounded-control border border-dashed border-surface-strong px-4 py-3 text-sm text-ink-muted">{t('money.payStepHint')}</p>
          </div>
        )}
        {amountValid && (
          <div className="space-y-3 animate-fade-in">
            <StepLabel step={2}>{interpolate(t('money.payStep'), { amount: formatNumber(amountValue) })}</StepLabel>
            <div className="space-y-3 rounded-control border border-brand-900 bg-brand-950/20 p-4">
              <div className="mx-auto w-fit rounded-lg bg-white p-3">
                <QRCodeSVG value={upiLink(amountValue)} size={160} level="M" />
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-page/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs text-ink-muted">{t('money.sendTo')}</p>
                  <p className="truncate font-mono text-sm font-medium text-brand-300">{merchantUpiId}</p>
                </div>
                <Button variant="secondary" onClick={() => void copyUpiId()} icon={copied ? <Check className="h-4 w-4 text-brand-400" /> : <Copy className="h-4 w-4" />}>
                  {copied ? t('money.copied') : t('money.copy')}
                </Button>
              </div>
              <p className="flex items-center gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                {interpolate(t('money.payExactly'), { amount: formatNumber(amountValue), name: merchantName })}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {([['phonepe', 'PhonePe', 'bg-violet-600/90 hover:bg-violet-500'], ['gpay', 'Google Pay', 'bg-blue-600/90 hover:bg-blue-500'], ['paytm', 'Paytm', 'bg-sky-700/90 hover:bg-sky-600'], ['bhim', t('money.otherApp'), 'bg-brand-600/90 hover:bg-brand-500']] as const).map(([app, label, color]) => (
                  <a key={app} href={appLink(amountValue, app)} className={`flex min-h-tap items-center justify-center gap-1.5 rounded-control text-sm font-semibold text-white ${color}`}>
                    <Smartphone className="h-4 w-4" aria-hidden="true" /> {label}
                  </a>
                ))}
              </div>
              <p className="text-center text-xs text-ink-muted">{t('money.appNotOpening')}</p>
            </div>
          </div>
        )}

        <div>
          <StepLabel step={3} required>{t('money.screenshot')}</StepLabel>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleScreenshotSelect} className="hidden" aria-label={t('money.screenshot')} />
          {screenshotPreview ? (
            <div className="relative overflow-hidden rounded-control border border-surface-strong">
              <img src={screenshotPreview} alt={t('money.screenshot')} className="max-h-48 w-full object-cover" />
              <button
                type="button"
                aria-label={t('money.removeScreenshot')}
                onClick={() => { setScreenshotFile(null); setScreenshotPreview(null); setError(null); }}
                className="tap-target absolute right-2 top-2 rounded-full bg-surface-page/80 text-ink-soft hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-lg bg-brand-500/90 px-2 py-1 text-xs font-medium text-white">
                <Check className="h-3 w-3" aria-hidden="true" /> {t('money.screenshotAdded')}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-control border-2 border-dashed border-surface-strong py-6 text-ink-muted transition-colors hover:border-brand-700 hover:text-ink-soft"
            >
              <Upload className="h-5 w-5" aria-hidden="true" />
              <span className="text-sm">{t('money.tapToAdd')}</span>
            </button>
          )}
        </div>

        <div>
          <StepLabel step={4} htmlFor="add-funds-reference" required>{t('money.utr')}</StepLabel>
          <input
            id="add-funds-reference"
            type="text" value={utr}
            onChange={(event) => { setUtr(event.target.value); setError(null); }}
            placeholder="e.g. 412345678901"
            className={INPUT}
          />
          <p className="mt-1.5 text-xs text-ink-muted">{t('money.utrHelp')}</p>
        </div>

        {error && <Alert details={error.raw}>{error.text}</Alert>}

        <Button size="lg" fullWidth loading={submitting} disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {t('money.sendForChecking')}
        </Button>
      </Card>
    </div>
  );
}
