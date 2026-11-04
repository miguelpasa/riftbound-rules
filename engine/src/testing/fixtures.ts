/**
 * SYNTHETIC test fixtures (invented names; not real Riftbound card text). Stable API for other tests.
 *
 * Exports:
 * - FIXTURE_CARDS: CardDatabase (keyed by cardId, all ids prefixed `fx-`).
 * - FIXTURE_DECK_A: Fury/Calm, legend `fx-legend-ember`, champion `fx-champ-ember`.
 * - FIXTURE_DECK_B: Mind/Order, legend `fx-legend-tide`, champion `fx-champ-tide`.
 *   Each deck = 39 mainDeck cards + the champion (40 total), 12 runes, 3 battlefields; both are legal.
 * - makeTestGame(seed = 'test'): GameState with the mulligan skipped: phase MAIN, step NONE, turn 1,
 *   p0 active, 4-card hands, no priority/focus. Decks are [A, B] but the RNG may swap which deck is p0
 *   (use getObjectByCardId rather than assuming).
 * - getObjectByCardId(state, cardId, owner?): first CardInstance (lowest object number) of that card.
 *
 * Notable card ids (cost in energy / might):
 *   units: fx-grunt (Fury 2/2), fx-ash-tank (Fury 3/3 Tank), fx-archer (Fury 2/2 Backline),
 *     fx-raider (Fury 2/2 Assault 1), fx-shielder (Calm 2/2 Shield 1), fx-ganker (Calm 3/3 Ganking),
 *     fx-wisp (colorless 1/0), fx-titan (Calm 5/7, power Calm 1), fx-tide-grunt (Mind 2/2),
 *     fx-tide-archer (Mind 2/2 Backline), fx-order-tank (Order 3/3 Tank), fx-order-shielder (Order 2/2 Shield 1),
 *     fx-tide-ganker (Mind 3/3 Ganking), fx-order-titan (Order 5/7), fx-body-brute (Body 3/3), fx-chaos-imp (Chaos 2/2)
 *   spells: fx-flare (Fury Action 1), fx-ward (Calm Reaction 1), fx-tide-surge (Mind Action 1),
 *     fx-tide-guard (Order Reaction 1), fx-plain-spell (colorless 2), fx-odd-reaction (Reaction, partial),
 *     fx-ember-sig / fx-tide-sig (Signature)
 *   gear: fx-blade (Equipment, colorless 1, Equip), fx-ember-totem (Fury), fx-tide-totem (Order)
 *   runes: fx-rune-<domain lowercase>; battlefields: fx-bf-1..fx-bf-6 (A uses 1-3, B uses 4-6)
 */
import { DOMAINS } from '../types/card.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  DeckList,
  Domain,
  GameState,
  KeywordInstance,
  PlayerId,
} from '../types/index.js';
import { createGame } from '../setup.js';

const cards: CardDatabase = {};

function add(def: Partial<CardDef> & Pick<CardDef, 'cardId' | 'name' | 'type'>): void {
  cards[def.cardId] = {
    subtypes: [],
    cost: { energy: 0 },
    domains: [],
    stats: {},
    keywords: [],
    text: '',
    supportLevel: 'full',
    ...def,
  };
}

function unit(
  cardId: string,
  name: string,
  domains: Domain[],
  energy: number,
  might: number,
  keywords: KeywordInstance[] = [],
  extra: Partial<CardDef> = {},
): void {
  add({
    cardId,
    name,
    type: 'UNIT',
    domains,
    cost: { energy },
    stats: { might },
    keywords,
    ...extra,
  });
}

// Legends and champions
add({
  cardId: 'fx-legend-ember',
  name: 'Ember Seer',
  type: 'LEGEND',
  subtypes: ['Ember'],
  domains: ['Fury', 'Calm'],
});
add({
  cardId: 'fx-legend-tide',
  name: 'Tide Oracle',
  type: 'LEGEND',
  subtypes: ['Tide'],
  domains: ['Mind', 'Order'],
});
unit('fx-champ-ember', 'Emberlord Kass', ['Fury'], 4, 5, [], { subtypes: ['Champion', 'Ember'] });
unit('fx-champ-tide', 'Tidecaller Nor', ['Mind'], 4, 5, [], { subtypes: ['Champion', 'Tide'] });

// Units
unit('fx-grunt', 'Cinder Grunt', ['Fury'], 2, 2);
unit('fx-ash-tank', 'Ash Bulwark', ['Fury'], 3, 3, [{ name: 'Tank' }]);
unit('fx-archer', 'Flame Archer', ['Fury'], 2, 2, [{ name: 'Backline' }]);
unit('fx-raider', 'Spark Raider', ['Fury'], 2, 2, [{ name: 'Assault', value: 1 }]);
unit('fx-shielder', 'Dune Shielder', ['Calm'], 2, 2, [{ name: 'Shield', value: 1 }]);
unit('fx-ganker', 'Dune Stalker', ['Calm'], 3, 3, [{ name: 'Ganking' }]);
unit('fx-wisp', 'Hollow Wisp', [], 1, 0);
unit('fx-titan', 'Dune Titan', ['Calm'], 5, 7, [], {
  cost: { energy: 5, power: 1, domain: [{ element: 'Calm', amount: 1 }] },
});
unit('fx-tide-grunt', 'Tide Scholar', ['Mind'], 2, 2);
unit('fx-tide-archer', 'Tide Lookout', ['Mind'], 2, 2, [{ name: 'Backline' }]);
unit('fx-order-tank', 'Order Warden', ['Order'], 3, 3, [{ name: 'Tank' }]);
unit('fx-order-shielder', 'Order Guard', ['Order'], 2, 2, [{ name: 'Shield', value: 1 }]);
unit('fx-tide-ganker', 'Tide Skirmisher', ['Mind'], 3, 3, [{ name: 'Ganking' }]);
unit('fx-order-titan', 'Order Colossus', ['Order'], 5, 7);
unit('fx-body-brute', 'Stone Brute', ['Body'], 3, 3);
unit('fx-chaos-imp', 'Rift Imp', ['Chaos'], 2, 2);

