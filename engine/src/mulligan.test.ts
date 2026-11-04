import { describe, it, expect } from 'vitest';
import { applyMulligan } from './mulligan.js';
import { createGame } from './setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import type { GameState, MulliganIntent, PlayerId } from './types/index.js';

const fresh = (seed = 'm'): GameState =>
  createGame(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], seed);
const intent = (playerId: PlayerId, cardIds: string[]): MulliganIntent => ({
  type: 'MULLIGAN',
  playerId,
  cardIds,
});
const run = (s: GameState, i: MulliganIntent): ReturnType<typeof applyMulligan> =>
  applyMulligan(s, FIXTURE_CARDS, i);

describe('applyMulligan', () => {
  it('rejects out-of-order mulligans', () => {
    // Tests Rule 117: mulligans happen in turn order
    expect(run(fresh(), intent('p1', []))).toMatchObject({ ok: false, code: 'MULLIGAN_ORDER' });
  });

  it('rejects more than 2 cards, duplicates, and cards not in hand', () => {
    // Tests Rule 117: up to two cards from the hand
    const s = fresh();
    const hand = s.players[0].hand;
    expect(run(s, intent('p0', hand.slice(0, 3)))).toMatchObject({
      ok: false,
      code: 'MULLIGAN_INVALID',
    });
    expect(run(s, intent('p0', [hand[0] as string, hand[0] as string]))).toMatchObject({
      ok: false,
      code: 'MULLIGAN_INVALID',
    });
    expect(run(s, intent('p0', [s.players[0].mainDeck[0] as string]))).toMatchObject({
      ok: false,
      code: 'NOT_IN_HAND',
    });
  });

  it('rejects mulligans outside the MULLIGAN phase', () => {
    // Tests Rule 117: mulligan only occurs during setup
    const s = fresh();
    s.turn.phase = 'MAIN';
    s.mulligan = null;
    expect(run(s, intent('p0', []))).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
  });

  it('keeping advances to the next player without changing hands', () => {
    // Tests Rule 117: an empty selection keeps the hand
    const s = fresh();
    const r = run(s, intent('p0', []));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players[0]).toEqual(s.players[0]);
    expect(r.state.mulligan).toEqual({ order: ['p0', 'p1'], current: 1, done: ['p0'] });
    expect(r.state.turn.phase).toBe('MULLIGAN');
    expect(r.events).toEqual([]);
  });

  it('sets aside, draws replacements, then recycles to the bottom of the deck', () => {
    // Tests Rule 117.3: draw replacements first, then recycle set-aside cards to the bottom
    const s = fresh();
    const p = s.players[0];
    const aside = p.hand.slice(0, 2);
    const keptHand = p.hand.slice(2);
    const topTwo = p.mainDeck.slice(0, 2);
    const r = run(s, intent('p0', aside));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const np = r.state.players[0];
    expect(np.hand).toEqual([...keptHand, ...topTwo]);
    expect(np.mainDeck).toHaveLength(p.mainDeck.length);
    expect(np.mainDeck.slice(-2).sort()).toEqual([...aside].sort());
    expect(np.mainDeck.slice(0, -2)).toEqual(p.mainDeck.slice(2));
    for (const id of aside) {
      expect(r.state.objects[id]?.zone).toEqual({ kind: 'mainDeck', player: 'p0' });
    }
    for (const id of topTwo) {
      expect(r.state.objects[id]?.zone).toEqual({ kind: 'hand', player: 'p0' });
    }
    expect(r.events.map((e) => e.type)).toEqual(['CARD_DRAWN', 'CARD_DRAWN']);
    expect(r.events[0]?.seq).toBe(s.nextEventSeq);
  });

  it('recycles in random order across seeds', () => {
    // Tests Rule 417.5: recycled cards go to the bottom in random order
    const orders = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const s = fresh(`rec-${i}`);
      const aside = s.players[0].hand.slice(0, 2);
      const r = run(s, intent('p0', aside));
      if (!r.ok) throw new Error('unexpected');
      orders.add(
        r.state.players[0].mainDeck
          .slice(-2)
          .map((id) => aside.indexOf(id))
          .join(),
      );
    }
    expect(orders.size).toBe(2);
  });

  it('does not mutate the input state and is deterministic', () => {
    // Tests Rule 117: reducers are pure
    const s = fresh();
    const snapshot = structuredClone(s);
    const i = intent('p0', s.players[0].hand.slice(0, 1));
    const a = run(s, i);
    const b = run(s, i);
    expect(s).toEqual(snapshot);
    expect(a).toEqual(b);
  });

  it('moves to AWAKEN of turn 1 after both players finish', () => {
    // Tests Rule 117: after mulligans the first turn begins with p0
    const s = fresh();
    const r1 = run(s, intent('p0', [s.players[0].hand[0] as string]));
    if (!r1.ok) throw new Error('unexpected');
    expect(run(r1.state, intent('p0', []))).toMatchObject({ ok: false, code: 'MULLIGAN_ORDER' });
    const r2 = run(r1.state, intent('p1', s.players[1].hand.slice(0, 2)));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.mulligan).toBeNull();
    expect(r2.state.turn).toEqual({ number: 1, activePlayer: 'p0', phase: 'AWAKEN', step: 'NONE' });
    expect(run(r2.state, intent('p0', []))).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    for (const p of r2.state.players) {
      expect(p.hand).toHaveLength(4);
      expect(p.mainDeck).toHaveLength(35);
    }
  });
});
