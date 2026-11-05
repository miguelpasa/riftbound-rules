import { describe, it, expect } from 'vitest';
import { RULE_ERROR_MESSAGES } from '../types/index.js';
import { Scenario } from '../testing/scenario.js';

describe('scenario: Burn Out', () => {
  it('recycles the Trash into the deck, gives the opponent a point and completes the draw', () => {
    // Tests Rule 432: Burn Out when a draw cannot be completed from an empty Main Deck
    const sc = Scenario.start();
    sc.setDeckSize('p1', 0); // all 35 cards go to the Trash
    expect(sc.player('p1').trash).toHaveLength(35);
    expect(sc.player('p1').mainDeck).toHaveLength(0);

    const r = sc.endTurn('p0'); // p1's Draw Phase
    const burn = sc.eventsOfType('BURN_OUT', r.events);
    expect(burn).toEqual([expect.objectContaining({ player: 'p1' })]);
    const points = sc.eventsOfType('POINT_GAINED', r.events);
    expect(points).toEqual([
      expect.objectContaining({ player: 'p0', amount: 1, source: 'BURN_OUT' }),
    ]);
    expect(sc.player('p0').points).toBe(1);
    expect(sc.player('p1').points).toBe(0);
    // 432.2.b: the whole Trash became the deck; the interrupted draw then completed
    expect(sc.player('p1').trash).toHaveLength(0);
    expect(sc.player('p1').mainDeck).toHaveLength(34);
    expect(sc.player('p1').hand).toHaveLength(5);
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toHaveLength(1);
    expect(sc.state.turn).toMatchObject({ number: 2, activePlayer: 'p1', phase: 'MAIN' });
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
  });

  it('with an empty Trash every Burn Out is +1 for the opponent until they reach 8 and win', () => {
    // Tests Rule 432.3.c: a Burn Out that gives the opponent the victory score ends the game at once
    const sc = Scenario.start();
    sc.setDeckSize('p1', 0, 'banishment'); // deck empty, Trash empty
    sc.setPoints('p0', 5);

    sc.endTurn('p0'); // turn 2: p1 burns out
    expect(sc.player('p0').points).toBe(6);
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
    expect(sc.player('p1').hand).toHaveLength(4); // nothing to draw
    sc.endTurn('p1'); // turn 3: p0 plays normally
    expect(sc.player('p0').points).toBe(6);
    sc.endTurn('p0'); // turn 4
    expect(sc.player('p0').points).toBe(7);
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
    sc.endTurn('p1');

    const last = sc.endTurn('p0'); // turn 6: the eighth point
    expect(sc.player('p0').points).toBe(8);
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
    expect(sc.eventsOfType('GAME_ENDED', last.events)).toEqual([
      expect.objectContaining({ winner: 'p0' }),
    ]);
    // the game stopped inside p1's Draw Phase: it never reached Main
    expect(sc.state.turn).toMatchObject({ number: 6, activePlayer: 'p1', phase: 'DRAW' });
    expect(sc.reject({ type: 'END_TURN', playerId: 'p1' }).code).toBe('GAME_OVER');
  });

  it('never refers to the non-existent Rule 607.1', () => {
    // Tests Rule 432: user-facing text cites Rule 432 / 473.1.b, never the PRD's bogus 607.1
    for (const message of Object.values(RULE_ERROR_MESSAGES)) {
      expect(message).not.toContain('607.1');
    }
    const sc = Scenario.start();
    sc.setDeckSize('p1', 0, 'banishment');
    sc.setPoints('p0', 7);
    const r = sc.endTurn('p0');
    const rejected = sc.reject({ type: 'END_TURN', playerId: 'p0' });
    expect(rejected.message).not.toContain('607.1');
    expect(JSON.stringify(r.events)).not.toContain('607');
    expect(JSON.stringify(sc.events)).not.toContain('607.1');
  });

  it('a lead of 8 vs 7 cannot survive into a Draw Phase: the Beginning Cleanup ends the game first', () => {
    // Tests Rule 323.1: the win check happens before the Draw Phase, so no Burn Out can follow
    const sc = Scenario.start();
    sc.setDeckSize('p1', 0, 'banishment');
    sc.setPoints('p0', 7);
    sc.setPoints('p1', 8); // an unreachable lead injected by surgery
    const r = sc.endTurn('p0');
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p1');
    expect(sc.eventsOfType('BURN_OUT', r.events)).toEqual([]);
    expect(sc.player('p0').points).toBe(7);
  });
});
