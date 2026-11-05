import { describe, expect, it } from 'vitest';
import type { CardDatabase } from '@riftbound/engine';
import {
  deckContentKey,
  deckSupportStats,
  importDecks,
  isLowSupport,
  makeCardResolver,
  parseCode,
} from './deckImport';
import { CODE_OF, IMPORT_CARDS, IMPORT_DECK_A, IMPORT_DECK_B, shareDeck } from './importFixtures';

describe('parseCode', () => {
  it('normalises case and padding and keeps the letter suffix', () => {
    expect(parseCode('ogn-7')).toEqual({ set: 'ogn', num: '007', letter: '' });
    expect(parseCode('OGN-042a')).toEqual({ set: 'ogn', num: '042', letter: 'a' });
    expect(parseCode('nope')).toBeNull();
  });
});

describe('makeCardResolver', () => {
  const mk = (name: string, id: string) =>
    ({ ...IMPORT_CARDS[Object.keys(IMPORT_CARDS)[0]!]!, cardId: id, name }) as CardDatabase[string];
  const db: CardDatabase = {
    'ogn-042-298': mk('Base Card', 'ogn-042-298'),
    'ogn-042a-298': mk('Alt Art', 'ogn-042a-298'),
    'ogn-007-298': mk('Lone', 'ogn-007-298'),
    'sfd-054a-221': mk('Only Variant', 'sfd-054a-221'),
    'ven-005-166': mk('Venn', 'ven-005-166'),
    'ven-005-221': mk('Venn Reprint', 'ven-005-221'),
  };
  // Aliases are attached as non-enumerable keys by loadCards.
  Object.defineProperty(db, 'ven-r01', { value: db['ogn-007-298'], enumerable: false });
  Object.defineProperty(db, 'rad-007-167', { value: db['ogn-007-298'], enumerable: false });
  const r = makeCardResolver(db);

  it('ignores the printed total and prefers the base printing', () => {
    expect(r.resolve('OGN-042')).toEqual({ ok: true, id: 'ogn-042-298' });
    expect(r.resolve('OGN-042A')).toEqual({ ok: true, id: 'ogn-042a-298' });
  });
  it('falls back to a lettered variant when there is no base', () => {
    expect(r.resolve('SFD-054')).toEqual({ ok: true, id: 'sfd-054a-221' });
  });
  it('resolves alias keys to the canonical id', () => {
    expect(r.resolve('RAD-007')).toEqual({ ok: true, id: 'ogn-007-298' });
  });
  it('uses the name as a tie-break between distinct printings', () => {
    expect(r.resolve('VEN-005', 'Venn Reprint')).toEqual({ ok: true, id: 'ven-005-221' });
  });
  it('warns when the name does not match the chosen card', () => {
    const res = r.resolve('OGN-007', 'Something Else');
    expect(res.ok && res.id).toBe('ogn-007-298');
    expect(res.ok && res.warning).toMatch(/expected "Something Else".*"Lone"/);
  });
  it('matches names loosely (case, punctuation)', () => {
    expect(r.resolve('OGN-007', 'LONE!')).toEqual({ ok: true, id: 'ogn-007-298' });
  });
  it('accepts "Name, Title" hints when our name is only part of it', () => {
    expect(r.resolve('OGN-007', 'Lone, The Solitary')).toEqual({ ok: true, id: 'ogn-007-298' });
    expect(r.resolve('OGN-007', 'The Lone')).toEqual({ ok: true, id: 'ogn-007-298' });
  });
  it('rejects unknown and malformed codes', () => {
    expect(r.resolve('ZZZ-001')).toEqual({ ok: false, error: 'Unknown card ZZZ-001.' });
    expect(r.resolve('bad').ok).toBe(false);
  });
});

