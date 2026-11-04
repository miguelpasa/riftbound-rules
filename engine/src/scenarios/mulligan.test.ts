import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';

describe('scenario: Mulligan (Rule 117)', () => {
  it('enforces turn order: p1 cannot decide before p0, and nobody decides twice', () => {
    // Tests Rule 117: mulligan decisions are made in turn order
    const sc = Scenario.begin();
    const err = sc.reject({ type: 'MULLIGAN', playerId: 'p1', cardIds: [] });
    expect(err.code).toBe('MULLIGAN_ORDER');
    expect(err.message).toBe(
      '[Rule Error] Mulligan decisions are made in turn order. (Rule 117) [waiting for p0]',
    );
    sc.do({ type: 'MULLIGAN', playerId: 'p0', cardIds: [] });
    expect(sc.reject({ type: 'MULLIGAN', playerId: 'p0', cardIds: [] }).code).toBe(
      'MULLIGAN_ORDER',
    );
    expect(sc.state.mulligan).toMatchObject({ current: 1, done: ['p0'] });
  });

  it('allows at most 2 cards, no duplicates and only cards from the own hand', () => {
    // Tests Rule 117: up to two cards may be set aside
    const sc = Scenario.begin();
    const hand = sc.player('p0').hand;
    const three = sc.reject({ type: 'MULLIGAN', playerId: 'p0', cardIds: hand.slice(0, 3) });
    expect(three.code).toBe('MULLIGAN_INVALID');
    expect(three.message).toBe(
      '[Rule Error] Invalid mulligan selection. (Rule 117) [at most 2 cards]',
    );
    const dup = sc.reject({
      type: 'MULLIGAN',
      playerId: 'p0',
      cardIds: [hand[0] as string, hand[0] as string],
    });
    expect(dup.code).toBe('MULLIGAN_INVALID');
    const foreign = sc.reject({
      type: 'MULLIGAN',
      playerId: 'p0',
      cardIds: [sc.player('p1').hand[0] as string],
    });
    expect(foreign.code).toBe('NOT_IN_HAND');
    const deckCard = sc.player('p0').mainDeck[0] as string;
    expect(sc.reject({ type: 'MULLIGAN', playerId: 'p0', cardIds: [deckCard] }).code).toBe(
      'NOT_IN_HAND',
    );
    expect(sc.state.mulligan?.done).toEqual([]);
  });

  it('draws replacements from the top and recycles the set-aside cards to the bottom of the deck', () => {
    // Tests Rule 117: swapped cards go to the bottom of the Main Deck
    const sc = Scenario.begin();
    const hand = [...sc.player('p0').hand];
    const deck = [...sc.player('p0').mainDeck];
    const aside = [hand[1], hand[3]] as [string, string];
    const r = sc.do({ type: 'MULLIGAN', playerId: 'p0', cardIds: aside });

    const nowHand = sc.player('p0').hand;
    expect(nowHand).toHaveLength(4);
    expect(nowHand).toEqual([hand[0], hand[2], deck[0], deck[1]]);
    const nowDeck = sc.player('p0').mainDeck;
    expect(nowDeck).toHaveLength(deck.length); // nothing lost, nothing gained
    expect(nowDeck.slice(0, deck.length - 2)).toEqual(deck.slice(2));
    expect(new Set(nowDeck.slice(-2))).toEqual(new Set(aside));
    for (const id of aside) {
      expect(sc.obj(id).zone).toEqual({ kind: 'mainDeck', player: 'p0' });
    }
    // only the drawing player learns the new cards
    const drawn = sc.eventsOfType('CARD_DRAWN', r.events);
    expect(drawn).toHaveLength(2);
    expect(drawn.every((e) => e.player === 'p0' && e.visibleTo?.[0] === 'p0')).toBe(true);
    // p1's hand is untouched and the game goes on only after p1 has decided
    expect(sc.state.turn.phase).toBe('MULLIGAN');
    sc.do({ type: 'MULLIGAN', playerId: 'p1', cardIds: [] });
    expect(sc.state.turn).toMatchObject({ number: 1, activePlayer: 'p0', phase: 'MAIN' });
  });

  it('refuses every game action while the mulligan is running', () => {
    // Tests Rule 117: the mulligan is finished before the first turn begins
    const sc = Scenario.begin();
    expect(sc.reject({ type: 'END_TURN', playerId: 'p0' }).code).toBe('WRONG_PHASE');
    const rune = sc.player('p0').runeDeck[0] as string;
    expect(
      sc.reject({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: rune, mode: 'EXHAUST' }).code,
    ).toBe('WRONG_PHASE');
  });
});
