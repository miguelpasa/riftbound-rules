import { rngShuffle } from './rng.js';
import { drawFromTop, stampEvents } from './setup.js';
import { MAX_MULLIGAN, playerIndex } from './types/constants.js';
import { ruleError } from './types/errors.js';
import type {
  CardDatabase,
  CardInstance,
  GameEventInput,
  GameState,
  MulliganIntent,
  ReduceResult,
} from './types/index.js';

/**
 * Apply one player's mulligan decision (Rule 117). Decisions are made sequentially in turn order.
 * The chosen cards are set aside, the same number is drawn, then the set-aside cards are recycled
 * to the bottom of the main deck in random order (117.3, 417.5). Empty `cardIds` = keep the hand.
 * When both players are done the game moves to the AWAKEN phase of turn 1 (p0 active); the
 * phase machine takes over from there and no PHASE_CHANGED event is emitted here.
 */
export function applyMulligan(
  state: GameState,
  _cards: CardDatabase,
  intent: MulliganIntent,
): ReduceResult {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  if (state.turn.phase !== 'MULLIGAN' || state.mulligan === null) return ruleError('WRONG_PHASE');
  const current = state.mulligan.order[state.mulligan.current];
  if (intent.playerId !== current) {
    return ruleError('MULLIGAN_ORDER', `waiting for ${current}`);
  }
  const ids = intent.cardIds;
  if (ids.length > MAX_MULLIGAN) {
    return ruleError('MULLIGAN_INVALID', `at most ${MAX_MULLIGAN} cards`);
  }
  if (new Set(ids).size !== ids.length) return ruleError('MULLIGAN_INVALID', 'duplicate cards');
  const hand = state.players[playerIndex(intent.playerId)].hand;
  for (const id of ids) if (!hand.includes(id)) return ruleError('NOT_IN_HAND', id);

  const next = structuredClone(state);
  const mull = next.mulligan as NonNullable<GameState['mulligan']>;
  const ps = next.players[playerIndex(intent.playerId)];
  const inputs: GameEventInput[] = [];

  // Set aside, draw replacements, then recycle the set-aside cards to the bottom.
  ps.hand = ps.hand.filter((id) => !ids.includes(id));
  inputs.push(...drawFromTop(next, intent.playerId, ids.length));
  for (const id of rngShuffle(ids, next)) {
    ps.mainDeck.push(id);
    (next.objects[id] as CardInstance).zone = { kind: 'mainDeck', player: intent.playerId };
  }

  mull.done.push(intent.playerId);
  mull.current += 1;
  if (mull.current >= mull.order.length) {
    next.mulligan = null;
    next.turn = { number: 1, activePlayer: 'p0', phase: 'AWAKEN', step: 'NONE' };
  }
  return { ok: true, state: next, events: stampEvents(next, inputs) };
}
