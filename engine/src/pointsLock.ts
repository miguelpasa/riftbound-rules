/**
 * "Opponents can't gain points" (Tianna Crownguard): a permanent whose controller is not `player`
 * carries a `NO_ENEMY_POINTS` static whose condition ("while I'm at a battlefield") holds.
 * Applies to scoring and to point-gaining card effects; the Burn Out point is not a card effect
 * and is left alone (docs/ASSUMPTIONS.md).
 */
import { evalCondition } from './conditions.js';
import type { CardDatabase, GameState, PlayerId } from './types/index.js';

export function pointsLocked(state: GameState, cards: CardDatabase, player: PlayerId): boolean {
  for (const o of Object.values(state.objects)) {
    if (o.controller === player) continue;
    const z = o.zone.kind;
    if (z !== 'base' && z !== 'battlefield') continue;
    for (const s of cards[o.cardId]?.statics ?? []) {
      if (s.restrict !== 'NO_ENEMY_POINTS') continue;
      if (!s.when || evalCondition(state, cards, s.when, o.controller, o.id)) return true;
    }
  }
  return false;
}
