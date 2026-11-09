import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const bf1 = { kind: 'battlefield' as const, battlefieldId: 'bf1' };
const legendWith = (t: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-legend-ember': { ...(SCENARIO_CARDS['fx-legend-ember'] as CardDef), triggers: [t] },
});
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: Legend triggers for winning a combat and holding (R101)', () => {
  it('"When you win a combat" fires for the winner\'s Legend', () => {
    // Tests Rule 468.3: the side with units left wins the combat
    const sc = Scenario.start(
      {},
      legendWith({ on: 'WIN_COMBAT', effects: [{ op: 'DRAW', amount: 1 }] }),
    );
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [titan], destination: bf1 });
    sc.pass('p0');
    sc.pass('p1');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: foe, amount: 7 }],
    });
    if (sc.state.flow.combat?.awaitingAssignmentFrom === 'p1') {
      sc.do({
        type: 'ASSIGN_COMBAT_DAMAGE',
        playerId: 'p1',
        assignments: [{ unitId: titan, amount: 2 }],
      });
    }
    const hand = sc.player('p0').hand.length;
    settle(sc);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });

  it('"When you hold" fires for the Legend of the player who holds', () => {
    // Tests Rule 473: a Hold happens in the Scoring step
    const sc = Scenario.start(
      {},
      legendWith({ on: 'HOLD', effects: [{ op: 'GAIN_XP', amount: 1 }] }),
    );
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const xp = sc.player('p0').xp ?? 0;
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's Scoring step holds bf1
    settle(sc);
    expect(sc.player('p0').xp ?? 0).toBe(xp + 1);
  });
});

describe('parser: Legend player triggers (R101)', () => {
  it('reads "When you win a combat / hold" for Legends only', () => {
    // Tests Rule 303: parsed text
    expect(
      parseCardAbilities('When you win a combat, draw 1.', { legend: true })?.triggers[0]?.on,
    ).toBe('WIN_COMBAT');
    expect(parseCardAbilities('When you hold, gain 1 XP.', { legend: true })?.triggers[0]?.on).toBe(
      'HOLD',
    );
    // on a unit or gear the same words are a youScore trigger (fires at any battlefield)
    expect(parseCardAbilities('When you hold, gain 1 XP.')?.triggers[0]).toMatchObject({
      on: 'HOLD',
      youScore: true,
    });
  });
});

describe('scenario: Legend "When you conquer, if you have 4+ units at that battlefield" (Might of Demacia)', () => {
  const text = 'When you conquer, if you have 4+ units at that battlefield, draw 2.';

  it('reads the condition as a count at the scored battlefield', () => {
    // Tests Rule 303: parsed text
    expect(parseCardAbilities(text, { legend: true })?.triggers[0]).toMatchObject({
      on: 'CONQUER',
      effects: [{ op: 'DRAW', amount: 2 }],
      when: { kind: 'COUNT', what: 'unit', where: 'scored', who: 'friendly', cmp: 'GTE', n: 4 },
    });
  });

  it("counts the units at the battlefield that was scored, not the Legend's own location", () => {
    // Tests Rule 473: a Hold scores one battlefield; the count is of the units standing there
    const trig: CardTrigger = {
      on: 'HOLD',
      effects: [{ op: 'DRAW', amount: 1 }],
      when: { kind: 'COUNT', what: 'unit', where: 'scored', who: 'friendly', cmp: 'GTE', n: 2 },
    };
    const run = (units: number, inBase = 0): number => {
      const sc = Scenario.start({}, legendWith(trig));
      sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
      for (let i = 1; i < units; i++) sc.putUnit('p0', 'fx-archer', 'bf1');
      for (let i = 0; i < inBase; i++) sc.putUnit('p0', 'fx-ash-tank', 'base');
      const hand = sc.player('p0').hand.length;
      sc.endTurn('p0');
      sc.endTurn('p1');
      settle(sc);
      return sc.player('p0').hand.length - hand;
    };
    const lone = run(1);
    expect(run(2)).toBe(lone + 1);
    expect(run(1, 3)).toBe(lone); // units in the Base do not count
  });
});
