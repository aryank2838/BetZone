import type { GameResult } from '@/types';

type ResultLike = Pick<GameResult, 'open_patti' | 'open_digit' | 'close_digit' | 'close_patti'>;

/** Patti - jodi - patti, e.g. "123 - 68 - 459", with the open digit green and close digit cyan. */
export default function ResultNumbers({ result, size = 'md' }: { result: ResultLike; size?: 'md' | 'lg' }) {
  const big = size === 'lg' ? 'text-4xl' : 'text-3xl';
  const small = size === 'lg' ? 'text-2xl' : 'text-lg';
  return (
    <div className="flex items-center justify-center gap-2 py-2 tabular-nums sm:gap-3">
      {result.open_patti && <span className={`${small} font-bold text-ink-soft`}>{result.open_patti}</span>}
      {result.open_patti && <span className="text-xl text-ink-muted" aria-hidden="true">-</span>}
      <span className={`${big} font-extrabold tracking-tight`}>
        {result.open_digit ? <span className="text-brand-400">{result.open_digit}</span> : <span className="text-ink-muted">*</span>}
        {result.close_digit ? <span className="text-accent-400">{result.close_digit}</span> : <span className="text-ink-muted">*</span>}
      </span>
      {result.close_patti && <span className="text-xl text-ink-muted" aria-hidden="true">-</span>}
      {result.close_patti && <span className={`${small} font-bold text-ink-soft`}>{result.close_patti}</span>}
    </div>
  );
}
