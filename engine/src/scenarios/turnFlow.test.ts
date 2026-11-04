import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';

describe('scenario: turn flow', () => {
  it('lands in p0 MAIN of turn 1 after the mulligans with 2 ready runes and 1 card drawn', () => {
    // Tests Rule 315: Awaken, Beginning, Channel (2 runes), Draw (1 card), then Main
    const sc = Scenario.begin();
    expect(sc.state.turn.phase).toBe('MULLIGAN');
    expect(sc.player('p0').hand).toHaveLength(4);
    sc.do({ type: 'MULLIGAN', playerId: 'p0', cardIds: [] });
    expect(sc.state.turn.phase).toBe('MULLIGAN'); // p1 still has to decide
    const r = sc.do({ type: 'MULLIGAN', playerId: 'p1', cardIds: [] });

    expect(sc.state.turn).toEqual({ number: 1, activePlayer: 'p0', phase: 'MAIN', step: 'NONE' });
    expect(sc.state.mulligan).toBeNull();
    expect(sc.state.flow.priority).toBe('p0');
    expect(sc.runes('p0')).toHaveLength(2);
    expect(sc.runes('p0').every((x) => x.ready)).toBe(true);
    expect(sc.player('p0').runeDeck).toHaveLength(10);
    expect(sc.player('p0').hand).toHaveLength(5);
    expect(sc.player('p0').mainDeck).toHaveLength(39 - 5); /* 40 cards minus the Chosen Champion */
    // p1 has not had a turn yet
    expect(sc.runes('p1')).toHaveLength(0);
    expect(sc.player('p1').hand).toHaveLength(4);

    const phases = r.events.flatMap((e) => (e.type === 'PHASE_CHANGED' ? [e.phase] : []));
    expect(phases).toEqual(['AWAKEN', 'BEGINNING', 'CHANNEL', 'DRAW', 'MAIN']);
    expect(sc.eventsOfType('RUNE_CHANNELED', r.events)).toHaveLength(2);
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toHaveLength(1);
  });

  it('gives p1 three runes on its first Channel Phase and two on later turns', () => {
    // Tests Rule 487.7: the second player channels one extra rune the first time
    const sc = Scenario.start();
    sc.endTurn('p0');
    expect(sc.state.turn).toMatchObject({ number: 2, activePlayer: 'p1', phase: 'MAIN' });
    expect(sc.runes('p1')).toHaveLength(3);
    expect(sc.player('p1').runeDeck).toHaveLength(9);
    expect(sc.player('p1').hand).toHaveLength(5);

    sc.endTurn('p1');
    expect(sc.state.turn).toMatchObject({ number: 3, activePlayer: 'p0' });
    expect(sc.runes('p0')).toHaveLength(4); // 2 + 2
    expect(sc.runes('p1')).toHaveLength(3);

    sc.endTurn('p0');
    expect(sc.runes('p1')).toHaveLength(5); // 3 + 2, no further bonus
    expect(sc.runes('p0')).toHaveLength(4);
  });

  it('readies exhausted runes at the start of the next own turn', () => {
    // Tests Rule 315.1: the Awaken Phase readies the turn player's permanents
    const sc = Scenario.start();
    const [r1, r2] = sc.runes('p0');
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: r1!.id, mode: 'EXHAUST' });
    expect(sc.obj(r1!.id).ready).toBe(false);
    sc.endTurn('p0');
    expect(sc.obj(r1!.id).ready).toBe(false); // p1's turn does not ready p0's runes
    sc.endTurn('p1');
    expect(sc.obj(r1!.id).ready).toBe(true);
    expect(sc.obj(r2!.id).ready).toBe(true);
  });

  it('empties both Rune Pools at the end of the turn and at the start of Main', () => {
    // Tests Rule 317.2: pools empty in the Expiration step (and 316.3 at the start of Main)
    const sc = Scenario.start();
    const [r1, r2] = sc.runes('p0');
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: r1!.id, mode: 'EXHAUST' });
    sc.do({ type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: r2!.id, mode: 'RECYCLE' });
    expect(sc.player('p0').runePool.energy).toBe(1);
    expect(Object.values(sc.player('p0').runePool.power).reduce((a, b) => a + (b ?? 0), 0)).toBe(1);
    // p1 holds stale pool contents too: they must not survive into its own Main Phase (316.3)
    sc.setPool('p1', 3, { Mind: 2 });

    sc.endTurn('p0');
    expect(sc.state.turn).toMatchObject({ number: 2, activePlayer: 'p1', phase: 'MAIN' });
    expect(sc.player('p0').runePool).toEqual({ energy: 0, power: {} });
    expect(sc.player('p1').runePool).toEqual({ energy: 0, power: {} });
  });

  it('heals damage from every unit when the turn ends', () => {
    // Tests Rule 317.2.b: damage wears off in the Expiration step
    const sc = Scenario.start();
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base', { damage: 2 });
    const theirs = sc.putUnit('p1', 'fx-order-tank', 'base', { damage: 1 });
    sc.endTurn('p0');
    expect(sc.obj(mine).damage).toBe(0);
    expect(sc.obj(theirs).damage).toBe(0);
    expect(sc.obj(mine).zone.kind).toBe('base'); // survived: 2 damage on a 3 Might unit
  });

  it("readies the turn player's units at Awaken, leaving the opponent's exhausted", () => {
    // Tests Rule 315.1: Awaken readies only the turn player's objects
    const sc = Scenario.start();
    const mine = sc.putUnit('p0', 'fx-grunt', 'base', { ready: false });
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base', { ready: false });
    sc.endTurn('p0'); // p1's Awaken
    expect(sc.obj(theirs).ready).toBe(true);
    expect(sc.obj(mine).ready).toBe(false);
  });

  it('rejects END_TURN from the player whose turn it is not', () => {
    // Tests Rule 307: only the turn player ends the turn
    const sc = Scenario.start();
    const e = sc.reject({ type: 'END_TURN', playerId: 'p1' });
    expect(e.code).toBe('NOT_YOUR_TURN');
    expect(e.message).toBe('[Rule Error] Only the turn player may do that. (Rule 307)');
  });
});
