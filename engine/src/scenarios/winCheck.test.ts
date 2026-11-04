import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';

describe('scenario: Win check (Rule 194.2)', () => {
  it('continues on an 8 to 8 tie and ends when one player leads with 9', () => {
    // Tests Rule 194.2: a player wins with the victory score and more points than any other player
    const sc = Scenario.start();
    sc.setPoints('p0', 8);
    sc.setPoints('p1', 8);
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });

    sc.endTurn('p0'); // Cleanup runs: 8 vs 8 is not a win
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
    expect(sc.state.winner).toBeUndefined();
    expect(sc.state.turn).toMatchObject({ number: 2, activePlayer: 'p1', phase: 'MAIN' });

    const r = sc.endTurn('p1'); // p0 Holds bf0 in the Beginning Phase: 9 vs 8
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', amount: 1, source: 'HOLD' }),
    ]);
    expect(sc.player('p0').points).toBe(9);
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
    // the check ran in the Cleanup of the same reduce
    expect(sc.eventsOfType('GAME_ENDED', r.events)).toEqual([
      expect.objectContaining({ winner: 'p0' }),
    ]);
  });

  it('does not end the game below the victory score even with a large lead', () => {
    // Tests Rule 194.2: the victory score must be reached
    const sc = Scenario.start();
    sc.setPoints('p0', 7);
    sc.endTurn('p0');
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
  });

  it('gives a player at the victory score the win as soon as the Cleanup runs', () => {
    // Tests Rule 323.1: the first Cleanup step is the win check
    const sc = Scenario.start();
    sc.setPoints('p0', 8);
    sc.setPoints('p1', 7);
    const r = sc.endTurn('p0');
    expect(sc.state.winner).toBe('p0');
    expect(sc.eventsOfType('GAME_ENDED', r.events)).toHaveLength(1);
    expect(sc.reject({ type: 'PASS_PRIORITY', playerId: 'p0' }).code).toBe('GAME_OVER');
  });
});
