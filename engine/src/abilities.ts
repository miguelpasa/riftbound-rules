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
 *  - Target-free effects only; the parser refuses everything else.
 */
import { finalizeAndSettle, canPlayNow, pushPendingItem } from './chain.js';
import { killGear, runEffects } from './effects.js';
import { autoPlan, payCost } from './resources.js';
import { allocObjectId, stampEvents } from './setup.js';
import { isGearDef } from './tokens.js';
import { ruleError } from './types/index.js';
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

const onBoard = (o: CardInstance): boolean =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield';

/** True when every effect of the ability is an [Add] effect (no Chain, 168). */
export function isAddAbility(a: ActivatedAbility): boolean {
  return (
    a.effects.length > 0 && a.effects.every((e) => e.op === 'ADD_ENERGY' || e.op === 'ADD_POWER')
  );
}

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
  if (ability.cost.killSelf && !isGearDef(def)) {
    return ruleError('ABILITY_NOT_AVAILABLE', 'only gear can be killed as a cost');
  }
  const add = isAddAbility(ability);
  if (!add) {
    const timing = canPlayNow(state, cards, pid, def, {
      isAbility: true,
      isReactionAbility: ability.reaction === true,
    });
    if (!timing.ok) return timing;
  }
  if (ability.cost.exhaust && !src.ready) {
    return ruleError('UNIT_EXHAUSTED', `${src.id} is exhausted`);
  }
  const paid = payCost(
    state,
    cards,
    pid,
    { energy: ability.cost.energy ?? 0, power: [] },
    intent.payment ?? [],
  );
  if (!paid.ok) return paid;

  const work = paid.state;
  const obj = work.objects[src.id] as CardInstance;
  const events: GameEventInput[] = [
    { type: 'ABILITY_ACTIVATED', player: pid, sourceId: src.id, abilityIndex: intent.abilityIndex },
  ];
  if (ability.cost.exhaust) obj.ready = false;
  if (ability.cost.killSelf) {
    killGear(work, obj);
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
    targets: [],
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
      const need = a.cost.energy ?? 0;
      const payment = autoPlan(state, cards, pid, { energy: need, power: [] });
      if (payment === null) return;
      out.push({ type: 'ACTIVATE_ABILITY', playerId: pid, sourceId: o.id, abilityIndex, payment });
    });
  }
  return out;
}
