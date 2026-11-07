import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { selfEnergyDiscount } from '../costReduction.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, StaticAbility } from '../types/index.js';

const withStatic = (s: StaticAbility): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics: [s] },
  'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), cost: { energy: 3 } },
  'fx-titan': { ...(SCENARIO_CARDS['fx-titan'] as CardDef), subtypes: ['Dragon'] },
});
const discount = (sc: Scenario, who: string): number => {
  const def = sc.cards[sc.obj(who).cardId] as CardDef;
  return selfEnergyDiscount(sc.state, sc.cards, 'p0', def, who);
};

describe('scenario: cost modifiers from statics (R104)', () => {
  it('spells cost 1 less down to a minimum, only while the condition holds', () => {
    // Tests Rule 156: cost reductions never go below the stated minimum
    const sc = Scenario.start(
      {},
      withStatic({
        affects: 'SELF',
        playCostMod: { energy: 1, min: 1, spellsOnly: true },
        when: { kind: 'AT_BATTLEFIELD' },
      }),
    );
    const spell = sc.putInHand('p0', 'fx-flare');
    const unit = sc.putInHand('p0', 'fx-grunt');
    expect(discount(sc, spell)).toBe(0); // no source on the board
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(discount(sc, spell)).toBe(0); // the source is in the Base
    const sc2 = Scenario.start(
      {},
      withStatic({
        affects: 'SELF',
        playCostMod: { energy: 1, min: 1, spellsOnly: true },
        when: { kind: 'AT_BATTLEFIELD' },
      }),
    );
    sc2.putUnit('p0', 'fx-ash-tank', 'bf1');
    const s2 = sc2.putInHand('p0', 'fx-flare');
    const u2 = sc2.putInHand('p0', 'fx-grunt');
    expect(discount(sc2, s2)).toBe(1);
    expect(discount(sc2, u2)).toBe(0); // a unit is not a spell
    expect(unit).toBeDefined();
  });

  it('a subtype modifier lowers only that subtype and stops at the minimum', () => {
    // Tests Rule 156: the minimum bounds the discount
    const sc = Scenario.start(
      {},
      withStatic({ affects: 'SELF', playCostMod: { energy: 9, min: 2, subtype: 'Dragon' } }),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const dragon = sc.putInHand('p0', 'fx-titan');
    const other = sc.putInHand('p0', 'fx-grunt');
    const cost = (SCENARIO_CARDS['fx-titan'] as CardDef).cost.energy;
    expect(discount(sc, dragon)).toBe(Math.max(0, cost - 2));
    expect(discount(sc, other)).toBe(0);
  });
});

describe('parser: cost-modifier statics (R104)', () => {
  it('reads both phrasings', () => {
    // Tests Rule 156: parsed text
    expect(
      parseStaticLines(
        "While I'm at a battlefield, the Energy costs for spells you play is reduced by [1], to a minimum of [1].",
      )?.statics,
    ).toEqual([
      {
        affects: 'SELF',
        playCostMod: { energy: 1, min: 1, spellsOnly: true },
        when: { kind: 'AT_BATTLEFIELD' },
      },
    ]);
    expect(
      parseStaticLines("Your Dragons' Energy costs are reduced by [2], to a minimum of [1].")
        ?.statics,
    ).toEqual([{ affects: 'SELF', playCostMod: { energy: 2, min: 1, subtype: 'Dragon' } }]);
  });
});
