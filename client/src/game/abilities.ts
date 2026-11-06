import { costCardText, selfEnergyDiscount, type GameState } from '@riftbound/engine';
import type {
  ActivateAbilityIntent,
  ActivatedAbility,
  CardDatabase,
  CardDef,
  CardEffect,
  ClientGameState,
  Intent,
  PlayerId,
} from '@riftbound/engine';

/** Legal ACTIVATE_ABILITY intents for one permanent, in ability order (driven by `api.legal`, R40). */
export function abilityVariants(legal: Intent[], sourceId: string): ActivateAbilityIntent[] {
  const out: ActivateAbilityIntent[] = [];
  for (const i of legal) {
    if (i.type === 'ACTIVATE_ABILITY' && i.sourceId === sourceId) out.push(i);
  }
  return out.sort((a, b) => a.abilityIndex - b.abilityIndex);
}

/** Legal ACTIVATE_ABILITY variants of one permanent grouped by ability: targeted abilities have one variant per target choice (R41). */
export function abilityGroups(
  legal: Intent[],
  sourceId: string,
): { abilityIndex: number; variants: ActivateAbilityIntent[] }[] {
  const groups = new Map<number, ActivateAbilityIntent[]>();
  for (const v of abilityVariants(legal, sourceId)) {
    const list = groups.get(v.abilityIndex) ?? [];
    list.push(v);
    groups.set(v.abilityIndex, list);
  }
  return [...groups].map(([abilityIndex, variants]) => ({ abilityIndex, variants }));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function describeEffect(e: CardEffect, def: CardDef): string | null {
  switch (e.op) {
    case 'ADD_ENERGY':
      return `Add ${e.amount} Energy`;
    case 'ADD_POWER': {
      const domain = e.domain === 'SOURCE' ? def.domains[0] : undefined;
      return `Add ${e.amount} ${domain ? `${domain} ` : 'any-domain '}Power`;
    }
    case 'DRAW':
      return `Draw ${e.amount}`;
    case 'GAIN_POINT':
      return `Gain ${plural(e.amount, 'point', 'points')}`;
    default:
      return null;
  }
}

export interface AbilityDescription {
  /** "Exhaust, 2 Energy, Kill this" or "No cost". */
  cost: string;
  /** "Add 1 any-domain Power" or "See card text" when an effect has no short form. */
  effect: string;
  /** "Cost: effect" in one line. */
  summary: string;
}

/** Display text for an activated ability from its structured data (display only, no rules logic). */
export function describeAbility(def: CardDef, ability: ActivatedAbility): AbilityDescription {
  const parts: string[] = [];
  if (ability.cost.exhaust) parts.push('Exhaust');
  if (ability.cost.energy) parts.push(`${ability.cost.energy} Energy`);
  if (ability.cost.power)
    parts.push(`${ability.cost.power} Power (${def.domains.join(' or ') || 'any'})`);
  if (ability.cost.anyPower) parts.push(`${ability.cost.anyPower} Power (any Domain)`);
  if (ability.cost.card) parts.push(costCardText(ability.cost.card));
  if (ability.cost.killSelf) parts.push('Kill this');
  const cost = parts.length > 0 ? parts.join(', ') : 'No cost';
  const effects = ability.effects.map((e) => describeEffect(e, def));
  const effect = effects.every((s): s is string => s !== null)
    ? effects.join(', ')
    : 'See card text';
  return { cost, effect, summary: `${cost}: ${effect}` };
}

/** Description of ability `index` of `def`, or null when the card has no such ability. */
export function describeAbilityAt(
  def: CardDef | undefined,
  index: number,
): AbilityDescription | null {
  const a = def?.abilities?.[index];
  return def && a ? describeAbility(def, a) : null;
}

/**
 * Energy a Legion card is discounted by right now (812), for the cost display only; the engine
 * applies the real discount when the card is played.
 */
export function legionDiscount(
  view: ClientGameState,
  cards: CardDatabase,
  seat: PlayerId,
  objectId: string,
  cardId: string,
): number {
  const def = cards[cardId];
  // The discount reads only public information, so the sanitised view answers like the full state.
  return def ? selfEnergyDiscount(view as unknown as GameState, cards, seat, def, objectId) : 0;
}
