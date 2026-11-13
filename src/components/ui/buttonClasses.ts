export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'admin';
export type ButtonSize = 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-500 shadow-lg shadow-brand-500/10',
  secondary: 'border border-surface-strong bg-surface-raised text-ink-soft hover:bg-slate-700 hover:text-ink-strong',
  ghost: 'text-ink-soft hover:bg-surface-raised hover:text-ink-strong',
  danger: 'border border-rose-900 bg-rose-950/40 text-rose-200 hover:bg-rose-950',
  admin: 'bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-lg shadow-amber-500/10',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-tap px-4 py-2 text-sm',
  lg: 'min-h-[48px] px-5 py-3 text-sm',
};

export function buttonClasses({ variant = 'primary', size = 'md', fullWidth = false, className = '' }: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}) {
  return [
    'inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-40',
    VARIANTS[variant],
    SIZES[size],
    fullWidth ? 'w-full' : '',
    className,
  ].filter(Boolean).join(' ');
}
