import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { ToastContext, type ToastTone } from './toastContext';
import { useT } from '@/i18n/useT';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const DURATION_MS = 4500;

const STYLES: Record<ToastTone, { box: string; icon: ReactNode }> = {
  success: { box: 'border-brand-800 bg-brand-950 text-brand-100', icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-400" aria-hidden="true" /> },
  error: { box: 'border-rose-900 bg-rose-950 text-rose-100', icon: <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" /> },
  info: { box: 'border-surface-strong bg-surface-raised text-ink', icon: <Info className="h-4 w-4 shrink-0 text-accent-400" aria-hidden="true" /> },
};

export default function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = ++nextId.current;
    // Keep at most three on screen.
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    timers.current.set(id, window.setTimeout(() => dismiss(id), DURATION_MS));
  }, [dismiss]);

  useEffect(() => {
    const active = timers.current;
    return () => { active.forEach((timer) => window.clearTimeout(timer)); };
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[85] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-control border px-4 py-3 text-sm shadow-2xl animate-slide-up ${STYLES[toast.tone].box}`}
          >
            {STYLES[toast.tone].icon}
            <p className="flex-1">{toast.message}</p>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label={t('common.close')} className="-m-1 rounded p-1 opacity-70 hover:opacity-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
