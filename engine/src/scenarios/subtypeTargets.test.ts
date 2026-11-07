import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (effect: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [effect],
  },
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), subtypes: ['Mech'] },
  'fx-order-titan': { ...(SCENARIO_CARDS['fx-order-titan'] as CardDef), subtypes: ['Dragon'] },
});
function tryCast(sc: Scenario, target: string) {
  const spell = sc.putInHand('p0', 'fx-flare');
  return sc.reject({
    type: 'PLAY_CARD',
    playerId: 'p0',
    cardInstanceId: spell,
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: target }],
  });
}

describe('scenario: subtype-limited targets (R106)', () => {
  it('"ready a Mech" refuses a unit that is not a Mech', () => {
    // Tests Rule 355.10: the target must match the text
    const sc = Scenario.start({}, cast({ op: 'READY_TARGET', side: 'friendly', subtype: 'Mech' }));
    const grunt = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(tryCast(sc, grunt).code).toBe('ILLEGAL_TARGET');
  });

  it('"a non-Dragon unit" refuses a Dragon and takes anything else', () => {
    // Tests Rule 355.10: a forbidden subtype is not a legal target
    const sc = Scenario.start({}, cast({ op: 'RETURN_TARGET', notSubtype: 'Dragon' }));
    const dragon = sc.putUnit('p1', 'fx-order-titan', 'base');
    expect(tryCast(sc, dragon).code).toBe('ILLEGAL_TARGET');
    const sc2 = Scenario.start({}, cast({ op: 'RETURN_TARGET', notSubtype: 'Dragon' }));
    const grunt = sc2.putUnit('p1', 'fx-tide-grunt', 'base');
    const spell = sc2.putInHand('p0', 'fx-flare');
    sc2.play('p0', spell, {
      payment: sc2.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: grunt }],
    });
    sc2.pass('p1');
    sc2.pass('p0');
    expect(sc2.obj(grunt).zone.kind).toBe('hand');
  });
});

describe('parser: subtype targets (R106)', () => {
  it('reads both shapes', () => {
    // Tests Rule 355.10: parsed text
    expect(
      parseCardAbilities('When you play me, ready another friendly Mech.')?.triggers[0]?.effects,
    ).toEqual([{ op: 'READY_TARGET', side: 'friendly', another: true, subtype: 'Mech' }]);
    expect(
      parseCardAbilities("When you play me, you may return a non-Dragon unit to its owner's hand.")
        ?.triggers[0]?.effects,
    ).toEqual([{ op: 'RETURN_TARGET', notSubtype: 'Dragon', count: { min: 0, max: 1 } }]);
  });
});
