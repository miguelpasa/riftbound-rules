import { describe, it, expect } from 'vitest';
import { createGame, createGameWithEvents } from './setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import type { GameState } from './types/index.js';

const make = (seed = 's1'): GameState =>
  createGame(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], seed);
const cardIdOf = (s: GameState, id: string | null): string | undefined =>
  id === null ? undefined : s.objects[id]?.cardId;

describe('createGame', () => {
  it('sets up the initial state for a Duel', () => {
    // Tests Rule 104: initial game state
    const s = make();
    expect(s.mode).toBe('DUEL');
    expect(s.victoryScore).toBe(8);
    expect(s.gameStatus).toBe('IN_PROGRESS');
    expect(s.turn).toEqual({ number: 0, activePlayer: 'p0', phase: 'MULLIGAN', step: 'NONE' });
    expect(s.mulligan).toEqual({ order: ['p0', 'p1'], current: 0, done: [] });
    expect(s.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(s.flow.priority).toBeNull();
    expect(s.flow.focus).toBeNull();
    expect(s.flow.chain).toEqual([]);
    expect(s.seed.seed).toBe('s1');
    for (const p of s.players) {
      expect(p.points).toBe(0);
      expect(p.runePool).toEqual({ energy: 0, power: {} });
    }
  });

  it('deals 4-card hands, 12-rune decks, legend and champion zones', () => {
    // Tests Rule 116: opening hands of four; Rules 111-112: legend and champion zones
    const s = make();
    for (const p of s.players) {
      expect(p.hand).toHaveLength(4);
      expect(p.mainDeck).toHaveLength(39 - 4);
      expect(p.runeDeck).toHaveLength(12);
      expect(p.legend).not.toBeNull();
      expect(p.championZone).toHaveLength(1);
      expect(s.objects[p.legend as string]?.zone).toEqual({ kind: 'legend', player: p.id });
      expect(s.objects[p.championZone[0] as string]?.zone).toEqual({
        kind: 'champion',
        player: p.id,
      });
    }
  });

  it('creates unique deterministic ids and loses no cards', () => {
    // Tests Rule 107: every card is exactly one object in exactly one zone
    const s = make();
    const ids = Object.keys(s.objects);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(2 * (1 + 1 + 39 + 12));
    expect(s.objects['o1']).toBeDefined();
    expect(s.nextObjectId).toBe(ids.length + 1);
    const placed: string[] = [];
    for (const p of s.players) {
      placed.push(...p.hand, ...p.mainDeck, ...p.runeDeck, ...p.championZone, p.legend as string);
    }
    expect([...placed].sort()).toEqual([...ids].sort());
    for (const p of s.players) {
      for (const id of [...p.hand, ...p.mainDeck, ...p.runeDeck]) {
        expect(s.objects[id]?.owner).toBe(p.id);
        expect(s.objects[id]?.controller).toBe(p.id);
      }
      for (const id of p.hand) expect(s.objects[id]?.zone).toEqual({ kind: 'hand', player: p.id });
    }
  });

  it('creates exactly two battlefields, one from each player, owner matching the deck', () => {
    // Tests Rule 487.4: each player contributes one of their three battlefields
    const s = make();
    expect(s.battlefields.map((b) => b.id)).toEqual(['bf0', 'bf1']);
    const p0IsA = cardIdOf(s, s.players[0].legend) === FIXTURE_DECK_A.legendId;
    const p0Deck = p0IsA ? FIXTURE_DECK_A : FIXTURE_DECK_B;
    const p1Deck = p0IsA ? FIXTURE_DECK_B : FIXTURE_DECK_A;
    expect(p0Deck.battlefields).toContain(s.battlefields[0]?.cardId);
    expect(p1Deck.battlefields).toContain(s.battlefields[1]?.cardId);
    expect(s.battlefields[0]?.owner).toBe('p0');
    expect(s.battlefields[1]?.owner).toBe('p1');
    expect(s.battlefields[0]?.controller).toBeNull();
  });

  it('is deterministic by seed and varies across seeds', () => {
    // Tests Rule 114: setup randomness derives only from the seed
    expect(make('same')).toEqual(make('same'));
    const prints = new Set(
      Array.from({ length: 12 }, (_, i) => JSON.stringify(make(`seed-${i}`).players[0].hand)),
    );
    expect(prints.size).toBeGreaterThan(1);
  });

  it('chooses the first player randomly, always seating them as p0', () => {
    // Tests Rule 115: first player is random; p0 is always the first player
    const legends = new Set<string | undefined>();
    for (let i = 0; i < 20; i++) {
      const s = make(`first-${i}`);
      legends.add(cardIdOf(s, s.players[0].legend));
    }
    expect(legends.size).toBe(2);
  });

  it('shuffles the main deck', () => {
    // Tests Rule 114: decks are shuffled
    const s = make();
    const order = [...s.players[0].hand, ...s.players[0].mainDeck].map(
      (id) => s.objects[id]?.cardId,
    );
    expect(order).not.toEqual([...order].sort());
  });

  it('emits CARD_DRAWN events visible only to the drawer, with increasing seq', () => {
    // Tests Rule 116: opening draws are reported privately
    const { state, events } = createGameWithEvents(
      FIXTURE_CARDS,
      [FIXTURE_DECK_A, FIXTURE_DECK_B],
      'ev',
    );
    expect(events).toHaveLength(8);
    events.forEach((e, i) => {
      expect(e.type).toBe('CARD_DRAWN');
      expect(e.seq).toBe(i + 1);
      if (e.type === 'CARD_DRAWN') expect(e.visibleTo).toEqual([e.player]);
    });
    expect(state.nextEventSeq).toBe(9);
  });

  it('throws on an illegal deck', () => {
    // Tests Rule 103: illegal decks cannot start a game
    const bad = { ...FIXTURE_DECK_A, runeDeck: [] };
    expect(() => createGame(FIXTURE_CARDS, [bad, FIXTURE_DECK_B], 'x')).toThrow(/illegal/);
  });

  it('does not mutate its inputs', () => {
    // Tests Rule 104: setup is pure
    const a = structuredClone(FIXTURE_DECK_A);
    const cards = structuredClone(FIXTURE_CARDS);
    createGame(cards, [a, FIXTURE_DECK_B], 'p');
    expect(a).toEqual(FIXTURE_DECK_A);
    expect(cards).toEqual(FIXTURE_CARDS);
  });
});

describe('object id hygiene', () => {
  const num = (id: string): number => Number(id.slice(1));

  it('deck order is not ascending id order and copies of a card do not get adjacent ids', () => {
    // Tests Rule 128: object ids must not leak card identity or deck order (hidden information)
    let ascendingDecks = 0;
    let contiguousTriples = 0;
    let triples = 0;
    for (let k = 0; k < 20; k++) {
      const s = make(`ids-${k}`);
      for (const p of s.players) {
        const sorted = [...p.mainDeck].sort((a, b) => num(a) - num(b));
        if (p.mainDeck.every((id, i) => id === sorted[i])) ascendingDecks++;
        // The 3-copy cards: are their ids a run of consecutive numbers?
        const byCard = new Map<string, number[]>();
        for (const o of Object.values(s.objects)) {
          if (o.owner !== p.id || !['mainDeck', 'hand'].includes(o.zone.kind)) continue;
          byCard.set(o.cardId, [...(byCard.get(o.cardId) ?? []), num(o.id)]);
        }
        for (const ids of byCard.values()) {
          if (ids.length !== 3) continue;
          ids.sort((a, b) => a - b);
          triples++;
          if (ids[1] === (ids[0] as number) + 1 && ids[2] === (ids[1] as number) + 1) {
            contiguousTriples++;
          }
        }
      }
    }
    expect(ascendingDecks).toBe(0);
    expect(triples).toBeGreaterThan(100);
    expect(contiguousTriples).toBeLessThanOrEqual(2); // chance level is ~1 in 1000
  });

  it('stays deterministic for a seed', () => {
    // Tests Rule 114: shuffling uses the game RNG, so the same seed gives the same game
    expect(make('same')).toEqual(make('same'));
    expect(make('same').players[0].mainDeck).not.toEqual(make('other').players[0].mainDeck);
  });
});
