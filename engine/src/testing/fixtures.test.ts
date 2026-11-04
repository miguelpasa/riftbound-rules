import { describe, it, expect } from 'vitest';
import { validateDeck } from '../deckValidation.js';
import { DOMAINS } from '../types/card.js';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
  getObjectByCardId,
  makeTestGame,
} from './fixtures.js';

describe('fixtures', () => {
  it('provides two legal 40-card decks', () => {
    // Tests Rule 103: fixture decks satisfy deck construction
    for (const d of [FIXTURE_DECK_A, FIXTURE_DECK_B]) {
      expect(validateDeck(FIXTURE_CARDS, d)).toEqual({ ok: true });
      expect(d.mainDeck.length + 1).toBe(40);
      expect(d.runeDeck).toHaveLength(12);
      expect(d.battlefields).toHaveLength(3);
    }
  });

  it('covers the required card variety', () => {
    // Tests Rule 100: fixtures exercise keywords, types and domains
    const all = Object.values(FIXTURE_CARDS);
    const kw = (n: string): boolean => all.some((c) => c.keywords.some((k) => k.name === n));
    for (const n of [
      'Tank',
      'Backline',
      'Assault',
      'Shield',
      'Ganking',
      'Action',
      'Reaction',
      'Equip',
    ]) {
      expect(kw(n)).toBe(true);
    }
    expect(all.some((c) => c.type === 'UNIT' && c.stats.might === 0)).toBe(true);
    expect(all.some((c) => c.type === 'UNIT' && c.cost.energy === 5)).toBe(true);
    expect(all.some((c) => c.supportLevel === 'partial')).toBe(true);
    expect(all.some((c) => c.subtypes.includes('Equipment'))).toBe(true);
    expect(all.filter((c) => c.type === 'LEGEND')).toHaveLength(2);
    expect(all.filter((c) => c.type === 'BATTLEFIELD')).toHaveLength(6);
    const runeDomains = all.filter((c) => c.type === 'RUNE').flatMap((c) => c.domains);
    expect([...runeDomains].sort()).toEqual([...DOMAINS].sort());
    for (const [id, c] of Object.entries(FIXTURE_CARDS)) expect(c.cardId).toBe(id);
  });

  it('makeTestGame skips the mulligan', () => {
    // Tests Rule 117: test games start in the MAIN phase of turn 1
    const s = makeTestGame();
    expect(s.turn).toEqual({ number: 1, activePlayer: 'p0', phase: 'MAIN', step: 'NONE' });
    expect(s.mulligan).toBeNull();
    expect(s.players[0].hand).toHaveLength(4);
    expect(makeTestGame('x')).toEqual(makeTestGame('x'));
  });

  it('getObjectByCardId finds objects, optionally by owner', () => {
    // Tests Rule 107: lookup of card instances
    const s = makeTestGame();
    expect(getObjectByCardId(s, 'fx-wisp')?.cardId).toBe('fx-wisp');
    expect(getObjectByCardId(s, 'fx-wisp', 'p1')?.owner).toBe('p1');
    expect(getObjectByCardId(s, 'nope')).toBeUndefined();
  });
});
