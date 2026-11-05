import type { CardDatabase, DeckList } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';

/**
 * Test-only: the engine fixture cards re-keyed to the real id shape ("tst-001-100") so deck codes
 * ("TST-001") can be resolved. No real card data is used.
 */
const ids = Object.keys(FIXTURE_CARDS);
export const CODE_OF: Record<string, string> = {};
export const ID_OF: Record<string, string> = {};
export const IMPORT_CARDS: CardDatabase = {};
ids.forEach((id, i) => {
  const num = String(i + 1).padStart(3, '0');
  const newId = `tst-${num}-100`;
  CODE_OF[id] = `TST-${num}`;
  ID_OF[id] = newId;
  IMPORT_CARDS[newId] = { ...FIXTURE_CARDS[id]!, cardId: newId };
});

export const mapDeck = (d: DeckList): DeckList => ({
  legendId: ID_OF[d.legendId]!,
  championId: ID_OF[d.championId]!,
  mainDeck: d.mainDeck.map((x) => ID_OF[x]!),
  runeDeck: d.runeDeck.map((x) => ID_OF[x]!),
  battlefields: d.battlefields.map((x) => ID_OF[x]!),
});

export const IMPORT_DECK_A = mapDeck(FIXTURE_DECK_A);
export const IMPORT_DECK_B = mapDeck(FIXTURE_DECK_B);

interface ShareCardJson {
  code: string;
  qty: number;
  zone: string;
  name?: string;
}

function count(ids: string[], zone: string): ShareCardJson[] {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m].map(([id, qty]) => ({
    code: id.split('-').slice(0, 2).join('-').toUpperCase(),
    qty,
    zone,
    name: IMPORT_CARDS[id]!.name,
  }));
}

/** A deck in the deck builder's "riftbound-deck" v1 shape, built from one of the fixture decks. */
export function shareDeck(src: DeckList, name: string, extra: Record<string, unknown> = {}) {
  return {
    format: 'riftbound-deck',
    version: 1,
    name,
    legend: src.legendId.split('-').slice(0, 2).join('-').toUpperCase(),
    cards: [
      ...count([src.legendId], 'LEGEND'),
      ...count([src.championId], 'CHAMPION'),
      ...count(src.mainDeck, 'MAIN'),
      ...count(src.runeDeck, 'RUNE'),
      ...count(src.battlefields, 'BATTLEFIELD'),
    ] as ShareCardJson[],
    ...extra,
  };
}
