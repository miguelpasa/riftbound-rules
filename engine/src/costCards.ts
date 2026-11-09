/**
 * Card-choice costs (R46): "discard 1", "kill a friendly unit", "exhaust a unit you control", "return a
 * unit you control here to its owner's hand", "recycle a unit from your trash" as (part of) the cost of
 * an optional triggered ability ("you may ... to ...", `OptionalCost.card`) or of an activated ability
 * (`AbilityCost.card`).
 *
 * The payer picks the cards in the intent (`DECIDE_OPTIONAL.costCards` / `ACTIVATE_ABILITY.costCards`).
 * `costCardsLegal` checks the choice (right count, all distinct, each one qualifying) BEFORE anything is
 * paid and `payCostCards` applies it to the working copy, so a rejected choice leaves the state
 * untouched and an accepted one is paid atomically with the Energy / Power part.
 *
 * Hidden information: a discarded card goes to the public Trash, so the COST_CARDS_PAID event may name
 * it; the hand it came from stays private. Legal choices are enumerated only for the payer.
 */
import { effectiveMight } from './combat.js';
import { MAX_TARGET_COMBOS, killGear, returnToHand } from './effects.js';
import { hereOfSource } from './sources.js';
import { isGearDef, isUnitDef } from './tokens.js';
import { playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  CostCardChoice,
  GameEventInput,
  GameState,
  PlayerId,
} from './types/index.js';

const num = (id: string): number => Number(id.slice(1));

/**
 * What choosing the cards of a cost reads: the objects and battlefields. A `GameState` fits, and so does
 * the part of a client view that holds real objects (the client lists the choices from its own view).
 */
export interface CostCardView {
  objects: Record<string, CardInstance>;
  battlefields: GameState['battlefields'];
}

/** How many cards the cost takes. */
export const costCardCount = (cc: CostCardChoice): number => cc.count ?? 1;

/** The player-facing words of a card-choice cost: "Discard 1 card", "Kill a friendly unit". */
export function costCardText(cc: CostCardChoice): string {
  const n = costCardCount(cc);
  const plural = n === 1 ? '' : 's';
  const lead = n === 1 ? (cc.another ? 'another' : 'a') : cc.another ? `${n} other` : String(n);
  const what = cc.what ?? (cc.kind === 'DISCARD' || cc.kind === 'RECYCLE' ? undefined : 'unit');
  const noun = (w: string | undefined): string =>
    w === undefined
      ? `card${plural}`
      : w === 'unitOrGear'
        ? `unit${plural} or gear`
        : `${w}${plural}`;
  const where = cc.here ? ' here' : '';
  const mighty = cc.mighty ? 'Mighty ' : '';
  switch (cc.kind) {
    case 'DISCARD':
      return `Discard ${n} ${noun(what)}`;
    case 'KILL':
      return `Kill ${lead} friendly ${mighty}${noun(what)}${where}`;
    case 'EXHAUST':
      return `Exhaust ${lead} friendly ${mighty}${noun(what)}${where}`;
    case 'RETURN':
      return `Return ${lead} friendly ${mighty}${noun(what)}${where} to hand`;
    case 'RECYCLE':
      return `Recycle ${n} ${noun(what)} from your Trash`;
    case 'SPEND_BUFF':
      return n === 1 ? 'Spend a buff' : `Spend ${n} buffs`;
    case 'REVEAL':
      return `Show off ${lead} ${cc.subtype ?? ''}${cc.hidden ? ' card with Hidden' : ' ' + noun(what)}`
        .replace(/\s+/g, ' ')
        .trim();
  }
}

const typeOfWhat = (what: CostCardChoice['what']): 'UNIT' | 'GEAR' | 'SPELL' | undefined =>
  what === 'unit' ? 'UNIT' : what === 'gear' ? 'GEAR' : what === 'spell' ? 'SPELL' : undefined;

/** R47: a unit is [Mighty] with 5 or more Might (the printed reminder text of Sacrifice). */
export const MIGHTY_MIGHT = 5;

/** Current Might of a unit on the board (outside combat); `state` only needs its objects. */
const mightOf = (state: CostCardView, cards: CardDatabase, id: string): number =>
  effectiveMight(state as GameState, cards, id, { role: null });

