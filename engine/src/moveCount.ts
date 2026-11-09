import type { CardDatabase, CardInstance, GameState } from './types/index.js';

/**
 * "The third time I move in a turn" (Yasuo) and "If I have moved twice this turn" (Kayn): a move to a battlefield
 * is counted on the unit, only for cards whose text needs the count (so other games keep their exact state).
 * MUTATES the working state's object.
 */
export function countMove(state: GameState, cards: CardDatabase, o: CardInstance): void {
  const def = cards[o.cardId];
  const counts =
    def?.triggers?.some((t) => t.moveNth !== undefined) === true ||
    def?.statics?.some((s) => s.when?.kind === 'MOVES_AT_LEAST') === true;
  if (!counts) return;
  const same = o.moves?.turn === state.turn.number;
  o.moves = { turn: state.turn.number, n: (same ? (o.moves?.n ?? 0) : 0) + 1 };
}
