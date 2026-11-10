import { describe, it, expect } from 'vitest';
import { validateDeck } from './deckValidation.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import type { CardDatabase, CardDef, DeckList } from './types/index.js';

const errorsOf = (deck: DeckList, cards: CardDatabase = FIXTURE_CARDS): string[] => {
  const r = validateDeck(cards, deck);
  return r.ok ? [] : r.errors;
};
const withMain = (main: string[]): DeckList => ({ ...FIXTURE_DECK_A, mainDeck: main });
const card = (id: string): CardDef => FIXTURE_CARDS[id] as CardDef;
const without = (arr: string[], id: string): string[] => arr.filter((c) => c !== id);

describe('validateDeck', () => {
  it('accepts both fixture decks', () => {
    // Tests Rule 103: legal decks pass
    expect(validateDeck(FIXTURE_CARDS, FIXTURE_DECK_A)).toEqual({ ok: true });
    expect(validateDeck(FIXTURE_CARDS, FIXTURE_DECK_B)).toEqual({ ok: true });
  });

  it('returns DECK_ILLEGAL code on failure', () => {
    // Tests Rule 103: illegal decks are reported with DECK_ILLEGAL
    const r = validateDeck(FIXTURE_CARDS, { ...FIXTURE_DECK_A, mainDeck: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DECK_ILLEGAL');
  });

  it('rejects a main deck below 40 cards including the champion', () => {
    // Tests Rule 103.3.b: minimum deck size counts the Chosen Champion
    expect(errorsOf(withMain(FIXTURE_DECK_A.mainDeck.slice(1))).join()).toMatch(/at least 40/);
    expect(errorsOf(withMain([...FIXTURE_DECK_A.mainDeck, 'fx-titan']))).toEqual([]);
  });

  it('rejects more than 3 copies, counting the champion', () => {
    // Tests Rule 103.3.b: max 3 copies of a name including the Chosen Champion
    const main = [...FIXTURE_DECK_A.mainDeck, 'fx-champ-ember', 'fx-champ-ember', 'fx-champ-ember'];
    expect(errorsOf(withMain(main)).join()).toMatch(/Too many copies of "Emberlord Kass": 4/);
    const four = [...FIXTURE_DECK_A.mainDeck, 'fx-grunt'];
    expect(errorsOf(withMain(four)).join()).toMatch(/Too many copies of "Cinder Grunt": 4/);
  });

  it('rejects cards outside the domain identity but allows domainless ones', () => {
    // Tests Rule 103.2.b: domain identity subset, domainless allowed (103.2.b.5)
    const bad = withMain([...FIXTURE_DECK_A.mainDeck.slice(1), 'fx-tide-grunt']);
    expect(errorsOf(bad).join()).toMatch(/Tide Scholar.*Domain Identity/);
    expect(errorsOf(FIXTURE_DECK_A)).toEqual([]);
    expect(card('fx-wisp').domains).toEqual([]);
  });

  it('rejects a champion that is not a Champion unit or has the wrong tag', () => {
    // Tests Rule 103.3.a: Chosen Champion must be a Champion unit with the Legend tag
    expect(errorsOf({ ...FIXTURE_DECK_A, championId: 'fx-grunt' }).join()).toMatch(/Champion UNIT/);
    expect(errorsOf({ ...FIXTURE_DECK_A, championId: 'fx-champ-tide' }).join()).toMatch(/tag/);
    const cards: CardDatabase = {
      ...FIXTURE_CARDS,
      'fx-champ-ember': { ...card('fx-champ-ember'), subtypes: ['Champion', 'Other'] },
    };
    expect(errorsOf(FIXTURE_DECK_A, cards).join()).toMatch(/Legend's tag/);
  });

  it('matches tags case-insensitively', () => {
    // Tests Rule 103.3.a.2: tag match is case-insensitive
    const cards: CardDatabase = {
      ...FIXTURE_CARDS,
      'fx-champ-ember': { ...card('fx-champ-ember'), subtypes: ['champion', 'EMBER'] },
    };
    expect(validateDeck(cards, FIXTURE_DECK_A).ok).toBe(true);
  });

  it('rejects a non-legend legend', () => {
    // Tests Rule 103.2: the legend slot must hold a LEGEND
    expect(errorsOf({ ...FIXTURE_DECK_A, legendId: 'fx-grunt' }).join()).toMatch(/not a LEGEND/);
  });

  it('limits Signature cards to 3 and requires the champion tag', () => {
    // Tests Rule 103.3.d: at most 3 Signature cards, tagged for the champion
    const base = without(FIXTURE_DECK_A.mainDeck, 'fx-ember-sig');
    const four = withMain([
      ...base,
      'fx-ember-sig',
      'fx-ember-sig',
      'fx-ember-sig',
      'fx-ember-sig',
    ]);
    expect(errorsOf(four).join()).toMatch(/At most 3 Signature/);
    const wrong = withMain([...base, 'fx-tide-sig']);
    expect(errorsOf(wrong).join()).toMatch(/Signature card "Tidecaller Gambit" does not match/);
  });

  it('requires exactly 12 identity runes', () => {
    // Tests Rule 103.4.a: exactly 12 runes, all inside the Domain Identity
    const short = { ...FIXTURE_DECK_A, runeDeck: FIXTURE_DECK_A.runeDeck.slice(1) };
    expect(errorsOf(short).join()).toMatch(/exactly 12/);
    const off = [...FIXTURE_DECK_A.runeDeck.slice(1), 'fx-rune-mind'];
    expect(errorsOf({ ...FIXTURE_DECK_A, runeDeck: off }).join()).toMatch(
      /Mind Rune.*Domain Identity/,
    );
    const notRune = [...FIXTURE_DECK_A.runeDeck.slice(1), 'fx-grunt'];
    expect(errorsOf({ ...FIXTURE_DECK_A, runeDeck: notRune }).join()).toMatch(/not a RUNE/);
  });

  it('requires exactly 3 distinct battlefields of type BATTLEFIELD', () => {
    // Tests Rule 487.4.a: three distinct battlefields (Rule 103.5.c)
    const two = { ...FIXTURE_DECK_A, battlefields: ['fx-bf-1', 'fx-bf-2'] };
    expect(errorsOf(two).join()).toMatch(/Exactly 3/);
    const dup = { ...FIXTURE_DECK_A, battlefields: ['fx-bf-1', 'fx-bf-1', 'fx-bf-2'] };
    expect(errorsOf(dup).join()).toMatch(/Duplicate battlefield/);
    const wrong = { ...FIXTURE_DECK_A, battlefields: ['fx-bf-1', 'fx-bf-2', 'fx-grunt'] };
    expect(errorsOf(wrong).join()).toMatch(/not a BATTLEFIELD/);
  });

  it('forbids rune, legend, battlefield and token cards in the main deck', () => {
    // Tests Rule 103.3: only playable main-deck card types
    const extra = ['fx-rune-fury', 'fx-legend-ember', 'fx-bf-1', 'fx-token'];
    const cards: CardDatabase = {
      ...FIXTURE_CARDS,
      'fx-token': { ...card('fx-grunt'), cardId: 'fx-token', name: 'Tok', type: 'TOKEN' },
    };
    const e = errorsOf(withMain([...FIXTURE_DECK_A.mainDeck, ...extra]), cards).join();
    expect(e).toMatch(/\(RUNE\) cannot be in the main deck/);
    expect(e).toMatch(/\(LEGEND\) cannot/);
    expect(e).toMatch(/\(BATTLEFIELD\) cannot/);
    expect(e).toMatch(/\(TOKEN\) cannot/);
  });

  it('reports unknown card ids', () => {
    // Tests Rule 103: every card must exist in the card database
    const deck = { ...FIXTURE_DECK_A, mainDeck: [...FIXTURE_DECK_A.mainDeck, 'nope'] };
    expect(errorsOf(deck).join()).toMatch(/Unknown card id "nope"/);
  });

  it('allows only one copy of a Unique card', () => {
    // Tests Rule 103.3: Unique cards are limited to one copy
    const cards: CardDatabase = {
      ...FIXTURE_CARDS,
      'fx-grunt': { ...card('fx-grunt'), keywords: [{ name: 'Unique' }] },
    };
    expect(errorsOf(FIXTURE_DECK_A, cards).join()).toMatch(/"Cinder Grunt" is Unique/);
  });

  it('collects all errors instead of stopping at the first', () => {
    // Tests Rule 103: all violations are reported together
    const e = errorsOf({
      ...FIXTURE_DECK_A,
      mainDeck: ['fx-grunt', 'nope'],
      runeDeck: [],
      battlefields: [],
    });
    expect(e.length).toBeGreaterThanOrEqual(4);
  });
});

describe('validateDeck: "Your deck can have any number of cards named X" (Spiderling)', () => {
  it('lifts the 3-copy limit for the named card only', () => {
    // Tests Rule 103.3.b: a card can lift the copy limit for itself
    const db: CardDatabase = {
      ...FIXTURE_CARDS,
      'fx-grunt': { ...card('fx-grunt'), unlimitedCopies: true },
    };
    const many = [...FIXTURE_DECK_A.mainDeck, 'fx-grunt', 'fx-grunt', 'fx-grunt'];
    expect(errorsOf(withMain(many), db)).toEqual([]); // 6+ copies are fine
    expect(errorsOf(withMain(many)).join()).toMatch(/Too many copies of "Cinder Grunt"/);
    const other = [...FIXTURE_DECK_A.mainDeck, 'fx-archer', 'fx-archer', 'fx-archer'];
    expect(errorsOf(withMain(other), db).join()).toMatch(/Too many copies of "Flame Archer"/);
  });
});
