/**
 * X7 (575): optional ("you may pay ...") replacements for the death of a unit: Altar of Blood, The Boss,
 * Mordekaiser (standing abilities) and Unlicensed Armory (a marker on the unit).
 *
 * When the Cleanup is about to kill a unit that has at least one payable offer, it does not kill it: it
 * sets `flow.pendingChoice = {kind: 'DEATH_REPLACE'}` and stops (killLethalUnits keeps the lethal damage
 * on the unit). DECIDE_REPLACEMENT answers it:
 *  - accept: the cost is paid exactly like an optional ability's (Rune Pool through `payCost`, chosen
 *    cards through `payCostCards`), then "exhaust me" / "spend its buff" / "once each turn" are applied
 *    and the unit is healed, exhausted and recalled to its Base (a recall is not a move);
 *  - decline: the unit is marked as having declined (`deathDeclined`) and the next Cleanup kills it.
 * An offer that cannot be paid is not offered.
 */
import { fork } from './workingCopy.js';
import { costCardsLegal, payCostCards } from './costCards.js';
import { replaceDeath } from './deathReplace.js';
import { optionalPlan, optionalTotalCost } from './optional.js';
import { autoPlan, payCost } from './resources.js';
import { stampEvents } from './setup.js';
import { optionalReplacements } from './statics.js';
import { ruleError } from './types/index.js';
import type {
  CardDatabase,
  CardInstance,
  DeathReplaceOffer,
  DecideReplacementIntent,
  GameEventInput,
  GameState,
  ReduceResult,
} from './types/index.js';

const isFree = (c: { energy: number; power: unknown[] }): boolean =>
  c.energy === 0 && c.power.length === 0;

function atCombat(state: GameState, o: CardInstance): boolean {
  const c = state.flow.combat;
  return (
    c !== undefined && o.zone.kind === 'battlefield' && o.zone.battlefieldId === c.battlefieldId
  );
}

/** Every offer that could replace the death of `o` right now and that its controller can pay. */
export function collectOffers(
  state: GameState,
  cards: CardDatabase,
  o: CardInstance,
): DeathReplaceOffer[] {
  const out: DeathReplaceOffer[] = [];
  const payable = (cardId: string, sourceId: string, o2: DeathReplaceOffer): boolean =>
    optionalPlan(state, cards, o.controller, cardId, o2.cost, sourceId) !== null &&
    (!o2.spendBuff || o.buffed === true);
  if (o.deathOffer) {
    const offer: DeathReplaceOffer = {
      sourceId: o.id,
      cardId: o.deathOffer.cardId,
      cost: o.deathOffer.cost,
      marker: true,
    };
    if (payable(offer.cardId, o.id, offer)) out.push(offer);
  }
  for (const r of optionalReplacements(state, cards, o)) {
    const spec = r.ability.replaceDeath?.offer;
    if (!spec || r.controller !== o.controller) continue;
    if (spec.buffedOnly && !o.buffed) continue;
    if (spec.combatOnly && !atCombat(state, o)) continue;
    const src = state.objects[r.sourceId];
    if (spec.oncePerTurn && src?.deathUsedTurn === state.turn.number) continue;
    if (spec.exhaustSource && !(src && src.ready)) continue;
    const offer: DeathReplaceOffer = {
      sourceId: r.sourceId,
      cardId: r.cardId,
      cost: spec.cost,
      ...(spec.exhaustSource ? { exhaustSource: true } : {}),
      ...(spec.spendBuff ? { spendBuff: true } : {}),
      ...(spec.oncePerTurn ? { oncePerTurn: true } : {}),
    };
    if (payable(r.cardId, r.sourceId, offer)) out.push(offer);
  }
  return out;
}

/**
 * Called by the Cleanup's kill step for a unit with lethal damage. True = do not kill it now (a choice is
 * pending, for this unit or already for another one). MUTATES the working state.
 */
export function askDeathReplacement(
  state: GameState,
  cards: CardDatabase,
  o: CardInstance,
): boolean {
  if (o.deathDeclined) return false;
  const offers = collectOffers(state, cards, o);
  if (offers.length === 0) return false;
  if (!state.flow.pendingChoice) {
    state.flow.pendingChoice = {
      kind: 'DEATH_REPLACE',
      player: o.controller,
      unitId: o.id,
      offers,
    };
  }
  return true;
}

/** DECIDE_REPLACEMENT: answer the pending DEATH_REPLACE choice. */
export function decideReplacement(
  state: GameState,
  cards: CardDatabase,
  intent: DecideReplacementIntent,
): ReduceResult {
  const pc = state.flow.pendingChoice;
  if (!pc || pc.kind !== 'DEATH_REPLACE') {
    return ruleError('WRONG_PHASE', 'no death replacement is waiting for an answer');
  }
  if (intent.playerId !== pc.player) return ruleError('NOT_YOUR_PRIORITY', 'not your choice');
  if (intent.unitId !== pc.unitId)
    return ruleError('NOT_FOUND', `unit ${intent.unitId} is not the one waiting`);
  if (typeof intent.accept !== 'boolean')
    return ruleError('UNKNOWN_INTENT', 'accept must be a boolean');
  let work = fork(state);
  delete work.flow.pendingChoice;
  const unit = work.objects[pc.unitId];
  if (!unit) return ruleError('NOT_FOUND', 'the unit is gone');
  if (!intent.accept) {
    unit.deathDeclined = true;
    return { ok: true, state: work, events: [] };
  }
  const offers = collectOffers(work, cards, unit);
  const offer =
    offers.find((x) => x.sourceId === intent.sourceId) ??
    (intent.sourceId === undefined && offers.length === 1 ? offers[0] : undefined);
  if (!offer) return ruleError('MISSING_TARGET', 'choose which replacement to use');
  const cost = offer.cost;
  if (cost.card) {
    if (intent.costCards === undefined) {
      return ruleError('MISSING_TARGET', 'choose the cards that pay the cost');
    }
    if (!costCardsLegal(work, cards, pc.player, offer.sourceId, cost.card, intent.costCards)) {
      return ruleError('ILLEGAL_TARGET', 'those cards cannot pay the cost');
    }
  } else if (intent.costCards !== undefined && intent.costCards.length > 0) {
    return ruleError('ILLEGAL_TARGET', 'this cost has no card choice');
  }
  const own: GameEventInput[] = [];
  const total = optionalTotalCost(cards, offer.cardId, cost);
  if (!isFree(total)) {
    const plan = intent.payment ?? autoPlan(work, cards, pc.player, total);
    if (plan === null) return ruleError('INSUFFICIENT_RESOURCES', 'you cannot pay that cost');
    const paid = payCost(work, cards, pc.player, total, plan);
    if (!paid.ok) return paid;
    work = paid.state;
  }
  if (cost.card && intent.costCards) {
    own.push(...payCostCards(work, cards, pc.player, offer.sourceId, cost.card, intent.costCards));
  }
  const live = work.objects[pc.unitId] as CardInstance;
  const src = work.objects[offer.sourceId];
  if (offer.exhaustSource && src) src.ready = false;
  if (offer.spendBuff) delete live.buffed;
  if (offer.oncePerTurn && src) src.deathUsedTurn = work.turn.number;
  if (offer.marker) delete live.deathOffer;
  live.deathReplace = 'RECALL';
  own.push(replaceDeath(work, cards, live));
  return { ok: true, state: work, events: stampEvents(work, own) };
}
