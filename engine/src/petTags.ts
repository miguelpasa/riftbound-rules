/** The pet tags Bird, Cat, Dog and Poro (Friendship, Daisy!, Undying Loyalty). */
import { isUnitDef } from './tokens.js';
import type { CardDatabase, GameState, PlayerId } from './types/index.js';

const PET_TAGS = ['bird', 'cat', 'dog', 'poro'];

/** How many of the tags Bird, Cat, Dog and Poro appear among `pid`'s units on the board (each counted once). */
export function petTagCount(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  exceptId = '',
): number {
  const seen = new Set<string>();
  for (const o of Object.values(state.objects)) {
    if (o.controller !== pid || o.id === exceptId) continue;
    if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
    const d = cards[o.cardId];
    if (!isUnitDef(d)) continue;
    for (const t of d.subtypes) if (PET_TAGS.includes(t.toLowerCase())) seen.add(t.toLowerCase());
  }
  return seen.size;
}
