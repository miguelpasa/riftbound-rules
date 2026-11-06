/**
 * Optional ("you may [pay COST to] ...") triggered abilities (R45).
 *
 * When such a trigger resolves, its item is put back on top of the Chain and
 * `flow.pendingChoice = {kind: 'OPTIONAL_EFFECT'}` asks the controller. DECIDE_OPTIONAL answers it:
 *  - accept: the cost is paid (Energy / Power through the Rune Pool exactly like a played card's
 *    `payment`, [Burn N] from the Main Deck), then the item resolves and its effects run;
 *  - decline: the item resolves without effects and nothing is paid.
 * An optional ability whose cost cannot be paid is declined automatically (no prompt).
 *
 * Card-choice costs (R46, `OptionalCost.card`): "you may discard 1 / kill a friendly unit / return a unit
 * you control here ... to ...". The accept intent carries the chosen cards (`costCards`); the engine
 * checks them (count, distinct, qualifying) before anything is paid, then pays them together with the
 * Energy / Power / Burn part. An optional ability whose card cost has too few candidates is declined
 * automatically like an unaffordable one.
 *
 * Payment plan: `DECIDE_OPTIONAL.payment` is a rune plan (EXHAUST for Energy, RECYCLE for Power) when
 * the player wants to choose which runes pay; when it is absent the engine builds one with `autoPlan`
 * (the same helper Weaponmaster and the AI use). Surplus stays in the Rune Pool.
 *
 * The effects themselves run in `playResolver` (play.ts), like every triggered ability; targets were
 * chosen when the trigger was put on the Chain (R41) and are re-checked then.
 */
import { fork } from './workingCopy.js';
import { costCardsLegal, costCardsPayable, payCostCards } from './costCards.js';
import { resolveTop } from './chain.js';
import type { ChainResolver } from './chain.js';
import { autoPlan, genericPower, payCost } from './resources.js';
import type { TotalCost } from './resources.js';
import { stampEvents } from './setup.js';
import { triggerSourceCardId } from './triggers.js';
import { itemSourceId } from './sources.js';
import { playerIndex, ruleError } from './types/index.js';
import type {
  CardDatabase,
  DecideOptionalIntent,
  GameEvent,
  GameEventInput,
  GameState,
  OptionalCost,
  PaymentPlan,
  PlayerId,
  ReduceResult,
} from './types/index.js';

/** The Energy / Power part of an optional cost, as a TotalCost ([C] = Power of the source card's Domain). */
export function optionalTotalCost(
  cards: CardDatabase,
  sourceCardId: string,
  cost: OptionalCost,
): TotalCost {
  const power: TotalCost['power'] = [];
  const def = cards[sourceCardId];
  if (cost.power && cost.power > 0) {
    power.push(
      def ? genericPower(def, cost.power) : { domain: 'ANY' as const, amount: cost.power },
    );
  }
  if (cost.anyPower && cost.anyPower > 0) power.push({ domain: 'ANY', amount: cost.anyPower });
  return { energy: cost.energy ?? 0, power };
}

const isFree = (t: TotalCost): boolean => t.energy === 0 && t.power.length === 0;

/**
 * An automatic payment plan for an optional cost: `[]` when nothing needs paying from runes, null when
 * it cannot be paid now (not enough Energy / Power, or fewer cards than [Burn N] needs).
 */
export function optionalPlan(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  sourceCardId: string,
  cost: OptionalCost,
  sourceId = '',
): PaymentPlan | null {
  if ((cost.burn ?? 0) > state.players[playerIndex(player)].mainDeck.length) return null;
  if (cost.card && !costCardsPayable(state, cards, player, sourceId, cost.card)) return null;
  const total = optionalTotalCost(cards, sourceCardId, cost);
  return isFree(total) ? [] : autoPlan(state, cards, player, total);
}

/**
 * DECIDE_OPTIONAL: answer the pending OPTIONAL_EFFECT choice. Paying and resolving happen together, so
 * the state never holds a half-paid ability. The caller (reducer) continues like after a PASS_PRIORITY.
 */
export function decideOptional(
  state: GameState,
  cards: CardDatabase,
  intent: DecideOptionalIntent,
  resolver: ChainResolver,
): ReduceResult {
  const pc = state.flow.pendingChoice;
  if (!pc || pc.kind !== 'OPTIONAL_EFFECT') {
    return ruleError('WRONG_PHASE', 'no optional effect is waiting for an answer');
  }
  if (intent.playerId !== pc.player) return ruleError('NOT_YOUR_PRIORITY', 'not your choice');
  if (typeof intent.accept !== 'boolean')
    return ruleError('UNKNOWN_INTENT', 'accept must be a boolean');
  const top = state.flow.chain[state.flow.chain.length - 1];
  if (intent.chainItemId !== pc.chainItemId || !top || top.id !== pc.chainItemId) {
    return ruleError('NOT_FOUND', `chain item ${intent.chainItemId} is not the one waiting`);
  }
  let work = fork(state);
  delete work.flow.pendingChoice;
  const live = work.flow.chain[work.flow.chain.length - 1];
  if (!live) return ruleError('NOT_FOUND', 'the optional ability is gone');
  const own: GameEventInput[] = [];
  if (intent.accept) {
    const cardId = triggerSourceCardId(work, live) ?? '';
    const cost = pc.cost;
    const ps = work.players[playerIndex(pc.player)];
    if ((cost.burn ?? 0) > ps.mainDeck.length) {
      return ruleError('INSUFFICIENT_RESOURCES', 'not enough cards in the Main Deck to Burn');
    }
    const sourceId = itemSourceId(live);
    // R46: the chosen cards are checked before anything is paid (the state stays untouched on error).
    if (cost.card) {
      if (intent.costCards === undefined) {
        return ruleError('MISSING_TARGET', 'choose the cards that pay the cost');
      }
      if (!costCardsLegal(work, cards, pc.player, sourceId, cost.card, intent.costCards)) {
        return ruleError('ILLEGAL_TARGET', 'those cards cannot pay the cost');
      }
    } else if (intent.costCards !== undefined && intent.costCards.length > 0) {
      return ruleError('ILLEGAL_TARGET', 'this cost has no card choice');
    }
    const total = optionalTotalCost(cards, cardId, cost);
    if (!isFree(total)) {
      const plan = intent.payment ?? autoPlan(work, cards, pc.player, total);
      if (plan === null) return ruleError('INSUFFICIENT_RESOURCES', 'you cannot pay that cost');
      const paid = payCost(work, cards, pc.player, total, plan);
      if (!paid.ok) return paid;
      work = paid.state;
    }
    if (cost.card && intent.costCards) {
      own.push(...payCostCards(work, cards, pc.player, sourceId, cost.card, intent.costCards));
    }
    if (cost.burn) {
      const deck = work.players[playerIndex(pc.player)];
      const milled = deck.mainDeck.splice(0, cost.burn);
      for (const id of milled) {
        const o = work.objects[id];
        if (o) o.zone = { kind: 'trash', player: o.owner };
        deck.trash.push(id);
      }
      own.push({ type: 'CARDS_BURNED', player: pc.player, count: milled.length });
    }
    const item = work.flow.chain[work.flow.chain.length - 1];
    if (item) item.optionalDecision = 'ACCEPT';
  } else {
    live.optionalDecision = 'DECLINE';
  }
  const events: GameEvent[] = stampEvents(work, own);
  const resolved = resolveTop(work, cards, resolver, events);
  return { ok: true, state: resolved, events };
}
