import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCondition, parseSelfCostReduction } from '../cardText.js';
import { evalCondition } from '../conditions.js';

const TEXT = 'I cost [2][C] less if you control a battlefield with exactly two units there.';

describe('scenario: "I cost [2][C] less if you control a battlefield with exactly two units there" (Keeper of Law)', () => {
  it('reads the cost reduction and its condition', () => {
    // Tests Rule 356: costs are reduced by discounts
    expect(parseCondition('you control a battlefield with exactly two units there')).toEqual({
      kind: 'BATTLEFIELD_WITH_UNITS',
      n: 2,
    });
    expect(parseSelfCostReduction(TEXT)?.reduction).toEqual({
      energy: 2,
      power: 1,
      when: { kind: 'BATTLEFIELD_WITH_UNITS', n: 2 },
    });
  });

  it('holds only while a battlefield you control has exactly two of your units', () => {
    // Tests Rule 356: the condition is checked as the card is played
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const cond = { kind: 'BATTLEFIELD_WITH_UNITS' as const, n: 2 };
    const holds = (): boolean => evalCondition(sc.state, sc.cards, cond, 'p0', 'x');
    expect(holds()).toBe(false);
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    expect(holds()).toBe(false); // one unit
    sc.putUnit('p0', 'fx-archer', 'bf0');
    expect(holds()).toBe(true); // exactly two
    sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    expect(holds()).toBe(false); // three
  });
});
