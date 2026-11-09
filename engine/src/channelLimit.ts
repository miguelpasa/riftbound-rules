/**
 * "Players only channel 1 rune at the start of their Channel Phase" (Sandstone Chimera): a permanent on
 * the board carries a `ONE_CHANNEL` static whose condition ("while I'm at a battlefield") holds.
 * It limits the Channel Phase only, not runes channeled by card effects.
 */
import { evalCondition } from './conditions.js';
import type { CardDatabase, GameState } from './types/index.js';

export function channelLimited(state: GameState, cards: CardDatabase): boolean {
  for (const o of Object.values(state.objects)) {
    const z = o.zone.kind;
    if (z !== 'base' && z !== 'battlefield') continue;
    for (const s of cards[o.cardId]?.statics ?? []) {
      if (s.restrict !== 'ONE_CHANNEL') continue;
      if (!s.when || evalCondition(state, cards, s.when, o.controller, o.id)) return true;
    }
  }
  return false;
}