// Spells
const spell = (
  cardId: string,
  name: string,
  domains: Domain[],
  energy: number,
  kw: KeywordInstance[],
  extra: Partial<CardDef> = {},
): void => add({ cardId, name, type: 'SPELL', domains, cost: { energy }, keywords: kw, ...extra });
spell('fx-flare', 'Flare Bolt', ['Fury'], 1, [{ name: 'Action' }], { text: '[Action]' });
spell('fx-ward', 'Quick Ward', ['Calm'], 1, [{ name: 'Reaction' }], { text: '[Reaction]' });
spell('fx-tide-surge', 'Tide Surge', ['Mind'], 1, [{ name: 'Action' }], { text: '[Action]' });
spell('fx-tide-guard', 'Tidal Guard', ['Order'], 1, [{ name: 'Reaction' }], { text: '[Reaction]' });
spell('fx-plain-spell', 'Plain Chant', [], 2, []);
spell('fx-odd-reaction', 'Odd Whisper', [], 1, [{ name: 'Reaction' }], {
  text: '[Reaction] Swap the might of two units, then conjure a mirror.',
  supportLevel: 'partial',
});
spell('fx-ember-sig', 'Emberlord Rally', ['Fury'], 3, [], { subtypes: ['Signature', 'Ember'] });
spell('fx-tide-sig', 'Tidecaller Gambit', ['Mind'], 3, [], { subtypes: ['Signature', 'Tide'] });

// Gear
add({
  cardId: 'fx-blade',
  name: 'Practice Blade',
  type: 'GEAR',
  subtypes: ['Equipment'],
  cost: { energy: 1 },
  keywords: [{ name: 'Equip' }],
  text: '[Equip]',
});
add({
  cardId: 'fx-ember-totem',
  name: 'Ember Totem',
  type: 'GEAR',
  domains: ['Fury'],
  cost: { energy: 2 },
});
add({
  cardId: 'fx-tide-totem',
  name: 'Order Totem',
  type: 'GEAR',
  domains: ['Order'],
  cost: { energy: 2 },
});

// Runes (one per Domain) and battlefields
for (const d of DOMAINS) {
  add({ cardId: `fx-rune-${d.toLowerCase()}`, name: `${d} Rune`, type: 'RUNE', domains: [d] });
}
for (let i = 1; i <= 6; i++) {
  add({ cardId: `fx-bf-${i}`, name: `Test Battlefield ${i}`, type: 'BATTLEFIELD' });
}

/** The synthetic card database. */
export const FIXTURE_CARDS: CardDatabase = cards;

function expand(entries: [string, number][]): string[] {
  return entries.flatMap(([id, n]) => Array.from({ length: n }, () => id));
}

/** Legal Fury/Calm deck (champion + 39 main cards = 40). */
export const FIXTURE_DECK_A: DeckList = {
  legendId: 'fx-legend-ember',
  championId: 'fx-champ-ember',
  mainDeck: expand([
    ['fx-grunt', 3],
    ['fx-ash-tank', 3],
    ['fx-archer', 3],
    ['fx-raider', 3],
    ['fx-shielder', 3],
    ['fx-ganker', 3],
    ['fx-wisp', 3],
    ['fx-titan', 2],
    ['fx-flare', 3],
    ['fx-ward', 3],
    ['fx-plain-spell', 3],
    ['fx-odd-reaction', 2],
    ['fx-ember-sig', 1],
    ['fx-blade', 3],
    ['fx-ember-totem', 1],
  ]),
  runeDeck: expand([
    ['fx-rune-fury', 6],
    ['fx-rune-calm', 6],
  ]),
  battlefields: ['fx-bf-1', 'fx-bf-2', 'fx-bf-3'],
};

/** Legal Mind/Order deck (champion + 39 main cards = 40). */
export const FIXTURE_DECK_B: DeckList = {
  legendId: 'fx-legend-tide',
  championId: 'fx-champ-tide',
  mainDeck: expand([
    ['fx-tide-grunt', 3],
    ['fx-tide-archer', 3],
    ['fx-order-tank', 3],
    ['fx-order-shielder', 3],
    ['fx-wisp', 3],
    ['fx-tide-ganker', 3],
    ['fx-order-titan', 2],
    ['fx-tide-surge', 3],
    ['fx-tide-guard', 3],
    ['fx-plain-spell', 3],
    ['fx-odd-reaction', 3],
    ['fx-tide-sig', 1],
    ['fx-blade', 3],
    ['fx-tide-totem', 3],
  ]),
  runeDeck: expand([
    ['fx-rune-mind', 6],
    ['fx-rune-order', 6],
  ]),
  battlefields: ['fx-bf-4', 'fx-bf-5', 'fx-bf-6'],
};

/** Game with the mulligan skipped: MAIN phase, turn 1, p0 active, 4-card hands. */
export function makeTestGame(seed = 'test'): GameState {
  const state = createGame(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], seed);
  state.mulligan = null;
  state.turn = { number: 1, activePlayer: 'p0', phase: 'MAIN', step: 'NONE' };
  return state;
}

/** First object (lowest object number) with this cardId, optionally restricted to an owner. */
export function getObjectByCardId(
  state: GameState,
  cardId: string,
  owner?: PlayerId,
): CardInstance | undefined {
  return Object.values(state.objects)
    .filter((o) => o.cardId === cardId && (owner === undefined || o.owner === owner))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))[0];
}
