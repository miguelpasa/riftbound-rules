/** X-hand: answering a pending HAND_CHOICE (see handChoiceStart.ts). */
import { fork } from './workingCopy.js';
import { runEffects, takeChosen } from './effects.js';
import { startHandChoice } from './handChoiceStart.js';
import { stampEvents } from './setup.js';
import { ruleError } from './types/index.js';
import type {
  CardDatabase,
  ChooseHandCardsIntent,
  GameEventInput,
  ReduceResult,
} from './types/index.js';
import type { GameState } from './types/index.js';

/** CHOOSE_HAND_CARDS: answer the pending HAND_CHOICE with exactly `count` of the offered cards. */
export function chooseHandCards(
  state: GameState,
  cards: CardDatabase,
  intent: ChooseHandCardsIntent,
): ReduceResult {
  const pc = state.flow.pendingChoice;
  if (!pc || pc.kind !== 'HAND_CHOICE') {
    return ruleError('WRONG_PHASE', 'no hand choice is waiting for an answer');
  }
  if (intent.playerId !== pc.player) return ruleError('NOT_YOUR_PRIORITY', 'not your choice');
  const ids = intent.cardIds;
  const offered = new Set(pc.options.map((o) => o.id));
  if (
    !Array.isArray(ids) ||
    (ids.length !== pc.count && !(pc.optional === true && ids.length === 0)) ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !offered.has(id))
  ) {
    return ruleError('ILLEGAL_TARGET', `choose exactly ${pc.count} of the offered cards`);
  }
  const s = fork(state);
  delete s.flow.pendingChoice;
  const out: GameEventInput[] = [];
  takeChosen(s, cards, pc.handOf, ids, pc.action, pc.sourceObjectId, out);
  // The next player who has to discard, if any; otherwise the rest of the effect list.
  const more = startHandChoice(
    s,
    cards,
    {
      mode: pc.mode,
      take: takeChosen,
      ...(pc.board ? { board: pc.board } : {}),
      ...(pc.optional ? { optional: true } : {}),
      players: pc.later,
      count: pc.count,
      action: pc.action,
      ...(pc.filter ? { filter: pc.filter } : {}),
      controller: pc.controller,
      sourceObjectId: pc.sourceObjectId,
      sourceCardId: pc.sourceCardId,
      rest: pc.rest,
    },
    out,
  );
  if (!more && pc.rest.length > 0) {
    out.push(
      ...runEffects(s, pc.controller, pc.rest, cards, [], pc.sourceCardId, pc.sourceObjectId),
    );
  }
  return { ok: true, state: s, events: stampEvents(s, out) };
}
