import { getAbilityActivations, getLegalActions } from '@riftbound/engine';
import type { CardDatabase, GameState, Intent, PlayerId } from '@riftbound/engine';

/**
 * The legal-intent hints shown to a human: `getLegalActions` plus the [Add] ability activations
 * (Gold, Seals...), which the bot-oriented list leaves out. Chain abilities are already in
 * `getLegalActions`, so entries are deduplicated by source and ability index (R40).
 */
export function getUiLegalActions(state: GameState, cards: CardDatabase, seat: PlayerId): Intent[] {
  const legal = getLegalActions(state, cards, seat);
  const key = (i: Intent): string =>
    i.type === 'ACTIVATE_ABILITY' ? `${i.sourceId}:${i.abilityIndex}` : '';
  const have = new Set(legal.filter((i) => i.type === 'ACTIVATE_ABILITY').map(key));
  const extra = getAbilityActivations(state, cards, seat).filter((i) => !have.has(key(i)));
  return [...legal, ...extra];
}
