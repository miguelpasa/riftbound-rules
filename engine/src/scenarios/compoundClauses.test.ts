import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseClause } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

describe('parser: "X and Y" self clauses (R102)', () => {
  it('splits two target-free clauses and keeps their order', () => {
    // Tests Rule 359.3: effects resolve in the order written
    expect(parseClause('Ready me and give me +2 [M] this turn')).toEqual([
      { op: 'READY_SELF' },
      { op: 'BUFF_SELF', amount: 2 },
    ]);
    expect(parseClause('Give me +2 [M] this turn and ready me')).toEqual([
      { op: 'BUFF_SELF', amount: 2 },
      { op: 'READY_SELF' },
    ]);
    expect(parseClause('Channel 2 runes exhausted and draw 1')).toEqual([
      { op: 'CHANNEL', amount: 2, exhausted: true },
      { op: 'DRAW', amount: 1 },
    ]);
  });

  it('does not split clauses that need a target or that are not understood', () => {
    // Tests Rule 359.3: all-or-nothing parsing
    expect(parseClause('Kill a unit and draw 1')).toBeNull();
    expect(parseClause('Ready me and juggle')).toBeNull();
    expect(parseClause('Draw 1 and draw 2 and draw 3')).toBeNull();
  });
});

describe('scenario: a compound self clause resolves both parts (R102)', () => {
  it('ready me and give me +2 on a trigger', () => {
    // Tests Rule 359.3: both effects happen
    const effects = parseCardAbilities('When you play me, ready me and give me +2 [M] this turn.')
      ?.triggers[0]?.effects;
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [{ on: 'PLAY', effects: effects ?? [] }],
      },
    };
    const sc = Scenario.start({}, cards);
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(g).ready).toBe(true);
    expect(effectiveMight(sc.state, sc.cards, g, { role: null })).toBe(
      (SCENARIO_CARDS['fx-grunt']?.stats.might ?? 0) + 2,
    );
  });
});
