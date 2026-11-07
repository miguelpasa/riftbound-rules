import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const titanWith = (effect: CardEffect, n: number): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-titan': {
    ...(SCENARIO_CARDS['fx-titan'] as CardDef),
    triggers: [{ on: 'CONQUER', when: { kind: 'EXCESS_DAMAGE', n }, effects: [effect] }],
  },
});

/** p0's Titan attacks a lone defender and puts all its Might on it; returns p0's hand size change. */
function conquer(defenderCard: string, cards: CardDatabase): { drawn: number; sc: Scenario } {
  const sc = Scenario.start({}, cards);
  const def = sc.putUnit('p1', defenderCard, 'bf1', { control: true });
  const titan = sc.putUnit('p0', 'fx-titan', 'base');
  sc.do({
    type: 'STANDARD_MOVE',
    playerId: 'p0',
    unitIds: [titan],
    destination: { kind: 'battlefield', battlefieldId: 'bf1' },
  });
  sc.pass('p0');
  sc.pass('p1');
  const mine = effectiveMight(sc.state, sc.cards, titan, { role: 'ATTACKER' });
  sc.do({
    type: 'ASSIGN_COMBAT_DAMAGE',
    playerId: 'p0',
    assignments: [{ unitId: def, amount: mine }],
  });
  const theirs = effectiveMight(sc.state, sc.cards, def, { role: 'DEFENDER' });
  if (sc.state.flow.combat?.awaitingAssignmentFrom === 'p1') {
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: [{ unitId: titan, amount: theirs }],
    });
  }
  const hand = sc.player('p0').hand.length;
  for (let i = 0; i < 8 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
  return { drawn: sc.player('p0').hand.length - hand, sc };
}

describe('scenario: excess combat damage (R87)', () => {
  const draw: CardEffect = { op: 'DRAW', amount: 1 };

  it('a conquer trigger sees the damage assigned beyond what was needed', () => {
    // Tests Rule 467.2: the attacker may assign more than lethal damage
    const cards = titanWith(draw, 3);
    // Titan has 7 Might; a 2-Might defender needs 2, so about 5 is excess.
    expect(conquer('fx-tide-grunt', cards).drawn).toBe(1);
  });

  it('little excess does not satisfy a high threshold', () => {
    // Tests Rule 467.2: excess is damage beyond lethal
    const cards = titanWith(draw, 9);
    expect(conquer('fx-tide-grunt', cards).drawn).toBe(0);
  });

  it('"deal that much" uses the recorded excess', () => {
    // Tests Rule 467.2: the excess amount is available to the conquer trigger's effects
    const cards = titanWith(
      { op: 'DAMAGE_TARGET', amount: 0, amountFrom: 'EXCESS', side: 'enemy' },
      1,
    );
    const sc = Scenario.start({}, cards);
    const bystander = sc.putUnit('p1', 'fx-order-titan', 'base');
    const def = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [titan],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1');
    const mine = effectiveMight(sc.state, sc.cards, titan, { role: 'ATTACKER' });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: def, amount: mine }],
    });
    if (sc.state.flow.combat?.awaitingAssignmentFrom === 'p1') {
      sc.do({
        type: 'ASSIGN_COMBAT_DAMAGE',
        playerId: 'p1',
        assignments: [
          {
            unitId: titan,
            amount: effectiveMight(sc.state, sc.cards, def, { role: 'DEFENDER' }),
          },
        ],
      });
    }
    for (let i = 0; i < 8 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    const excess = sc.state.players[0]?.excessRecord?.amount ?? 0;
    expect(excess).toBeGreaterThan(0);
    expect(sc.obj(bystander).damage).toBe(excess);
  });
});

describe('parser: excess damage (R87)', () => {
  it('reads the condition and "deal that much"', () => {
    // Tests Rule 467.2: parsed text
    expect(parseCondition('you assigned 5 or more excess damage to enemy units')).toEqual({
      kind: 'EXCESS_DAMAGE',
      n: 5,
    });
    expect(
      parseCardAbilities(
        'When I conquer after an attack, if you assigned 5 or more excess damage to enemy units, you may deal that much to an enemy unit.',
      )?.triggers[0]?.effects,
    ).toEqual([
      {
        op: 'DAMAGE_TARGET',
        amount: 0,
        side: 'enemy',
        amountFrom: 'EXCESS',
        count: { min: 0, max: 1 },
      },
    ]);
  });
});
