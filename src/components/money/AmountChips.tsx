import { useFormat } from '@/i18n/useFormat';
import { useT } from '@/i18n/useT';

/** One-tap amounts under an amount field. `maxLabel` adds a final "Max ₹X" chip. */
export default function AmountChips({ amounts, selected, onPick, max }: {
  amounts: number[];
  selected: number;
  onPick: (value: number) => void;
  /** Adds a "Max" chip for this amount (e.g. everything withdrawable). */
  max?: number;
}) {
  const { formatNumber } = useFormat();
  const { t } = useT();
  const items = amounts.filter((value) => value !== max);
  if (items.length === 0 && !max) return null;
  const chip = (active: boolean) => `min-h-[40px] rounded-full border px-3.5 text-sm font-semibold tabular-nums transition-colors ${
    active ? 'border-brand-400 bg-brand-950 text-brand-200' : 'border-surface-strong text-ink-soft hover:bg-surface-raised'
  }`;
  return (
    <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t('money.quickAmounts')}>
      {items.map((value) => (
        <button key={value} type="button" aria-pressed={selected === value} onClick={() => onPick(value)} className={chip(selected === value)}>
          ₹{formatNumber(value)}
        </button>
      ))}
      {max !== undefined && max > 0 && (
        <button type="button" aria-pressed={selected === max} onClick={() => onPick(max)} className={chip(selected === max)}>
          {t('money.max')} · ₹{formatNumber(max)}
        </button>
      )}
    </div>
  );
}
