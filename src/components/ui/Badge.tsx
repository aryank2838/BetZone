import type { ReactNode } from 'react';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  success: 'border-brand-800 bg-brand-950 text-brand-300',
  warning: 'border-amber-800 bg-amber-950 text-amber-300',
  danger: 'border-rose-900 bg-rose-950 text-rose-300',
  info: 'border-accent-800 bg-accent-950 text-accent-300',
  neutral: 'border-surface-strong bg-surface-raised text-ink-soft',
};

export default function Badge({ tone = 'neutral', icon, children, className = '' }: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]} ${className}`}>
      {icon}
      {children}
    </span>
  );
}
