/**
 * Activated abilities of permanents (Core Rules 145.1, 151.1: "Costs followed by a colon, then an
 * effect"; 168 and 166.1: [Add] puts Energy / Power in the Rune Pool). Intent: ACTIVATE_ABILITY.
 *
 * Decisions (see docs/ASSUMPTIONS.md, A-R38):
 *  - An ability whose effects are all [Add] effects resolves at once and never uses the Chain, like a
 *    rune (164.2): it needs no Priority (it cannot be reacted to, per the printed reminder text).
 *  - Any other ability pays its cost, then goes on the Chain as a FINALIZED ABILITY item with
 *    `activatedIndex`; timing is `canPlayNow` with isAbility (Reaction abilities may be used in a
 *    Closed state or Showdown, the others only in a Neutral Open state on your turn).
 *  - Costs: exhaust the source ([E]), Energy (paid from the Rune Pool, so `payment` may exhaust
 *    runes first) and "Kill this" (Gear or gear-like token; a token ceases to exist, 186.1).
 *  - Card-choice costs (R46, `AbilityCost.card`): "Discard a gear, [1], [E]: ...", "Recycle 1 from your
 *    trash: ...". The intent carries the chosen cards (`costCards`), checked before anything is paid and
 *    paid together with the rest of the cost; [C] / [A] in the cost are paid like Energy (`payment`).
 *  - Targets (R41): an ability that chooses units takes `ACTIVATE_ABILITY.targets`, validated like a
 *    spell's (355.10) before any cost is paid and re-checked when it resolves (fizzles if illegal).
 */
import { finalizeAndSettle, canPlayNow, pushPendingItem } from './chain.js';
import { abilityEnergyDiscount } from './costReduction.js';
import {
  enumerateSpellTargets,
  killGear,
  runEffects,
  abilityTargetsLegal,
  targetRequirements,
} from './effects.js';
import { costCardCombos, costCardsLegal, costCardsPayable, payCostCards } from './costCards.js';
import { autoPlan, genericPower, payCost } from './resources.js';
import type { TotalCost } from './resources.js';
import { allocObjectId, stampEvents } from './setup.js';
import { evalCondition } from './conditions.js';
import { legionActive } from './keywords.js';
import { isGearDef } from './tokens.js';
import { playerIndex, ruleError } from './types/index.js';
import type {
  ActivatedAbility,
  ActivateAbilityIntent,
  CardDatabase,
  CardDef,
  CardInstance,
  ChainItem,
  GameEventInput,
  GameState,
  Intent,
  PlayerId,
  ReduceResult,
} from './types/index.js';

/** Where an activated ability can be used from: the board, or (R68) the Legend zone. */
const onBoard = (o: CardInstance): boolean =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield' || o.zone.kind === 'legend';

/** True when every effect of the ability is an [Add] effect (no Chain, 168). */
export function isAddAbility(a: ActivatedAbility): boolean {
  return (
    a.effects.length > 0 && a.effects.every((e) => e.op === 'ADD_ENERGY' || e.op === 'ADD_POWER')
  );
}

/** The Energy / Power part of an ability cost ([C] = Power of the source card's Domain). */
function abilityTotalCost(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  sourceId: string,
  def: CardDef,
  a: ActivatedAbility,
): TotalCost {
  const power: TotalCost['power'] = [];
  if (a.cost.power) power.push(genericPower(def, a.cost.power));
  if (a.cost.anyPower) power.push({ domain: 'ANY', amount: a.cost.anyPower });
  const discount = abilityEnergyDiscount(state, cards, pid, def, a, sourceId);
  return { energy: Math.max(0, (a.cost.energy ?? 0) - discount), power };
}

const targetRequirementsOf = (a: ActivatedAbility): boolean =>
  targetRequirements(a.effects).length > 0;