/** Does `o` qualify for the cost, for `player`, with `sourceId` the ability's source? */
function qualifies(
  state: CostCardView,
  cards: CardDatabase,
  player: PlayerId,
  sourceId: string,
  cc: CostCardChoice,
  o: CardInstance,
): boolean {
  const def = cards[o.cardId];
  if (!def) return false;
  if (cc.kind === 'DISCARD' || cc.kind === 'RECYCLE' || cc.kind === 'REVEAL') {
    const want = typeOfWhat(cc.what);
    const zone = cc.kind === 'RECYCLE' ? 'trash' : 'hand';
    if (o.zone.kind !== zone || o.owner !== player) return false;
    // R47: the card being played (still in hand) cannot pay its own additional cost.
    if (o.id === sourceId) return false;
    if (cc.hidden && !def.keywords.some((k) => k.name === 'Hidden')) return false;
    if (cc.minEnergy !== undefined && def.cost.energy < cc.minEnergy) return false;
    if (cc.subtype && !def.subtypes.some((s) => s.toLowerCase() === cc.subtype?.toLowerCase())) {
      return false;
    }
    return want === undefined || def.type === want;
  }
  if ((o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') || o.controller !== player) {
    return false;
  }
  const what = cc.what ?? 'unit';
  const unit = isUnitDef(def);
  const gear = isGearDef(def);
  if (cc.kind === 'SPEND_BUFF') {
    if (!unit || o.buffed !== true) return false;
  } else if (cc.kind === 'EXHAUST') {
    if (!unit || !o.ready) return false;
  } else if (what === 'unit' ? !unit : what === 'gear' ? !gear : !(unit || gear)) {
    return false;
  }
  if (cc.mighty && !(unit && mightOf(state, cards, o.id) >= MIGHTY_MIGHT)) return false;
  if (cc.another && o.id === sourceId) return false;
  if (cc.here) {
    const here = hereOfSource(state, sourceId);
    if (here === null || o.zone.kind !== 'battlefield' || o.zone.battlefieldId !== here) {
      return false;
    }
  }
  return true;
}

/** Every object that may pay (part of) the cost, in object order. */
export function costCardCandidates(
  state: CostCardView,
  cards: CardDatabase,
  player: PlayerId,
  sourceId: string,
  cc: CostCardChoice,
): string[] {
  return Object.values(state.objects)
    .filter((o) => qualifies(state, cards, player, sourceId, cc, o))
    .sort((a, b) => num(a.id) - num(b.id))
    .map((o) => o.id);
}

/** Can the cost be paid at all (enough qualifying cards)? */
export function costCardsPayable(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  sourceId: string,
  cc: CostCardChoice,
): boolean {
  return costCardCandidates(state, cards, player, sourceId, cc).length >= costCardCount(cc);
}

/** Choices for `getLegalActions`: each qualifying set of `count` cards, capped at MAX_TARGET_COMBOS. */
export function costCardCombos(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  sourceId: string,
  cc: CostCardChoice,
): string[][] {
  const cand = costCardCandidates(state, cards, player, sourceId, cc);
  const k = costCardCount(cc);
  const out: string[][] = [];
  const rec = (start: number, acc: string[]): void => {
    if (out.length >= MAX_TARGET_COMBOS) return;
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < cand.length; i++) {
      acc.push(cand[i] as string);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  if (cand.length >= k) rec(0, []);
  return out;
}

/** Is `ids` a legal payment: exactly `count` distinct cards, each qualifying? */
export function costCardsLegal(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  sourceId: string,
  cc: CostCardChoice,
  ids: readonly string[] | undefined,
): boolean {
  if (!ids || ids.length !== costCardCount(cc) || new Set(ids).size !== ids.length) return false;
  return ids.every((id) => {
    const o = state.objects[id];
    return o !== undefined && qualifies(state, cards, player, sourceId, cc, o);
  });
}

/**
 * Pay the cost with `ids` (already checked by `costCardsLegal`). Mutates the working copy `state` and
 * returns the events.
 */
export function payCostCards(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  sourceId: string,
  cc: CostCardChoice,
  ids: readonly string[],
): GameEventInput[] {
  const out: GameEventInput[] = [];
  const names = ids.map((id) => cards[(state.objects[id] as CardInstance).cardId]?.name ?? id);
  out.push({
    type: 'COST_CARDS_PAID',
    player,
    sourceId,
    kind: cc.kind,
    cardIds: [...ids],
    cardNames: names,
  });
  const ps = state.players[playerIndex(player)];
  for (const id of ids) {
    const o = state.objects[id] as CardInstance;
    switch (cc.kind) {
      case 'DISCARD':
        ps.hand = ps.hand.filter((x) => x !== id);
        ps.trash.push(id);
        o.zone = { kind: 'trash', player: o.owner };
        break;
      case 'RECYCLE':
        ps.trash = ps.trash.filter((x) => x !== id);
        ps.mainDeck.push(id);
        o.zone = { kind: 'mainDeck', player: o.owner };
        break;
      case 'EXHAUST':
        o.ready = false;
        break;
      case 'SPEND_BUFF':
        delete o.buffed;
        break;
      case 'REVEAL': {
        const played = state.objects[sourceId];
        if (played) played.showedOff = id;
        break;
      }
      case 'RETURN':
        returnToHand(state, o, out);
        break;
      case 'KILL':
        if (isGearDef(cards[o.cardId])) {
          killGear(state, o, cards);
          out.push({ type: 'GEAR_KILLED', gearId: id });
        } else {
          // Lethal damage; the Cleanup (323) then moves it to the Trash, with its Deathknell.
          const lethal = Math.max(1, effectiveMight(state, cards, id, { role: null })) - o.damage;
          if (lethal > 0) o.damage += lethal;
          out.push({ type: 'EFFECT_DAMAGE', unitId: id, amount: Math.max(lethal, 0) });
        }
        break;
    }
  }
  return out;
}

/**
 * R47: the card-choice additional cost of playing `def`: its required `additionalCost`, else the card
 * part of the Repeat cost when Repeat is paid. Undefined = nothing to choose.
 */
export function playCostCard(
  def: CardDef,
  repeat: boolean,
  extra = false,
): CostCardChoice | undefined {
  return (
    def.additionalCost?.card ??
    (repeat ? def.repeatCost?.card : undefined) ??
    (extra ? def.optionalAdditionalCost?.card : undefined)
  );
}