describe('importDecks', () => {
  const a = () =>
    shareDeck(IMPORT_DECK_A, 'Deck A', { source: 'META', eventName: 'Cup', placement: '1st' });
  const b = () => shareDeck(IMPORT_DECK_B, 'Deck B');

  it('imports a single deck object, expanding qty into copies', () => {
    const rep = importDecks(JSON.stringify(a()), IMPORT_CARDS);
    expect(rep.fatal).toEqual([]);
    expect(rep.entries).toHaveLength(1);
    const e = rep.entries[0]!;
    expect(e.errors).toEqual([]);
    expect(e.ok).toBe(true);
    expect(e.name).toBe('Deck A');
    expect(e.meta).toEqual({ source: 'META', eventName: 'Cup', placement: '1st' });
    expect(e.deck!.legendId).toBe(IMPORT_DECK_A.legendId);
    expect(e.deck!.championId).toBe(IMPORT_DECK_A.championId);
    expect([...e.deck!.mainDeck].sort()).toEqual([...IMPORT_DECK_A.mainDeck].sort());
    expect(e.deck!.runeDeck).toHaveLength(12);
    expect(e.deck!.battlefields).toHaveLength(3);
  });

  it('accepts an array and a { decks } wrapper', () => {
    expect(importDecks([a(), b()], IMPORT_CARDS).entries.map((e) => e.ok)).toEqual([true, true]);
    const w = importDecks({ decks: [a(), b()] }, IMPORT_CARDS);
    expect(w.entries.map((e) => e.name)).toEqual(['Deck A', 'Deck B']);
  });

  it('ignores the SIDEBOARD zone', () => {
    const d = a();
    d.cards.push({ code: 'ZZZ-999', qty: 15, zone: 'SIDEBOARD', name: 'Nope' });
    const e = importDecks(d, IMPORT_CARDS).entries[0]!;
    expect(e.ok).toBe(true);
    expect(e.warnings).toEqual([]);
  });

  it('reports unknown codes and still imports the other decks', () => {
    const bad = a();
    bad.name = 'Bad';
    bad.cards.push({ code: 'ZZZ-123', qty: 1, zone: 'MAIN', name: 'Ghost' });
    const rep = importDecks([bad, b()], IMPORT_CARDS);
    expect(rep.entries[0]!.ok).toBe(false);
    expect(rep.entries[0]!.errors.join(' ')).toMatch(/Unknown card ZZZ-123/);
    expect(rep.entries[1]!.ok).toBe(true);
  });

  it('lists engine validation errors for an invalid deck', () => {
    const d = a();
    d.cards = d.cards.filter((c) => c.zone !== 'RUNE');
    const e = importDecks(d, IMPORT_CARDS).entries[0]!;
    expect(e.ok).toBe(false);
    expect(e.deck).toBeUndefined();
    expect(e.errors.length).toBeGreaterThan(0);
  });

  it('uses the legend field when it is given and no LEGEND card is listed', () => {
    const d = a();
    d.cards = d.cards.filter((c) => c.zone !== 'LEGEND');
    expect(importDecks(d, IMPORT_CARDS).entries[0]!.deck?.legendId).toBe(IMPORT_DECK_A.legendId);
  });

  it('reports a missing legend and a missing champion', () => {
    const d = a();
    d.cards = d.cards.filter((c) => c.zone !== 'LEGEND');
    delete (d as { legend?: string }).legend;
    expect(importDecks(d, IMPORT_CARDS).entries[0]!.errors.join(' ')).toMatch(/Missing legend/);
    const d2 = a();
    d2.cards = d2.cards.filter((c) => c.zone !== 'CHAMPION');
    expect(importDecks(d2, IMPORT_CARDS).entries[0]!.errors.join(' ')).toMatch(/Missing champion/);
  });

  it('reports bad zones and quantities', () => {
    const d = a();
    d.cards.push({ code: CODE_OF['fx-grunt']!, qty: 0, zone: 'MAIN' });
    d.cards.push({ code: CODE_OF['fx-grunt']!, qty: 1, zone: 'HAND' });
    const errs = importDecks(d, IMPORT_CARDS).entries[0]!.errors.join('\n');
    expect(errs).toMatch(/qty must be a positive integer/);
    expect(errs).toMatch(/unknown zone "HAND"/);
  });

  it('warns about a name mismatch but still imports', () => {
    const d = a();
    d.cards.find((c) => c.zone === 'CHAMPION')!.name = 'Totally Different';
    const e = importDecks(d, IMPORT_CARDS).entries[0]!;
    expect(e.ok).toBe(true);
    expect(e.warnings[0]).toMatch(/Totally Different/);
  });

  it('returns a fatal error for bad JSON, wrong shapes and empty lists', () => {
    expect(importDecks('{nope', IMPORT_CARDS).fatal[0]).toMatch(/Invalid JSON/);
    expect(importDecks('42', IMPORT_CARDS).fatal[0]).toMatch(/Unrecognised format/);
    expect(importDecks({ foo: 1 }, IMPORT_CARDS).fatal).toHaveLength(1);
    expect(importDecks([], IMPORT_CARDS).fatal[0]).toMatch(/no decks/);
  });

  it('reports non-object entries in a list without failing the rest', () => {
    const rep = importDecks([7, a()], IMPORT_CARDS);
    expect(rep.entries[0]!.errors[0]).toMatch(/must be a JSON object/);
    expect(rep.entries[1]!.ok).toBe(true);
  });

  it('rejects an unsupported version', () => {
    const e = importDecks({ ...a(), version: 2 }, IMPORT_CARDS).entries[0]!;
    expect(e.ok).toBe(false);
    expect(e.errors[0]).toMatch(/Unsupported version/);
  });

  it('passes through our own DeckList shape, single or inside a list', () => {
    const rep = importDecks(JSON.stringify(IMPORT_DECK_A), IMPORT_CARDS);
    expect(rep.entries[0]!.ok).toBe(true);
    expect(rep.entries[0]!.deck).toEqual(IMPORT_DECK_A);
    const mixed = importDecks([IMPORT_DECK_B, { ...IMPORT_DECK_A, mainDeck: 'x' }], IMPORT_CARDS);
    expect(mixed.entries.map((e) => e.ok)).toEqual([true, false]);
    expect(mixed.entries[1]!.errors[0]).toMatch(/mainDeck/);
  });

  it('names unnamed decks by position', () => {
    const d = a() as { name?: string };
    delete d.name;
    expect(importDecks(d, IMPORT_CARDS).entries[0]!.name).toBe('Deck 1');
  });
});

