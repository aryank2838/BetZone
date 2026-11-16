import type { BetType, GameStatus } from '@/types';
import { isCloseBet } from '@/types';

export type PickStatus = 'pending' | 'won' | 'lost';

export interface BoardPick {
  number: string;
  stake: number;
  status: PickStatus;
  payout: number;
}

export interface BoardSlip {
  id: string;
  user_id: string;
  user_name: string | null;
  bet_type: BetType;
  total_points: number;
  updated_at: string;
  picks: BoardPick[];
}

export interface BoardResult {
  open_patti: string | null;
  open_digit: string | null;
  close_patti: string | null;
  close_digit: string | null;
  open_paid: boolean;
  close_paid: boolean;
}

export interface BetsBoard {
  result: BoardResult | null;
  slips: BoardSlip[];
}

/** Bet types in the order the admin reads them. */
export const BET_TYPE_ORDER: BetType[] = ['single_open', 'patti_open', 'jodi', 'single_close', 'patti_close'];

/** Open single and open patti are paid with the open result; everything else with the close result. */
export const settlesWithOpen = (betType: BetType) => betType === 'single_open' || betType === 'patti_open';

/** 'live': betting still open; 'waiting': closed, result not paid yet; 'settled': paid. */
export type GroupStatus = 'live' | 'waiting' | 'settled';

export function groupStatus(betType: BetType, result: BoardResult | null, status: GameStatus | undefined, roundDate: string): GroupStatus {
  const paid = settlesWithOpen(betType) ? result?.open_paid : result?.close_paid;
  if (paid) return 'settled';
  const today = status?.server_ist_date === roundDate;
  const open = isCloseBet(betType) ? status?.close_bets_open : status?.open_bets_open;
  return today && open ? 'live' : 'waiting';
}

export type SlipStatus = PickStatus;

/** Won if any number won, lost if all numbers are settled and none won, otherwise pending. */
export function slipStatus(slip: BoardSlip): SlipStatus {
  if (slip.picks.some((pick) => pick.status === 'won')) return 'won';
  if (slip.picks.length > 0 && slip.picks.every((pick) => pick.status === 'lost')) return 'lost';
  return 'pending';
}

export const slipPayout = (slip: BoardSlip) => slip.picks.reduce((sum, pick) => sum + pick.payout, 0);

export interface BoardSummary {
  staked: number;
  players: number;
  slips: number;
  pendingStake: number;
  settledStake: number;
  paidOut: number;
  /** House result on the settled part: settled stakes minus payouts. */
  profit: number;
}

export function boardSummary(slips: BoardSlip[]): BoardSummary {
  let staked = 0;
  let pendingStake = 0;
  let settledStake = 0;
  let paidOut = 0;
  for (const slip of slips) {
    for (const pick of slip.picks) {
      staked += pick.stake;
      if (pick.status === 'pending') pendingStake += pick.stake;
      else settledStake += pick.stake;
      paidOut += pick.payout;
    }
  }
  return {
    staked,
    players: new Set(slips.map((slip) => slip.user_id)).size,
    slips: slips.length,
    pendingStake,
    settledStake,
    paidOut,
    profit: settledStake - paidOut,
  };
}

export type BoardFilter = 'all' | 'live' | 'waiting' | 'won' | 'lost';

/** Which filter chips a slip belongs to (besides 'all'). */
export function slipFilter(slip: BoardSlip, group: GroupStatus): Exclude<BoardFilter, 'all'> {
  if (group === 'live') return 'live';
  const status = slipStatus(slip);
  return status === 'pending' ? 'waiting' : status;
}
