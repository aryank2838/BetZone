import { Gem, Moon, Store, Sun, Dices, type LucideIcon } from 'lucide-react';
import type { Game } from '@/types';

/** Each game's own colour and icon on the home screen, so players spot their game at a glance. */
export interface GameLook {
  /** Hex colour, so alpha suffixes like `${color}33` work in inline styles. */
  color: string;
  Icon: LucideIcon;
}

const LOOKS: Record<Game, GameLook> = {
  test: { color: '#eab308', Icon: Gem },     // Kalyan: gold
  test2: { color: '#e879f9', Icon: Store },  // Main Bazaar: pink
  test3: { color: '#fb7a45', Icon: Sun },    // Milan Day: orange
  test4: { color: '#818cf8', Icon: Moon },   // Milan Night: indigo
};

const FALLBACK: GameLook = { color: '#94a3b8', Icon: Dices };

export function gameLook(game: string): GameLook {
  return LOOKS[game as Game] ?? FALLBACK;
}
