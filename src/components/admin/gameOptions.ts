import type { Game } from '@/types';

/** A configured game as the admin UI lists it (built from get_game_status). */
export interface AdminGameOption {
  game: Game;
  label: string;
}
