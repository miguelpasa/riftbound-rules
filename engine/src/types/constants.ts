import type { PlayerId } from './state.js';

/** Points needed to win a Duel (Rule 473.1). */
export const VICTORY_SCORE = 8;
/** Opening hand size (Rule 117). */
export const HAND_SIZE = 4;
/** Max cards a player may set aside when mulliganing (Rule 117). */
export const MAX_MULLIGAN = 2;
/** Runes channeled per Channel Phase. */
export const RUNES_PER_CHANNEL = 2;
/** Extra rune the second player channels on their first Channel Phase. */
export const SECOND_PLAYER_EXTRA_FIRST_CHANNEL = 1;
/** Safety cap on Cleanup loop iterations; exceeding it aborts the game. */
export const MAX_CLEANUP_ITERATIONS = 25;
/** Deck construction limits. */
export const MIN_MAIN_DECK = 40;
export const MAX_COPIES = 3;
export const RUNE_DECK_SIZE = 12;

export const PLAYER_IDS: readonly ['p0', 'p1'] = ['p0', 'p1'];

/** The other player in a 1v1 Duel. */
export function opponentOf(p: PlayerId): PlayerId {
  return p === 'p0' ? 'p1' : 'p0';
}

/** Index of a player in GameState.players. */
export function playerIndex(p: PlayerId): 0 | 1 {
  return p === 'p0' ? 0 : 1;
}
