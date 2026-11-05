import type { CardDatabase } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import type { PresetDeck } from './presets.js';
import { deckSupportStats } from './deckImport.js';

export { FIXTURE_CARDS };

function wrap(id: string, name: string, deck: PresetDeck['deck'], cards: CardDatabase): PresetDeck {
  const all = [deck.championId, ...deck.mainDeck].map((cid) => cards[cid]);
  const support = deckSupportStats(deck, cards);
  const energy = all.reduce((s, c) => s + (c?.cost.energy ?? 0), 0);
  return {
    id,
    name,
    legendId: deck.legendId,
    deck,
    stats: {
      fullSupportCount: support.full,
      partialCount: support.partial,
      totalCount: support.total,
      avgEnergy: Math.round((energy / all.length) * 100) / 100,
    },
  };
}

/** Synthetic presets for tests, tutorial and dev fallback when cards.json lacks data. */
export const FIXTURE_PRESETS: PresetDeck[] = [
  wrap('fixture-ember', 'Ember (Fury/Calm)', FIXTURE_DECK_A, FIXTURE_CARDS),
  wrap('fixture-tide', 'Tide (Mind/Order)', FIXTURE_DECK_B, FIXTURE_CARDS),
];
