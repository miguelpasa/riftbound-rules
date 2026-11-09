/**
 * Self cost reductions (R50): "I cost [N] less for each <thing>", "This costs [N] less if <condition>",
 * plus the Legion discount (812). One function answers "how much Energy is knocked off this card right now",
 * used by play.ts (the real payment), legalActions.ts (affordability) and the client (cost display).
 * Reads only public information (board, Trash, plays this turn).
 */
import { evalCondition } from './conditions.js';
import { effectiveMight } from './combat.js';
import { legionActive } from './keywords.js';
import { petTagCount } from './petTags.js';
import { isUnitDef } from './tokens.js';
import { playerIndex } from './types/constants.js';
import type {
  ActivatedAbility,
  CardDatabase,
  CardDef,
  CostCount,
  CostReduction,
  GameState,
  PlayerId,
} from './types/index.js';

export const MIGHTY_MIGHT_COST = 5;

function countFor(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
  sourceId: string,
  what: CostCount,
): number {
  const ps = state.players[playerIndex(pid)];
  switch (what) {
    case 'RUNE':
      return Object.values(state.objects).filter(
        (o) => o.controller === pid && o.zone.kind === 'base' && cards[o.cardId]?.type === 'RUNE',
      ).length;
    case 'HIGHEST_MIGHT': {
      let best = 0;
      for (const o of Object.values(state.objects)) {
        if (o.controller !== pid || (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield'))
          continue;
        if (isUnitDef(cards[o.cardId])) {
          best = Math.max(best, effectiveMight(state, cards, o.id, { role: null }));
        }
      }
      return best;
    }
    case 'CONQUERED_THIS_TURN': {
      const rec = ps?.turnFlags;
      return rec && rec.turn === state.turn.number ? (rec.conquered ?? 0) : 0;
    }
    case 'PET_TAGS':
      return petTagCount(state, cards, pid, sourceId);
    case 'TRASH':
      return Object.values(state.objects).filter(
        (o) => o.zone.kind === 'trash' && o.owner === pid && o.id !== sourceId,
      ).length;
    case 'TRASH_SAME_NAME':
      return Object.values(state.objects).filter(
        (o) =>
          o.zone.kind === 'trash' &&
          o.owner === pid &&
          o.id !== sourceId &&
          cards[o.cardId]?.name === def.name,
      ).length;
    case 'CARDS_PLAYED': {
      const rec = ps?.playedThisTurn;
      if (!rec || rec.turn !== state.turn.number) return 0;
      return rec.objectIds.filter((id) => id !== sourceId).length;
    }
    default: {
      let n = 0;
      for (const o of Object.values(state.objects)) {
        if (o.controller !== pid || o.id === sourceId) continue;
        if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
        const d = cards[o.cardId];
        if (what === 'GEAR') {
          if (d?.type === 'GEAR') n++;
        } else if (isUnitDef(d)) {
          if (what === 'EXHAUSTED_UNIT' && !o.ready) n++;
          if (
            what === 'MIGHTY_UNIT' &&
            effectiveMight(state, cards, o.id, { role: null }) >= MIGHTY_MIGHT_COST
          )
            n++;
        }
      }
      return n;
    }
  }
}

/** One discount: `amount` Energy off, but never taking the cost below `min` (560.4.c: a minimum belongs to its discount). */
interface Discount {
  amount: number;
  /** Undefined = not clamped to the cost (callers clamp the total). */
  min?: number;
}

const applyDiscount = (cost: number, d: Discount): number =>
  d.min === undefined ? d.amount : Math.min(d.amount, Math.max(0, cost - d.min));

/**
 * X5 (560.4): discounts may be applied in any order, and a minimum applies only to its own discount. The
 * player always prefers the cheapest result, so take the best order (discounts with a minimum go first when
 * that is better: 8 Energy with "-1 to a minimum of 1" and "-7" is 0, not 1).
 */
export function bestDiscountTotal(baseEnergy: number, ds: readonly Discount[]): number {
  const live = ds.filter((d) => d.amount > 0);
  if (live.length === 0) return 0;
  if (live.every((d) => !d.min) || live.length === 1) {
    return live.reduce((n, d) => n + applyDiscount(baseEnergy - n, d), 0);
  }
  let best = 0;
  const walk = (left: Discount[], cost: number, total: number): void => {
    if (left.length === 0) {
      best = Math.max(best, total);
      return;
    }
    for (let i = 0; i < left.length; i++) {
      const d = left[i] as Discount;
      const cut = applyDiscount(cost, d);
      walk([...left.slice(0, i), ...left.slice(i + 1)], cost - cut, total + cut);
    }
  };
  // Beyond 6 discounts the factorial search is not worth it: minimum-bearing ones first is the greedy order.
  if (live.length > 6) {
    const sorted = [...live].sort((a, b) => (b.min ?? 0) - (a.min ?? 0));
    return sorted.reduce((n, d) => n + applyDiscount(baseEnergy - n, d), 0);
  }
  walk(live, baseEnergy, 0);
  return best;
}

/** Energy knocked off `def`'s cost for `pid` right now (Legion + the card's own `costReduction` + statics). */
export function selfEnergyDiscount(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
  sourceId: string,
): number {
  const ds: Discount[] = [];
  if (def.legionCostReduction && legionActive(state, pid, sourceId)) {
    ds.push({ amount: def.legionCostReduction });
  }
  const r = def.costReduction;
  if (r) ds.push(rawReduction(state, cards, pid, def, r, sourceId));
  ds.push(...staticPlayCostDiscounts(state, cards, pid, def));
  // R105: a one-shot "the next spell you play this turn costs [N] less".
  const nd = state.players[playerIndex(pid)]?.nextPlayDiscount;
  if (nd && nd.turn === state.turn.number && (!nd.spellsOnly || def.type === 'SPELL')) {
    ds.push({ amount: nd.energy, min: 0 });
  }
  return bestDiscountTotal(def.cost.energy, ds);
}

/** R104: the "cost modifier" statics of the player's permanents and Legend that apply to `def`. */
function staticPlayCostDiscounts(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
): Discount[] {
  const out: Discount[] = [];
  for (const o of Object.values(state.objects)) {
    if (o.controller !== pid) continue;
    const z = o.zone.kind;
    if (z !== 'base' && z !== 'battlefield' && z !== 'legend') continue;
    for (const s of cards[o.cardId]?.statics ?? []) {
      const m = s.playCostMod;
      if (!m) continue;
      if (m.spellsOnly && def.type !== 'SPELL') continue;
      if (
        m.subtype &&
        !def.subtypes.some((x) => x.toLowerCase() === (m.subtype ?? '').toLowerCase())
      ) {
        continue;
      }
      if (s.when && !evalCondition(state, cards, s.when, pid, o.id)) continue;
      out.push({ amount: m.energy, min: m.min });
    }
  }
  return out;
}

/** The raw amount and minimum of one `CostReduction` (before clamping to the cost). */
function rawReduction(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
  r: CostReduction,
  sourceId: string,
): Discount {
  let amount = 0;
  if (r.per) amount = r.energy * countFor(state, cards, pid, def, sourceId, r.per);
  else if (!r.when || evalCondition(state, cards, r.when, pid, sourceId)) amount = r.energy;
  return r.min === undefined ? { amount } : { amount, min: r.min };
}

/** Energy knocked off by one `CostReduction` whose base Energy cost is `baseEnergy` right now. */
function reductionAmount(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
  r: CostReduction,
  sourceId: string,
  baseEnergy: number,
): number {
  return applyDiscount(baseEnergy, rawReduction(state, cards, pid, def, r, sourceId));
}

/** R91: the Energy discount of an activated ability's own `costReduction`. */
export function abilityEnergyDiscount(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
  ability: ActivatedAbility,
  sourceId: string,
): number {
  const r = ability.costReduction;
  return r ? reductionAmount(state, cards, pid, def, r, sourceId, ability.cost.energy ?? 0) : 0;
}
