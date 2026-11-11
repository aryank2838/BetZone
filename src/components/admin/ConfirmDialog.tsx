import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useDialogA11y } from '@/lib/useDialogA11y';
import type { ConfirmationContent } from './confirmations';

interface ConfirmDialogProps {
  content: ConfirmationContent;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal confirmation for high-risk admin actions. Escape cancels; focus returns to the trigger. */
export default function ConfirmDialog({ content, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [content.title, content.requiredText]);
  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  useDialogA11y(true, dialogRef, cancel);
  const typedOk = !content.requiredText || typed.trim() === content.requiredText;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" onClick={cancel}>
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="text-lg font-bold">{content.title}</h3>
        <dl className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm">
          {content.rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-slate-400">{label}</dt>
              <dd className="break-all text-right font-medium text-white">{value}</dd>
            </div>
          ))}
        </dl>
        {content.warning && <p className={`text-sm ${content.danger ? 'text-rose-300' : 'text-amber-200'}`}>{content.warning}</p>}
        {content.requiredText && (
          <label className="block text-xs text-slate-300">
            Type <strong className="text-white">{content.requiredText}</strong> to confirm
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-white"
            />
          </label>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={cancel} disabled={busy} className="flex-1 rounded-lg border border-slate-700 py-2.5 text-sm text-slate-300">Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !typedOk}
            className={`flex-1 rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-40 ${content.danger ? 'bg-rose-700 hover:bg-rose-600' : 'bg-emerald-600 hover:bg-emerald-500'}`}
          >
            {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : content.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
