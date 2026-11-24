import { describe, expect, it } from 'vitest';
import { findNewResults, resultSignature } from './resultReveal';

const now = Date.parse('2026-11-24T12:00:00Z');
const result = (game: string, open: string | null, close: string | null, postedMinutesAgo = 5) => ({
  game: game as 'test',
  round_date: '2026-11-24',
  open_digit: open,
  close_digit: close,
  open_posted_at: open ? new Date(now - postedMinutesAgo * 60000).toISOString() : null,
  close_posted_at: close ? new Date(now - postedMinutesAgo * 60000).toISOString() : null,
});

describe('findNewResults', () => {
  it('only remembers games seen for the first time', () => {
    const { fresh, next } = findNewResults([result('test', '4', null)], {}, now);
    expect(fresh).toEqual([]);
    expect(next.test).toBe('2026-11-24|4|');
  });

  it('reveals a result that changed since last seen', () => {
    const before = result('test', '4', null);
    const after = result('test', '4', '7');
    const { fresh } = findNewResults([after], { test: resultSignature(before) }, now);
    expect(fresh).toEqual(['test']);
  });

  it('does not reveal an unchanged result, a new empty round, or an old result', () => {
    const same = result('test', '4', '7');
    expect(findNewResults([same], { test: resultSignature(same) }, now).fresh).toEqual([]);
    expect(findNewResults([result('test', null, null)], { test: '2026-11-23|1|2' }, now).fresh).toEqual([]);
    expect(findNewResults([result('test', '4', null, 13 * 60)], { test: '2026-11-23|1|2' }, now).fresh).toEqual([]);
  });
});
