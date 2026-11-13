import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { CheckCircle2, Settings as SettingsIcon } from 'lucide-react';
import { ListSkeleton } from '@/components/Skeleton';
import { lastChangedText } from './settingsMeta';

export type { AdminSettingRow } from './settingsMeta';
import type { AdminSettingRow } from './settingsMeta';

interface SettingsTabProps {
  upiId: string;
  merchantName: string;
  approvalTimeNote: string;
  supportWhatsApp: string;
  supportEmail: string;
  maxUserRoundBalance: string;
  maxNumberLiability: string;
  loading: boolean;
  saving: boolean;
  message: { kind: 'ok' | 'err'; text: string; raw?: string } | null;
  meta: Record<string, AdminSettingRow>;
  onUpiIdChange: (value: string) => void;
  onMerchantNameChange: (value: string) => void;
  onApprovalTimeNoteChange: (value: string) => void;
  onSupportWhatsAppChange: (value: string) => void;
  onSupportEmailChange: (value: string) => void;
  onMaxUserRoundBalanceChange: (value: string) => void;
  onMaxNumberLiabilityChange: (value: string) => void;
  onSave: (key: string, value: string) => void;
}

const inputClass = 'flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-surface-raised border border-surface-strong text-ink-strong text-sm focus:border-emerald-400 focus:ring-0 focus:outline-none';
const saveClass = 'tap-target px-4 py-2.5 rounded-lg bg-emerald-600 text-ink-strong text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors whitespace-nowrap';

function SettingField({ settingKey, label, value, help, meta, saving, onChange, onSave, inputProps }: {
  settingKey: string;
  label: string;
  value: string;
  help?: ReactNode;
  meta: Record<string, AdminSettingRow>;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: (key: string, value: string) => void;
  inputProps?: InputHTMLAttributes<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-ink-muted mb-1.5">{label}</label>
      <div className="flex gap-2">
        <input id={id} type="text" value={value} onChange={(event) => onChange(event.target.value)} className={inputClass} {...inputProps} />
        <button type="button" onClick={() => onSave(settingKey, value)} disabled={saving} className={saveClass} aria-label={`Save ${label}`}>Save</button>
      </div>
      {help && <p className="text-xs text-ink-muted mt-1.5">{help}</p>}
      <p className="text-xs text-ink-muted mt-1" data-testid={`setting-meta-${settingKey}`}>{lastChangedText(meta[settingKey])}</p>
    </div>
  );
}

export default function SettingsTab(props: SettingsTabProps) {
  const {
    upiId, merchantName, approvalTimeNote, supportWhatsApp, supportEmail, maxUserRoundBalance, maxNumberLiability,
    loading, saving, message, meta, onUpiIdChange, onMerchantNameChange,
    onApprovalTimeNoteChange, onSupportWhatsAppChange, onSupportEmailChange, onMaxUserRoundBalanceChange, onMaxNumberLiabilityChange, onSave,
  } = props;
  const shared = { meta, saving, onSave };

  return (
    <section className="space-y-4 animate-fade-in">
      <div className="border border-surface-border rounded-card bg-surface/80 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-amber-400" />
          <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wide">Payment Settings</h3>
        </div>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : (
          <>
            <SettingField {...shared} settingKey="merchant_upi_id" label="Merchant UPI ID" value={upiId} onChange={onUpiIdChange}
              help="This is the UPI ID users will pay when adding funds. Changing it asks for confirmation."
              inputProps={{ placeholder: 'e.g. yourname@okaxis', autoComplete: 'off' }} />
            <SettingField {...shared} settingKey="merchant_name" label="Merchant Name" value={merchantName} onChange={onMerchantNameChange}
              help="Shown as the payee name in the UPI payment app." inputProps={{ placeholder: 'e.g. BetZone' }} />
            <SettingField {...shared} settingKey="approval_time_note" label="Expected approval note" value={approvalTimeNote} onChange={onApprovalTimeNoteChange}
              help="Shown beside deposit and withdrawal forms; leave blank and save to remove it."
              inputProps={{ maxLength: 120, placeholder: 'e.g. Usually approved within 30 minutes, 8 AM–10 PM' }} />
            <SettingField {...shared} settingKey="support_whatsapp" label="Support WhatsApp (international format)" value={supportWhatsApp} onChange={onSupportWhatsAppChange}
              inputProps={{ placeholder: '+919876543210', inputMode: 'tel' }} />
            <SettingField {...shared} settingKey="support_email" label="Support email" value={supportEmail} onChange={onSupportEmailChange}
              inputProps={{ type: 'email', placeholder: 'support@example.com' }} />
            <div className="border-t border-surface-border pt-4 space-y-4">
              <h4 className="text-xs font-medium text-ink-muted uppercase tracking-wide">Betting Exposure Limits</h4>
              <SettingField {...shared} settingKey="max_user_round_points" label="Maximum user stake per game round (balance)" value={maxUserRoundBalance}
                onChange={onMaxUserRoundBalanceChange} help="Default: 50,000 balance across all bet types for the round."
                inputProps={{ inputMode: 'numeric' }} />
              <SettingField {...shared} settingKey="max_number_liability" label="Maximum potential payout per number (balance)" value={maxNumberLiability}
                onChange={onMaxNumberLiabilityChange} help="Default: 1,000,000 balance per game, round, bet type and number."
                inputProps={{ inputMode: 'numeric' }} />
            </div>
          </>
        )}
        {message && (
          <div role={message.kind === 'err' ? 'alert' : 'status'} className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2.5 ${message.kind === 'ok' ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-900' : 'text-rose-400 bg-rose-950/40 border border-rose-900'}`}>
            {message.kind === 'ok' && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <div>
              <p>{message.text}</p>
              {message.raw && <p className="mt-1 text-xs text-rose-400/70">{message.raw}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
