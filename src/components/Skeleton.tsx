export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-shimmer rounded-lg bg-slate-800/80 ${className}`} />;
}

export function CardSkeleton() {
  return (
    <div role="status" aria-label="Loading content" className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-8 w-3/5" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-label="Loading list" className="space-y-3" role="status">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <Skeleton className="mb-3 h-4 w-1/3" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}
