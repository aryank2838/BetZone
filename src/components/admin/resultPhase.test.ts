import { describe, expect, it } from 'vitest';
import { phaseState, type RoundResult } from './resultPhase';

const round = (open: string | null, close: string | null): RoundResult => ({
  round_date: '2026-11-21', open_patti: open ? '123' : null, open_digit: open, close_patti: close ? '456' : null, close_digit: close,
});

describe('phaseState', () => {
  it('keeps both forms hidden while the round is loading', () => {
    expect(phaseState(undefined, 'open')).toBe('loading');
    expect(phaseState(undefined, 'close')).toBe('loading');
  });

  it('shows the open form and locks close when nothing is posted', () => {
    expect(phaseState(null, 'open')).toBe('ready');
    expect(phaseState(null, 'close')).toBe('locked');
  });

  it('replaces the open form with the result once posted, and opens close', () => {
    expect(phaseState(round('6', null), 'open')).toBe('posted');
    expect(phaseState(round('6', null), 'close')).toBe('ready');
  });

  it('shows both as posted when the round is done', () => {
    expect(phaseState(round('6', '5'), 'open')).toBe('posted');
    expect(phaseState(round('6', '5'), 'close')).toBe('posted');
  });
});
