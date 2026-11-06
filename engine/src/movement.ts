/**
 * Standard Move (Core Rules 144, 447-455).
 *
 * Pure: structuredClone the input, mutate the clone, return a ReduceResult.
 *
 * Decisions:
 *  - Check order: game over, turn player (307), Showdown/Combat (144.1.c), Closed state (144.1.b),
 *    MAIN phase (144.1.a), Priority, then the units, then the destination.
 *  - Moving exhausts each unit as the cost (144.2): units must be ready (UNIT_EXHAUSTED).
 *  - Several units may move together (144.3.a) from any mix of origins, to one destination.
 *  - Base -> Battlefield (144.4.a), Battlefield -> own Base (144.4.b), Battlefield -> Battlefield
 *    only with Ganking (144.4.c.1). Base -> Base and staying put are illegal.
 *  - A move to a Battlefield the mover does not control (enemy-controlled or uncontrolled) marks it
 *    Contested by the mover (190.3, 452); the mark persists until control is established (190.3.b).
 *  - This module never runs Cleanup nor starts Showdowns; the cleanup loop does that (323.7, 455).
 *  - UNIT_MOVED `from` / `to` are 'base' or a battlefield id.
 */
import { fork } from './workingCopy.js';
import { defWithGrants } from './statics.js';
import { ruleError } from './types/errors.js';
import { playerIndex } from './types/constants.js';
import { stampEvents } from './setup.js';
import { isUnitDef } from './tokens.js';
import type {
  CardDatabase,
  CardInstance,
  GameEventInput,
  GameState,
  PlayLocation,
  ReduceResult,
  RuleError,
  StandardMoveIntent,
} from './types/index.js';

const OK = { ok: true } as const;

function originOf(o: CardInstance): string {
  return o.zone.kind === 'battlefield' ? o.zone.battlefieldId : 'base';
}

function destOf(d: PlayLocation): string {
  return d.kind === 'battlefield' ? d.battlefieldId : 'base';
}

/** Pure legality check for a Standard Move. */
export function canStandardMove(
  state: GameState,
  cards: CardDatabase,
  intent: StandardMoveIntent,
): { ok: true } | RuleError {
  const { playerId, unitIds, destination } = intent;
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  if (state.turn.activePlayer !== playerId) return ruleError('NOT_YOUR_TURN');
  if (state.flow.showdown !== undefined || state.flow.combat !== undefined) {
    return ruleError('MOVE_NOT_ALLOWED_IN_SHOWDOWN');
  }
  if (state.flow.chain.length > 0) return ruleError('CLOSED_STATE_REACTION_ONLY');
  if (state.turn.phase !== 'MAIN') return ruleError('WRONG_PHASE', `phase ${state.turn.phase}`);
  if (state.flow.priority !== playerId) {
    return ruleError('NOT_YOUR_PRIORITY', `priority: ${state.flow.priority ?? 'none'}`);
  }

  if (unitIds.length === 0) return ruleError('NOT_FOUND', 'no units to move');
  if (new Set(unitIds).size !== unitIds.length) {
    return ruleError('ILLEGAL_TARGET', 'a unit was listed more than once');
  }
  if (
    destination.kind === 'battlefield' &&
    !state.battlefields.some((b) => b.id === destination.battlefieldId)
  ) {
    return ruleError('ILLEGAL_MOVE_DESTINATION', `battlefield ${destination.battlefieldId}`);
  }

  for (const id of unitIds) {
    const o = state.objects[id];
    if (!o) return ruleError('NOT_FOUND', `unit ${id}`);
    if (o.controller !== playerId) return ruleError('NOT_OWNED', `unit ${id}`);
    const def = cards[o.cardId];
    if (!isUnitDef(def)) return ruleError('WRONG_CARD_TYPE', `${id} is not a unit`);
    if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') {
      return ruleError('ILLEGAL_LOCATION', `unit ${id} is not on the board`);
    }
    if (!o.ready) return ruleError('UNIT_EXHAUSTED', `unit ${id}`); // 144.2
    const from = originOf(o);
    if (from === destOf(destination)) {
      return ruleError('ILLEGAL_MOVE_DESTINATION', `unit ${id} is already at ${from}`);
    }
    if (o.zone.kind === 'battlefield' && destination.kind === 'battlefield') {
      if (!defWithGrants(state, cards, o)?.keywords.some((k) => k.name === 'Ganking')) {
        return ruleError('ILLEGAL_MOVE_DESTINATION', `unit ${id} lacks Ganking`); // 144.4.c.1
      }
    }
  }
  return OK;
}

/** STANDARD_MOVE (144, 447-455). */
export function standardMove(
  state: GameState,
  cards: CardDatabase,
  intent: StandardMoveIntent,
): ReduceResult {
  const legal = canStandardMove(state, cards, intent);
  if (!legal.ok) return legal;

  const next = fork(state);
  const mover = intent.playerId;
  const ps = next.players[playerIndex(mover)];
  const inputs: GameEventInput[] = [];
  const to = destOf(intent.destination);

  for (const id of intent.unitIds) {
    const o = next.objects[id] as CardInstance;
    const from = originOf(o);
    o.ready = false; // 144.2 cost
    if (o.zone.kind === 'base') ps.base = ps.base.filter((x) => x !== id);
    if (intent.destination.kind === 'battlefield') {
      o.zone = {
        kind: 'battlefield',
        player: mover,
        battlefieldId: intent.destination.battlefieldId,
      };
    } else {
      o.zone = { kind: 'base', player: mover };
      ps.base.push(id);
    }
    inputs.push({ type: 'UNIT_MOVED', unitId: id, from, to });
  }

  if (intent.destination.kind === 'battlefield') {
    const destId = intent.destination.battlefieldId;
    const bf = next.battlefields.find((b) => b.id === destId);
    if (bf && bf.controller !== mover) bf.contestedBy = mover; // 190.3, 452
  }

  return { ok: true, state: next, events: stampEvents(next, inputs) };
}
