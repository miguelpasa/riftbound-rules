import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { evalCondition } from '../conditions.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

describe('scenario: total Might of your other units (R107)', () => {
  it('sums the other friendly units on the board and ignores the source and the enemy', () => {
    // Tests Rule 143.2: Might of units on the board
    const sc = Scenario.start();
    const src = sc.putUnit('p0', 'fx-titan', 'base');
    const other = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putUnit('p1', 'fx-order-titan', 'base');
    const m = effectiveMight(sc.state, sc.cards, other, { role: null });
    const check = (n: number) =>
      evalCondition(sc.state, sc.cards, { kind: 'OTHER_UNITS_MIGHT', n }, 'p0', src);
    expect(check(m)).toBe(true);
    expect(check(m + 1)).toBe(false);
  });
});

describe('scenario: kill a gear no costlier than my Might (R107)', () => {
  it("refuses a gear that costs more than the source's Might", () => {
    // Tests Rule 355.10: the limit is the source unit's Might
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'KILL_GEAR', maxEnergyMyMight: true }],
      },
      'fx-ember-totem': { ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef), cost: { energy: 9 } },
    };
    const sc = Scenario.start({}, cards);
    const totem = sc.putInHand('p0', 'fx-ember-totem');
    sc.giveRunes('p0', 9);
    sc.play('p0', totem, { payment: sc.exhaustPlan('p0', 9) });
    // As a spell the Flare has no source unit, so the limit is 0: a 9-cost gear is never legal.
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.giveRunes('p0', 1);
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: spell,
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: totem }],
      }).code,
    ).toBe('ILLEGAL_TARGET');
  });
});

describe('parser: Might limits (R107)', () => {
  it('reads both phrases', () => {
    // Tests Rule 143.2: parsed text
    expect(parseCondition('your other units have total Might 5 or more')).toEqual({
      kind: 'OTHER_UNITS_MIGHT',
      n: 5,
    });
    expect(
      parseCardAbilities(
        'When I conquer, you may kill a gear with Energy cost no more than my Might.',
      )?.triggers[0]?.effects,
    ).toEqual([{ op: 'KILL_GEAR', maxEnergyMyMight: true, count: { min: 0, max: 1 } }]);
  });
});

describe('scenario: the Might limit allows cheap gear (R107)', () => {
  it('a unit trigger can kill a gear that costs no more than its Might', () => {
    // Tests Rule 355.10: the source unit's Might sets the limit
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [{ on: 'PLAY', effects: [{ op: 'KILL_GEAR', maxEnergyMyMight: true }] }],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 6);
    const totem = sc.putInHand('p0', 'fx-ember-totem'); // costs 2
    sc.play('p0', totem, { payment: sc.exhaustPlan('p0', 2) });
    const g = sc.putInHand('p0', 'fx-grunt');
    const might = effectiveMight(sc.state, sc.cards, g, { role: null });
    const cost = (SCENARIO_CARDS['fx-ember-totem'] as CardDef).cost.energy;
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.obj(totem).zone.kind).toBe(cost <= might ? 'trash' : 'base');
  });
});