describe('deckSupportStats', () => {
  it('counts every deck card (legend, champion, main, battlefields, runes)', () => {
    const d = IMPORT_DECK_A;
    const s = deckSupportStats(d, IMPORT_CARDS);
    expect(s.total).toBe(2 + d.mainDeck.length + d.battlefields.length + d.runeDeck.length);
    expect(s.full + s.partial).toBe(s.total);
  });

  it('counts a partial legend as partial', () => {
    const legend = IMPORT_DECK_A.legendId;
    const base = deckSupportStats(IMPORT_DECK_A, IMPORT_CARDS);
    const cards = {
      ...IMPORT_CARDS,
      [legend]: { ...IMPORT_CARDS[legend]!, supportLevel: 'partial' as const },
    };
    const s = deckSupportStats(IMPORT_DECK_A, cards);
    const was = IMPORT_CARDS[legend]!.supportLevel === 'full' ? 1 : 0;
    expect(s.partial).toBe(base.partial + was);
  });

  it('flags low coverage below 60%', () => {
    expect(isLowSupport({ full: 59, total: 100 })).toBe(true);
    expect(isLowSupport({ full: 60, total: 100 })).toBe(false);
    expect(isLowSupport({ full: 0, total: 0 })).toBe(false);
  });
});

describe('deckContentKey', () => {
  it('is stable and order-insensitive for the card lists', () => {
    const d = IMPORT_DECK_A;
    const shuffled = {
      ...d,
      mainDeck: [...d.mainDeck].reverse(),
      runeDeck: [...d.runeDeck].reverse(),
    };
    expect(deckContentKey(shuffled)).toBe(deckContentKey(d));
  });

  it('differs when the content differs', () => {
    expect(deckContentKey(IMPORT_DECK_A)).not.toBe(deckContentKey(IMPORT_DECK_B));
    const fewer = { ...IMPORT_DECK_A, mainDeck: IMPORT_DECK_A.mainDeck.slice(1) };
    expect(deckContentKey(fewer)).not.toBe(deckContentKey(IMPORT_DECK_A));
  });
});