/** ACTIVATE_ABILITY. */
export function activateAbility(
  state: GameState,
  cards: CardDatabase,
  intent: ActivateAbilityIntent,
): ReduceResult {
  const pid = intent.playerId;
  const src = state.objects[intent.sourceId];
  const def: CardDef | undefined = src ? cards[src.cardId] : undefined;
  const ability = def?.abilities?.[intent.abilityIndex];
  if (!src || !def || !ability) {
    return ruleError('ABILITY_NOT_AVAILABLE', 'that object has no such activated ability');
  }
  if (src.controller !== pid) return ruleError('NOT_OWNED', `object ${src.id}`);
  if (!onBoard(src)) return ruleError('ABILITY_NOT_AVAILABLE', 'the source is not on the board');
  if (state.turn.phase === 'MULLIGAN') {
    return ruleError('WRONG_PHASE', 'no abilities during the mulligan');
  }
  // R74: "Use this ability only while I'm at a battlefield."
  if (ability.atBattlefield && src.zone.kind !== 'battlefield') {
    return ruleError('ABILITY_NOT_AVAILABLE', 'this ability works only at a battlefield');
  }
  // 812: "[Legion] —" on an activated ability needs another card played this turn.
  if (ability.legion && !legionActive(state, pid, src.id)) {
    return ruleError('ABILITY_NOT_AVAILABLE', 'Legion: play another card this turn first');
  }
  // "[Empowered][>]" / "[Level N][>]": the ability exists only while its condition holds.
  if (ability.when && !evalCondition(state, cards, ability.when, pid, src.id)) {
    return ruleError(
      'ABILITY_NOT_AVAILABLE',
      'this ability needs its condition (Empowered / Level)',
    );
  }
  // R52: "Use only if not Empowered": an Empower ability cannot be used again while Empowered.
  if (src.empowered && ability.effects.some((e) => e.op === 'EMPOWER_SELF')) {
    return ruleError('ABILITY_NOT_AVAILABLE', 'already Empowered');
  }
  if (ability.cost.disempower && !src.empowered) {
    return ruleError('ABILITY_NOT_AVAILABLE', 'not Empowered');
  }
  // R60: "Spend N XP" needs the XP.
  if (ability.cost.xp && (state.players[playerIndex(pid)]?.xp ?? 0) < ability.cost.xp) {
    return ruleError('INSUFFICIENT_RESOURCES', `not enough XP (need ${ability.cost.xp})`);
  }
  if (ability.cost.killSelf && !isGearDef(def)) {
    return ruleError('ABILITY_NOT_AVAILABLE', 'only gear can be killed as a cost');
  }
  const add = isAddAbility(ability);
  if (!add) {
    const timing = canPlayNow(state, cards, pid, def, {
      isAbility: true,
      isReactionAbility: ability.reaction === true,
      isActionAbility: ability.action === true,
    });
    if (!timing.ok) return timing;
  }
  const targets = intent.targets ?? [];
  if (!abilityTargetsLegal(state, cards, pid, ability.effects, targets, src.id)) {
    return ruleError('ILLEGAL_TARGET', 'this ability needs legal targets (355.10)');
  }
  if (ability.cost.exhaust && !src.ready) {
    return ruleError('UNIT_EXHAUSTED', `${src.id} is exhausted`);
  }
  // R46: the chosen cards are checked before anything is paid.
  if (ability.cost.card) {
    if (intent.costCards === undefined) {
      return ruleError('MISSING_TARGET', 'choose the cards that pay the cost');
    }
    if (!costCardsLegal(state, cards, pid, src.id, ability.cost.card, intent.costCards)) {
      return ruleError('ILLEGAL_TARGET', 'those cards cannot pay the cost');
    }
  } else if (intent.costCards !== undefined && intent.costCards.length > 0) {
    return ruleError('ILLEGAL_TARGET', 'this ability has no card cost');
  }
  const paid = payCost(
    state,
    cards,
    pid,
    abilityTotalCost(state, cards, pid, src.id, def, ability),
    intent.payment ?? [],
  );
  if (!paid.ok) return paid;

  const work = paid.state;
  const obj = work.objects[src.id] as CardInstance;
  const events: GameEventInput[] = [
    { type: 'ABILITY_ACTIVATED', player: pid, sourceId: src.id, abilityIndex: intent.abilityIndex },
  ];
  if (ability.cost.exhaust) obj.ready = false;
  if (ability.cost.disempower) delete obj.empowered;
  if (ability.cost.xp) {
    const ps = work.players[playerIndex(pid)] as GameState['players'][number];
    ps.xp = (ps.xp ?? 0) - ability.cost.xp;
    events.push({ type: 'XP_SPENT', player: pid, amount: ability.cost.xp });
  }
  if (ability.cost.card && intent.costCards) {
    events.push(...payCostCards(work, cards, pid, src.id, ability.cost.card, intent.costCards));
  }
  if (ability.cost.killSelf) {
    killGear(work, obj, cards);
    events.push({ type: 'GEAR_KILLED', gearId: src.id });
  }
  if (add) {
    events.push(...runEffects(work, pid, ability.effects, cards, [], def.cardId, src.id));
    return { ok: true, state: work, events: stampEvents(work, events) };
  }
  const item: ChainItem = {
    id: allocObjectId(work),
    kind: 'ABILITY',
    sourceObjectId: src.id,
    sourceCardId: def.cardId,
    controller: pid,
    status: 'PENDING',
    targets: targetRequirementsOf(ability) ? targets.map((t) => ({ ...t })) : [],
    choices: {},
    activatedIndex: intent.abilityIndex,
  };
  const activated = stampEvents(work, events);
  const settled = finalizeAndSettle(pushPendingItem(work, item), cards, item.id);
  if (!settled.ok) return settled;
  return { ok: true, state: settled.state, events: [...activated, ...settled.events] };
}

/**
 * Candidate ACTIVATE_ABILITY intents for `pid` (every ability of every permanent they control; the
 * caller filters by actually running the handler). `chainOnly` skips [Add] abilities, which are
 * offered through `getAbilityActivations` like rune activations.
 */
export function abilityCandidates(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  chainOnly: boolean,
): Intent[] {
  const out: Intent[] = [];
  const mine = Object.values(state.objects)
    .filter((o) => o.controller === pid && onBoard(o))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const o of mine) {
    const abilities = cards[o.cardId]?.abilities;
    abilities?.forEach((a, abilityIndex) => {
      if (chainOnly && isAddAbility(a)) return;
      const def = cards[o.cardId];
      if (!def) return;
      const payment = autoPlan(
        state,
        cards,
        pid,
        abilityTotalCost(state, cards, pid, o.id, def, a),
      );
      if (payment === null) return;
      // R46: one candidate per choice of cost cards; none = not activatable.
      if (a.cost.card && !costCardsPayable(state, cards, pid, o.id, a.cost.card)) return;
      if (a.cost.xp && (state.players[playerIndex(pid)]?.xp ?? 0) < a.cost.xp) return;
      const picks: (string[] | undefined)[] = a.cost.card
        ? costCardCombos(state, cards, pid, o.id, a.cost.card)
        : [undefined];
      // R41: one candidate per target choice (capped by MAX_TARGET_COMBOS); none = not activatable.
      const choices = enumerateSpellTargets(state, cards, pid, a.effects, o.id) ?? [undefined];
      for (const costCards of picks) {
        for (const targets of choices) {
          out.push({
            type: 'ACTIVATE_ABILITY',
            playerId: pid,
            sourceId: o.id,
            abilityIndex,
            ...(targets ? { targets } : {}),
            ...(costCards ? { costCards } : {}),
            payment,
          });
        }
      }
    });
  }
  return out;
}
