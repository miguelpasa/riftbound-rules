/**
 * Effect interpreter (R1, slice 1). Mutates the working state (caller's clone) and returns events.
 * Rule 359.3 (a spell's effects happen as it resolves, then it goes to the Trash).
 */
import { drawWithBurnOut } from './burnout.js';
import { playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  CardEffect,
  GameEventInput,
  GameState,
  PlayerId,
} from './types/index.js';

export function runEffects(
  state: GameState,
  controller: PlayerId,
  effects: readonly CardEffect[],
  cards: CardDatabase,
): GameEventInput[] {
  const out: GameEventInput[] = [];
  for (const e of effects) {
    if (state.gameStatus !== 'IN_PROGRESS') break;
    switch (e.op) {
      case 'DRAW':
        out.push(...drawWithBurnOut(state, controller, e.amount, cards));
        break;
      case 'GAIN_POINT':
        state.players[playerIndex(controller)].points += e.amount;
        out.push({ type: 'POINT_GAINED', player: controller, amount: e.amount, source: 'EFFECT' });
        break;
    }
  }
  return out;
}
