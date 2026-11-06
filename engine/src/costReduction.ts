/**
 * Self cost reductions (R50): "I cost [N] less for each <thing>", "This costs [N] less if <condition>",
 * plus the Legion discount (812). One function answers "how much Energy is knocked off this card right now",
 * used by play.ts (the real payment), legalActions.ts (affordability) and the client (cost display).
 * Reads only public information (board, Trash, plays this turn).
 */
import { evalCondition } from './conditions.js';
import { effectiveMight } from './combat.js';
import { legionActive } from './keywords.js';
import { isUnitDef } from './tokens.js';
import { playerIndex } from './types/constants.js';
import type { CardDatabase, CardDef, CostCount, GameState, PlayerId } from './types/index.js';

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

/** Energy knocked off `def`'s cost for `pid` right now (Legion + the card's own `costReduction`). */
export function selfEnergyDiscount(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  def: CardDef,
  sourceId: string,
): number {
  let total = 0;
  if (def.legionCostReduction && legionActive(state, pid, sourceId))
    total += def.legionCostReduction;
  const r = def.costReduction;
  if (r) {
    let amount = 0;
    if (r.per) amount = r.energy * countFor(state, cards, pid, def, sourceId, r.per);
    else if (!r.when || evalCondition(state, cards, r.when, pid, sourceId)) amount = r.energy;
    if (r.min !== undefined)
      amount = Math.min(amount, Math.max(0, def.cost.energy - total - r.min));
    total += amount;
  }
  return total;
}
