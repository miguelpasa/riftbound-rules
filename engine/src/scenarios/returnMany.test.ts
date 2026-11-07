import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), supportLevel: 'partial', effects },
});

describe('scenario: returning several units (R82)', () => {
  it('"Return all units with N Might or less" returns exactly the small units of both players', () => {
    // Tests Rule 160: units return to their owners' hands
    const sc = Scenario.start({}, cast([{ op: 'RETURN_ALL_UNITS', maxMight: 3 }]));
    const smallMine = sc.putUnit('p0', 'fx-grunt', 'base');
    const smallTheirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const bigTheirs = sc.putUnit('p1', 'fx-order-titan', 'base');
    expect(effectiveMight(sc.state, sc.cards, smallMine, { role: null })).toBeLessThanOrEqual(3);
    expect(effectiveMight(sc.state, sc.cards, bigTheirs, { role: null })).toBeGreaterThan(3);
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(smallMine).zone.kind).toBe('hand');
    expect(sc.obj(smallTheirs).zone.kind).toBe('hand');
    expect(sc.obj(bigTheirs).zone.kind).toBe('base');
    sc.verify();
  });

  it('"a friendly unit and an enemy unit" needs and returns one of each', () => {
    // Tests Rule 160: two separately chosen units
    const sc = Scenario.start(
      {},
      cast([
        { op: 'RETURN_TARGET', side: 'friendly' },
        { op: 'RETURN_TARGET', side: 'enemy', slot: 1 },
      ]),
    );
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    // No enemy unit yet: the spell cannot be played.
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: spell,
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: mine }],
      }).code,
    ).toBeDefined();
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [
        { kind: 'object', id: mine },
        { kind: 'object', id: theirs },
      ],
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(mine).zone.kind).toBe('hand');
    expect(sc.obj(theirs).zone.kind).toBe('hand');
  });
});

describe('parser: returning several units (R82)', () => {
  it('reads both phrases', () => {
    // Tests Rule 160: parsed text
    expect(
      parseSpellText("Return a friendly unit and an enemy unit to their owners' hands."),
    ).toEqual([
      { op: 'RETURN_TARGET', side: 'friendly' },
      { op: 'RETURN_TARGET', side: 'enemy', slot: 1 },
    ]);
    expect(
      parseCardAbilities(
        "When you play me, return all units with 2 [M] or less to their owners' hands.",
      )?.triggers[0]?.effects,
    ).toEqual([{ op: 'RETURN_ALL_UNITS', maxMight: 2 }]);
  });
});
