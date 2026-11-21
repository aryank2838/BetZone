import { describe, expect, it } from 'vitest';
import { quickAmounts, timeAgo, turnoverProgress } from './moneyAmounts';

describe('money helpers', () => {
  it('keeps only quick amounts the player can actually use', () => {
    expect(quickAmounts([100, 500, 1000, 2000], 1000)).toEqual([100, 500, 1000]);
    expect(quickAmounts([100, 500, 1000], 5000, 200)).toEqual([500, 1000]);
  });

  it('says how long ago a request was sent', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    expect(timeAgo('2026-11-21T11:59:40Z', now, 'en-IN')).toBe('this minute');
    expect(timeAgo('2026-11-21T11:48:00Z', now, 'en-IN')).toBe('12 minutes ago');
    expect(timeAgo('2026-11-21T09:00:00Z', now, 'en-IN')).toBe('3 hours ago');
  });

  it('measures progress towards the betting requirement', () => {
    expect(turnoverProgress(300, 700)).toBe(30);
    expect(turnoverProgress(0, 500)).toBe(0);
    expect(turnoverProgress(500, 0)).toBe(100);
  });
});
