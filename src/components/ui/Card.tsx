import type { HTMLAttributes, ReactNode } from 'react';

export function Card({ className = '', children, ...rest }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section className={`rounded-card border border-surface-border bg-surface/80 p-5 ${className}`} {...rest}>
      {children}
    </section>
  );
}

/** Small uppercase label above a group of content. */
export function SectionTitle({ children, icon, action, id }: {
  children: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 id={id} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        {icon}
        {children}
      </h2>
      {action}
    </div>
  );
}
