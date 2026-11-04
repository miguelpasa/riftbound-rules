import { describe, expect, it } from 'vitest';
import { validateDeck } from '@riftbound/engine';
import type { CardDatabase } from '@riftbound/engine';
import { FIXTURE_CARDS, FIXTURE_DECK_A } from '../../../engine/src/testing/fixtures.js';
import { buildPresetDecks } from './presets.js';
import { FIXTURE_PRESETS } from './fixtureDecks.js';
import {
  importDeckList,
  loadCustomDeck,
  loadSelectedDeckId,
  saveCustomDeck,
  saveSelectedDeckId,
} from './deckStorage.js';

function memStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe('fixture presets', () => {
  it('are legal', () => {
    expect(FIXTURE_PRESETS).toHaveLength(2);
    for (const p of FIXTURE_PRESETS) {
      expect(validateDeck(FIXTURE_CARDS, p.deck).ok).toBe(true);
      expect(p.stats.fullSupportCount + p.stats.partialCount).toBe(40);
    }
  });
});

describe('buildPresetDecks (synthetic)', () => {
  it('builds legal, deterministic decks and reports skips', () => {
    const diagnostics: string[] = [];
    const a = buildPresetDecks(FIXTURE_CARDS, { seed: 's', diagnostics });
    const b = buildPresetDecks(FIXTURE_CARDS, { seed: 's' });
    expect(a).toEqual(b);
    for (const p of a) expect(validateDeck(FIXTURE_CARDS, p.deck).ok).toBe(true);
    expect(a.length + diagnostics.length).toBeGreaterThan(0);
  });

  it('skips with a diagnostic when no champion exists', () => {
    const cards: CardDatabase = {};
    for (const [id, c] of Object.entries(FIXTURE_CARDS)) {
      if (!c.subtypes.includes('Champion')) cards[id] = c;
    }
    const diagnostics: string[] = [];
    expect(buildPresetDecks(cards, { diagnostics })).toEqual([]);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});

describe('deckStorage', () => {
  it('round-trips selected id and custom deck', () => {
    const s = memStorage();
    expect(loadSelectedDeckId(s)).toBeNull();
    saveSelectedDeckId('x', s);
    expect(loadSelectedDeckId(s)).toBe('x');
    saveCustomDeck(FIXTURE_DECK_A, s);
    expect(loadCustomDeck(s)).toEqual(FIXTURE_DECK_A);
  });

  it('survives a throwing storage', () => {
    const boom = (): never => {
      throw new Error('x');
    };
    const bad = { getItem: boom, setItem: boom, removeItem: boom };
    saveSelectedDeckId('x', bad);
    expect(loadSelectedDeckId(bad)).toBeNull();
  });

  it('imports valid and rejects invalid decks', () => {
    expect(importDeckList(JSON.stringify(FIXTURE_DECK_A), FIXTURE_CARDS).ok).toBe(true);
    expect(importDeckList({ ...FIXTURE_DECK_A, mainDeck: ['fx-grunt'] }, FIXTURE_CARDS).ok).toBe(
      false,
    );
    expect(importDeckList('{nope', FIXTURE_CARDS).ok).toBe(false);
    expect(importDeckList({ legendId: 1 }, FIXTURE_CARDS).ok).toBe(false);
  });
});

const realFiles = import.meta.glob<CardDatabase>('../../public/cards.json', {
  import: 'default',
});
const loadReal = Object.values(realFiles)[0];
describe.skipIf(!loadReal)('buildPresetDecks (real cards.json)', () => {
  it('produces legal presets', async () => {
    const cards = await loadReal!();
    const presets = buildPresetDecks(cards);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) expect(validateDeck(cards, p.deck).ok).toBe(true);
  });
});
