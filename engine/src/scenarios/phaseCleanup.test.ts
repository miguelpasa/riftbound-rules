import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import type { CardDatabase, CardDef } from '../types/index.js';

describe('scenario: Cleanup between the start-of-turn phases', () => {
  it('a Temporary-only controller loses the battlefield before Scoring and gets no Hold point', () => {
    // Tests Rule 323.5: control is lost in a Cleanup before the Scoring step awards a Hold
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        keywords: [{ name: 'Temporary' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const grunt = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    sc.endTurn('p0'); // p1's turn: p0's Temporary unit is not touched
    expect(sc.bf('bf0').controller).toBe('p0');
    const r = sc.endTurn('p1'); // p0's Beginning Phase
    expect(sc.eventsOfType('UNIT_KILLED', r.events)).toEqual([
      expect.objectContaining({ unitId: grunt }),
    ]);
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toEqual([]);
    expect(sc.player('p0').points).toBe(0);
    expect(sc.bf('bf0').controller).toBeNull();
    expect(
      sc.eventsOfType('BATTLEFIELD_CONTROL_CHANGED', r.events).map((e) => e.controller),
    ).toEqual([null]);
    expect(sc.state.turn).toMatchObject({ activePlayer: 'p0', phase: 'MAIN' });
  });

  it('a player reaching the Victory Score by Hold wins before Channel / Draw (no Burn Out)', () => {
    // Tests Rule 323.1: the win check follows the Scoring step, before Draw can cause a Burn Out
    const sc = Scenario.start();
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    sc.setPoints('p0', 7);
    sc.setPoints('p1', 7);
    sc.setDeckSize('p0', 0, 'banishment'); // p0 cannot draw: a Burn Out would give p1 the 8th point
    sc.endTurn('p0');
    const r = sc.endTurn('p1'); // p0 Holds bf0: 8 vs 7
    expect(sc.eventsOfType('POINT_GAINED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', source: 'HOLD' }),
    ]);
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
    expect(sc.eventsOfType('BURN_OUT', r.events)).toEqual([]);
    expect(sc.eventsOfType('RUNE_CHANNELED', r.events)).toEqual([]);
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toEqual([]);
    expect(sc.state.turn).toMatchObject({ activePlayer: 'p0', phase: 'BEGINNING' });
  });

  it('a Burn Out point that decides the game ends it before Main', () => {
    // Tests Rule 323.1: a win check also follows the Draw Phase
    const sc = Scenario.start();
    sc.setDeckSize('p1', 0); // Trash recycled by the Burn Out
    sc.setPoints('p0', 7);
    sc.endTurn('p0');
    expect(sc.state.winner).toBe('p0');
    expect(sc.state.turn).toMatchObject({ activePlayer: 'p1', phase: 'DRAW' });
  });
});
