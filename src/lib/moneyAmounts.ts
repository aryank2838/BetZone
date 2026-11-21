/** Preset amounts for one-tap entry, keeping only those inside [min, max]. */
export function quickAmounts(presets: number[], max: number, min = 1): number[] {
  return presets.filter((value) => value >= min && value <= max);
}

/** "5 minutes ago", "2 hours ago", "yesterday" in the app's language. */
export function timeAgo(iso: string, nowMs: number, locale: string): string {
  const seconds = Math.round((Date.parse(iso) - nowMs) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, 'minute');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}

/** Share of the betting requirement already met, 0-100. */
export function turnoverProgress(wagered: number, remaining: number): number {
  const total = wagered + remaining;
  if (total <= 0 || remaining <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((wagered / total) * 100)));
}
