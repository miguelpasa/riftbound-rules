/**
 * Token definitions (rule 186, R3 round 2). The card database has no unit tokens, so the engine
 * ships a small table of them, keyed by the name printed in the effect text ("Play a 1 [M] Recruit
 * unit token", "Play a ready 3 [M] Sprite unit token with [Temporary]").
 *
 * A token is a CardDef of type 'TOKEN' with `stats.might` (a unit-like permanent). Its synthetic
 * cardId ('tok-...') must exist in the CardDatabase handed to `reduce`: `scripts/build-cards.ts`
 * adds TOKEN_CARDS to cards.json and `loadCards` merges them in when an old file lacks them.
 * A token outside the Board ceases to exist (186.1, handled by the kill paths).
 */
import type { CardDatabase, CardDef, KeywordInstance } from './types/card.js';

function token(
  cardId: string,
  name: string,
  might: number,
  keywords: KeywordInstance[] = [],
): CardDef {
  return {
    cardId,
    name: `${name} token`,
    type: 'TOKEN',
    subtypes: [name],
    cost: { energy: 0 },
    domains: [],
    stats: { might },
    keywords,
    text: keywords.map((k) => `[${k.name}]`).join(' '),
    supportLevel: 'full',
  };
}

export const TOKEN_CARDS: CardDatabase = Object.fromEntries(
  [
    token('tok-recruit', 'Recruit', 1),
    token('tok-sprite', 'Sprite', 3, [{ name: 'Temporary' }]),
    token('tok-bird', 'Bird', 1, [{ name: 'Deflect' }]),
    token('tok-mech', 'Mech', 3),
    token('tok-sand-soldier', 'Sand Soldier', 2),
  ].map((c) => [c.cardId, c]),
);

/** The token definition for "<might> [M] <name> unit token [with [Keyword]]", if one exists. */
export function tokenIdFor(name: string, might: number, keyword?: string): string | undefined {
  const want = keyword ? keyword.toLowerCase() : undefined;
  return Object.values(TOKEN_CARDS).find((c) => {
    if (c.subtypes[0]?.toLowerCase() !== name.toLowerCase() || c.stats.might !== might)
      return false;
    const kws = c.keywords.map((k) => k.name.toLowerCase());
    return want === undefined ? kws.length === 0 : kws.length === 1 && kws[0] === want;
  })?.cardId;
}

/** A Unit, or a token with Might (a unit-like permanent that can move, fight and be targeted). */
export const isUnitDef = (def: CardDef | undefined): def is CardDef =>
  def !== undefined &&
  (def.type === 'UNIT' || (def.type === 'TOKEN' && def.stats.might !== undefined));
