import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });

/** p0's turn 1 with one ready unit in the base, p0 at `points`. Battlefields: bf0 (p0's), bf1 (p1's). */
function conquerSetup(points: number): { sc: Scenario; unit: string } {
  const sc = Scenario.start();
  sc.setPoints('p0', points);
  const unit = sc.putUnit('p0', 'fx-grunt', 'base');
  return { sc, unit };
}

describe('scenario: Final Point (Rule 473.1.b)', () => {
  it('denies the point of a lone Conquer at 7 and draws a card instead', () => {
    // Tests Rule 473.1.b: at 7 points a Conquer scores only if every battlefield was scored this turn
    const { sc, unit } = conquerSetup(7);
    const handBefore = sc.player('p0').hand.length;
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: toBf('bf1'),
    });
    sc.pass('p0');
    const r = sc.pass('p1'); // Showdown closes: p0 Conquers bf1

    expect(sc.eventsOfType('FINAL_POINT_DENIED_DREW_CARD', r.events)).toEqual([
      expect.objectContaining({ player: 'p0' }),
    ]);
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toHaveLength(0);
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toHaveLength(1);
    expect(sc.player('p0').points).toBe(7);
    expect(sc.player('p0').hand).toHaveLength(handBefore + 1);
    expect(sc.bf('bf1').controller).toBe('p0'); // control is still established
    expect(sc.bf('bf1').scoredThisTurnBy).toEqual(['p0']);
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
    expect(sc.state.winner).toBeUndefined();
  });

  it('wins at 8 when a Hold in the Beginning Phase and a Conquer score both battlefields in one turn', () => {
    // Tests Rule 473.1.b: having scored every battlefield this turn lets the Conquer take the final point
    const sc = Scenario.start();
    sc.setPoints('p0', 6);
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const mover = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.endTurn('p0');
    sc.endTurn('p1');

    // turn 3: bf0 was Held in the Beginning Phase
    expect(sc.state.turn).toMatchObject({ number: 3, activePlayer: 'p0', phase: 'MAIN' });
    expect(sc.player('p0').points).toBe(7);
    expect(sc.bf('bf0').scoredThisTurnBy).toEqual(['p0']);
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');

    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [mover],
      destination: toBf('bf1'),
    });
    sc.pass('p0');
    const r = sc.pass('p1');
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', amount: 1, source: 'CONQUER' }),
    ]);
    expect(sc.eventsOfType('FINAL_POINT_DENIED_DREW_CARD', r.events)).toHaveLength(0);
    // 323.1: the win check of the very Cleanup that follows
    expect(sc.player('p0').points).toBe(8);
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
    expect(sc.eventsOfType('GAME_ENDED', r.events)).toEqual([
      expect.objectContaining({ winner: 'p0' }),
    ]);
  });

  it('lets a Hold at 7 points score normally and win', () => {
    // Tests Rule 473.1.b: the restriction is for Conquer only, so Hold at 7 gives the point
    const sc = Scenario.start();
    sc.setPoints('p0', 7);
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    sc.endTurn('p0');
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
    const r = sc.endTurn('p1'); // p0's Beginning Phase: Hold bf0
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', amount: 1, source: 'HOLD' }),
    ]);
    expect(sc.player('p0').points).toBe(8);
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
  });

  it('scores a Conquer below 7 points without any restriction', () => {
    // Tests Rule 473.1: a Conquer normally gives one point
    const { sc, unit } = conquerSetup(6);
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: toBf('bf0'),
    });
    sc.pass('p0');
    sc.pass('p1');
    expect(sc.player('p0').points).toBe(7);
    expect(sc.state.gameStatus).toBe('IN_PROGRESS');
  });
});
