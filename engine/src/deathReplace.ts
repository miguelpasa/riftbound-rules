import { removeTokenFromGame } from './keywords.js';
import { playerIndex } from './types/constants.js';
import type { CardDatabase, CardInstance, GameEventInput, GameState } from './types/index.js';
import { clearBoardState } from './zoneReset.js';

/**
 * X7 (573, 575): a one-shot "the next time it would die this turn ... instead" replacement. RECALL heals,
 * exhausts and sends the unit to its controller's Base (a recall is not a move: no UNIT_MOVED, no move
 * triggers); BANISH exiles it (a token ceases to exist). The unit never dies, so no death trigger fires.
 * MUTATES the working state.
 */
export function replaceDeath(
  state: GameState,
  cards: CardDatabase,
  o: CardInstance,
): GameEventInput {
  const mode = o.deathReplace as 'RECALL' | 'BANISH';
  const event = { type: 'UNIT_DEATH_REPLACED' as const, unitId: o.id, cardId: o.cardId, mode };
  delete o.deathReplace;
  if (mode === 'RECALL') {
    o.damage = 0;
    o.ready = false;
    if (o.zone.kind === 'battlefield') {
      o.zone = { kind: 'base', player: o.controller };
      state.players[playerIndex(o.controller)].base.push(o.id);
    }
    return event;
  }
  const ps = state.players[playerIndex(o.controller)];
  ps.base = ps.base.filter((x) => x !== o.id);
  if (cards[o.cardId]?.type === 'TOKEN') {
    removeTokenFromGame(state, o.id);
  } else {
    const owner = state.players[playerIndex(o.owner)];
    owner.banishment.push(o.id);
    o.zone = { kind: 'banishment', player: o.owner };
    o.controller = o.owner;
    clearBoardState(o);
    for (const g of Object.values(state.objects)) {
      if (g.attachedTo === o.id) delete g.attachedTo;
    }
  }
  return event;
}
