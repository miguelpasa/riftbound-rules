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

/**
 * The Gold gear token: a TOKEN without Might is a gear-like permanent. Its one ability is the
 * reminder text printed on every Gold card: "[Reaction][>] Kill this, [E]: [Add] [A]."
 */
const GOLD: CardDef = {
  cardId: 'tok-gold',
  name: 'Gold token',
  type: 'TOKEN',
  subtypes: ['Gold'],
  cost: { energy: 0 },
  domains: [],
  stats: {},
  keywords: [],
  text: '[Reaction][>] Kill this, [E]: [Add] [A].',
  supportLevel: 'full',
  abilities: [
    {
      cost: { exhaust: true, killSelf: true },
      reaction: true,
      effects: [{ op: 'ADD_POWER', amount: 1, domain: 'ANY' }],
    },
  ],
};

/**
 * The Bomb gear token (Ziggs, Amateur Demolitionist, ...): "It has [Deploy]. When it dies, deal 2 to an enemy
 * there and kill your other Bombs there." It stands at a battlefield.
 */
const BOMB: CardDef = {
  cardId: 'tok-bomb',
  name: 'Bomb token',
  type: 'TOKEN',
  subtypes: ['Bomb'],
  cost: { energy: 0 },
  domains: [],
  stats: {},
  keywords: [{ name: 'Deploy' }],
  text: '[Deploy] When I die, deal 2 to an enemy there and kill your other Bombs there.',
  supportLevel: 'full',
  triggers: [
    {
      on: 'GEAR_LEAVES',
      effects: [
        { op: 'DAMAGE_TARGET', amount: 2, side: 'enemy', here: true, count: { min: 0, max: 1 } },
        { op: 'KILL_GEARS_HERE', subtype: 'Bomb' },
      ],
    },
  ],
};

export const GOLD_TOKEN_ID = 'tok-gold';
export const BOMB_TOKEN_ID = 'tok-bomb';

/** Gear, or a token without Might (a gear-like permanent such as Gold). */
export const isGearDef = (def: CardDef | undefined): boolean =>
  def !== undefined &&
  (def.type === 'GEAR' || (def.type === 'TOKEN' && def.stats.might === undefined));

/** R85: a Deploy gear: played only to a battlefield, where it stays instead of being recalled. */
export const isDeployGear = (def: CardDef | undefined): boolean =>
  (def?.type === 'GEAR' || def?.type === 'TOKEN') && def.keywords.some((k) => k.name === 'Deploy');

export const TOKEN_CARDS: CardDatabase = Object.fromEntries(
  [
    token('tok-recruit', 'Recruit', 1),
    token('tok-tentacle', 'Tentacle', 1),
    token('tok-sprite', 'Sprite', 3, [{ name: 'Temporary' }]),
    token('tok-bird', 'Bird', 1, [{ name: 'Deflect' }]),
    token('tok-mech', 'Mech', 3),
    token('tok-sand-soldier', 'Sand Soldier', 2),
    token('tok-shadow-clone', 'Shadow Clone', 0),
    GOLD,
    BOMB,
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
