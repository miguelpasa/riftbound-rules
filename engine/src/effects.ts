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
  Target,
} from './types/index.js';

export function runEffects(
  state: GameState,
  controller: PlayerId,
  effects: readonly CardEffect[],
  cards: CardDatabase,
  targets: readonly Target[] = [],
  sourceCardId = '',
): GameEventInput[] {
  const out: GameEventInput[] = [];
  for (const e of effects) {
    if (state.gameStatus !== 'IN_PROGRESS') break;
    switch (e.op) {
      case 'DRAW':
        out.push(...drawWithBurnOut(state, controller, e.amount, cards));
        break;
      case 'DAMAGE_TARGET':
      case 'BUFF_TARGET': {
        // Target must still be a unit on the board; otherwise the effect fizzles (no-op).
        const t = targets.find((x) => x.kind === 'object');
        const u = t?.kind === 'object' ? state.objects[t.id] : undefined;
        const onBoard = u && (u.zone.kind === 'base' || u.zone.kind === 'battlefield');
        if (!u || !onBoard || cards[u.cardId]?.type !== 'UNIT') {
          out.push({ type: 'EFFECT_FIZZLED', cardId: sourceCardId });
          break;
        }
        if (e.op === 'DAMAGE_TARGET') {
          u.damage += e.amount;
          out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: e.amount });
        } else {
          u.mightBonus += e.amount;
          out.push({ type: 'EFFECT_BUFF', unitId: u.id, amount: e.amount });
        }
        break;
      }
      case 'GAIN_POINT':
        state.players[playerIndex(controller)].points += e.amount;
        out.push({ type: 'POINT_GAINED', player: controller, amount: e.amount, source: 'EFFECT' });
        break;
    }
  }
  return out;
}
