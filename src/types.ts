export type Game = 'test' | 'test2' | 'test3' | 'test4';

export const GAME_LABELS: Record<Game, string> = { test: 'Kalyan', test2: 'Main Bazaar', test3: 'Milan Day', test4: 'Milan Night' };

export interface BetTypeInfo {
  label: string;
  shortLabel: string;
  multiplier: number;
  placeholder: string;
  maxLength: number;
  inputType: 'digit' | 'jodi' | 'patti_combo';
  description: string;
}

export const BET_TYPES = {
  single_open: {
    label: 'Single Open',
    shortLabel: 'Open',
    multiplier: 9,
    placeholder: '0-9',
    maxLength: 1,
    inputType: 'digit',
    description: 'Pick the open digit. Win 9x your bet.',
  },
  single_close: {
    label: 'Single Close',
    shortLabel: 'Close',
    multiplier: 9,
    placeholder: '0-9',
    maxLength: 1,
    inputType: 'digit',
    description: 'Pick the close digit. Win 9x your bet.',
  },
  jodi: {
    label: 'Jodi',
    shortLabel: 'Jodi',
    multiplier: 90,
    placeholder: '00-99',
    maxLength: 2,
    inputType: 'jodi',
    description: 'Pick a 2-digit number (open+close). Win 90x your bet.',
  },
  patti_open: {
    label: 'Patti Open',
    shortLabel: 'Open Patti',
    multiplier: 120,
    placeholder: 'e.g. 123-6',
    maxLength: 5,
    inputType: 'patti_combo',
    description: 'Pick the exact open patti + digit combo (e.g. 123-6). Win 120x if both match.',
  },
  patti_close: {
    label: 'Patti Close',
    shortLabel: 'Close Patti',
    multiplier: 120,
    placeholder: 'e.g. 135-9',
    maxLength: 5,
    inputType: 'patti_combo',
    description: 'Pick the exact close patti + digit combo (e.g. 135-9). Win 120x if both match.',
  },
} satisfies Record<string, BetTypeInfo>;

export type BetType = keyof typeof BET_TYPES;

export interface SelectionEntry {
  number: string;
  points: number;
}

export interface Profile {
  id: string;
  display_name: string;
  points: number;
  wallet: number;
  is_admin: boolean;
  is_banned: boolean;
  created_at: string;
  terms_accepted_at?: string | null;
  terms_version?: string | null;
  age_confirmed?: boolean;
}

export interface SavedSelection {
  id: string;
  game: Game;
  round_date: string;
  bet_type: BetType;
  selections: SelectionEntry[];
  total_points: number;
  updated_at: string;
}

export interface GameResult {
  game: Game;
  round_date: string;
  open_digit: string | null;
  close_digit: string | null;
  open_patti: string | null;
  close_patti: string | null;
  open_posted_at: string | null;
  close_posted_at: string | null;
  open_processed: boolean;
  close_processed: boolean;
}

export interface GameStatus {
  game: Game;
  label: string;
  round_date: string;
  open_bets_open: boolean;
  close_bets_open: boolean;
  bets_open_at: string;
  open_bets_close_at: string;
  close_bets_close_at: string;
  server_now: string;
  open_bets_close_ts: string;
  close_bets_close_ts: string;
  open_result_at: string;
  close_result_at: string;
  server_ist_date: string;
  server_ist_time: string;
  close_result_next_day: boolean;
  on_holiday?: boolean;
  holiday_reopens_on?: string | null;
  holiday_note?: string | null;
  /** Weekly days off as ISO weekdays: 1 = Monday ... 7 = Sunday. */
  closed_weekdays?: number[];
  /** Today (IST) is one of the game's weekly days off. */
  day_off?: boolean;
  /** Next date the game takes bets again, when today is a day off. */
  day_off_reopens_on?: string | null;
}

export const isCloseBet = (betType: BetType) =>
  betType === 'single_close' || betType === 'patti_close';

const rank = (character: string) => character === '0' ? 10 : Number(character);

export function isValidPatti(patti: string): boolean {
  if (!/^[0-9]{3}$/.test(patti)) return false;
  const [a, b, c] = [...patti].map(rank);
  return a <= b && b <= c;
}

export const pattiDigit = (patti: string) =>
  [...patti].reduce((sum, character) => sum + Number(character), 0) % 10;

export function isValidPattiCombo(value: string): boolean {
  const match = /^([0-9]{3})-([0-9])$/.exec(value);
  return !!match && isValidPatti(match[1]) && pattiDigit(match[1]) === Number(match[2]);
}
