import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import {
  opponentSpellSurcharge,
  selfEnergyDiscount,
  staticPowerDiscount,
} from '../costReduction.js';
import { computeTotalCost } from '../resources.js';
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

describe('scenario: "Opponents\' spells cost [1] more. If this is [Empowered], they cost [1][A] more instead." (Helm of Suppression)', () => {
  const text =
    "Opponents' spells cost [1] more. If this is [Empowered], they cost [1][A] more instead.";
  const statics = parseStaticLines(text)?.statics ?? [];

  it('reads two statics: an Energy surcharge, replaced by a Power surcharge while Empowered', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(statics).toEqual([
      {
        affects: 'SELF',
        spellSurcharge: { energy: 1 },
        when: { kind: 'NOT', cond: { kind: 'EMPOWERED' } },
      },
      { affects: 'SELF', spellSurcharge: { energy: 1, anyPower: 1 }, when: { kind: 'EMPOWERED' } },
    ]);
  });

  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ember-totem': { ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef), statics },
  };

  it("adds to an opponent's spells only, and swaps the surcharge once Empowered", () => {
    // Tests Rule 584: the surcharge applies to opponents' spells
    const sc = Scenario.start({}, cards);
    const helm = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const spell = SCENARIO_CARDS['fx-plain-spell'] as CardDef;
    const unit = SCENARIO_CARDS['fx-tide-grunt'] as CardDef;
    expect(opponentSpellSurcharge(sc.state, cards, 'p1', spell)).toEqual({ energy: 1 });
    expect(opponentSpellSurcharge(sc.state, cards, 'p0', spell)).toBeNull(); // its own spells
    expect(opponentSpellSurcharge(sc.state, cards, 'p1', unit)).toBeNull(); // not a spell
    sc.state.objects[helm]!.empowered = true;
    expect(opponentSpellSurcharge(sc.state, cards, 'p1', spell)).toEqual({
      energy: 1,
      anyPower: 1,
    });
  });

  it('is charged when the opponent actually plays the spell', () => {
    // Tests Rule 584: the cost is paid in full
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    sc.giveRunes('p1', 4);
    const spell = sc.putInHand('p1', 'fx-plain-spell'); // costs 2
    sc.endTurn('p0');
    const before = sc.player('p1').base.filter((id) => sc.obj(id).ready).length;
    sc.play('p1', spell, { payment: sc.exhaustPlan('p1', 3) });
    const after = sc.player('p1').base.filter((id) => sc.obj(id).ready).length;
    expect(before - after).toBe(3); // 2 + the surcharge of 1
  });
});

describe('scenario: "[Empowered][>] Your spells cost [1][A] less, to a minimum of [1]" (Applied Researchers)', () => {
  const text = '[Empowered][>] Your spells cost [1][A] less, to a minimum of [1].';
  const statics = parseStaticLines(text)?.statics ?? [];

  it('reads an Energy and Power spell discount with a minimum, gated on Empowered', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(statics).toEqual([
      {
        affects: 'SELF',
        playCostMod: { energy: 1, anyPower: 1, min: 1, spellsOnly: true },
        when: { kind: 'EMPOWERED' },
      },
    ]);
  });

  it('takes [1] and one Power off a spell once Empowered, never below 1 Energy', () => {
    // Tests Rule 584: the discount applies while the source is Empowered
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': { ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef), statics },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        cost: { energy: 3, power: 1, domain: [{ element: 'Fury', amount: 1 }] },
      },
    };
    const sc = Scenario.start({}, cards);
    const researcher = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const spell = cards['fx-flare'] as CardDef;
    const id = sc.putInHand('p0', 'fx-flare');
    const cost = () =>
      computeTotalCost(spell, {
        discounts: [
          {
            energy: selfEnergyDiscount(sc.state, cards, 'p0', spell, id),
            power: staticPowerDiscount(sc.state, cards, 'p0', spell),
          },
        ],
      });
    const powerOf = (c: ReturnType<typeof cost>): number =>
      c.power.reduce((n, p) => n + p.amount, 0);
    expect([cost().energy, powerOf(cost())]).toEqual([3, 1]); // not Empowered: no discount
    sc.state.objects[researcher]!.empowered = true;
    expect([cost().energy, powerOf(cost())]).toEqual([2, 0]);
    // a unit is not a spell
    const unit = SCENARIO_CARDS['fx-grunt'] as CardDef;
    expect(staticPowerDiscount(sc.state, cards, 'p0', unit)).toBe(0);
  });
});
