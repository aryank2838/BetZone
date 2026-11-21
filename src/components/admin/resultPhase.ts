/** The posted numbers for one game and round date (null = nothing posted yet). */
export interface RoundResult {
  round_date: string;
  open_patti: string | null;
  open_digit: string | null;
  close_patti: string | null;
  close_digit: string | null;
}

export type PhaseState = 'loading' | 'posted' | 'locked' | 'ready';

/**
 * What the Results tab shows for a phase:
 * - posted: the result is in, so show it instead of the form (no double posting);
 * - locked: close waits for the open result, the same rule the server applies;
 * - ready: show the form.
 * `undefined` means the round is still loading; the form stays hidden until then.
 */
export function phaseState(round: RoundResult | null | undefined, phase: 'open' | 'close'): PhaseState {
  if (round === undefined) return 'loading';
  const posted = phase === 'open' ? round?.open_digit : round?.close_digit;
  if (posted) return 'posted';
  if (phase === 'close' && !round?.open_digit) return 'locked';
  return 'ready';
}
