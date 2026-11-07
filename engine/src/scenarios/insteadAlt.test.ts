import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (effect: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [effect],
  },
});

/** p0 casts the Flare on `target` and lets it resolve. */
function resolve(sc: Scenario, target: string): void {
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, {
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: target }],
  });
  sc.pass('p1');
  sc.pass('p0');
}

describe('scenario: "... instead" alternatives (R81)', () => {
  const buff: CardEffect = {
    op: 'BUFF_TARGET',
    amount: 2,
    duration: 'TURN',
    alt: { amount: 4, target: 'EMPOWERED' },
  };

  it('uses the normal amount, then the alternative when the unit is Empowered', () => {
    // Tests Rule 359.3: the spell's effect resolves with the amount its condition selects
    const sc = Scenario.start({}, cast(buff));
    const plain = sc.putUnit('p0', 'fx-grunt', 'base');
    const before = effectiveMight(sc.state, sc.cards, plain, { role: null });
    resolve(sc, plain);
    expect(effectiveMight(sc.state, sc.cards, plain, { role: null })).toBe(before + 2);

    const sc2 = Scenario.start({}, cast(buff));
    const emp = sc2.putUnit('p0', 'fx-grunt', 'base');
    sc2.obj(emp).empowered = true;
    const b2 = effectiveMight(sc2.state, sc2.cards, emp, { role: null });
    resolve(sc2, emp);
    expect(effectiveMight(sc2.state, sc2.cards, emp, { role: null })).toBe(b2 + 4);
    sc2.verify();
  });

  it('a controller condition selects the alternative damage (facedown card, Level)', () => {
    // Tests Rule 359.3: "If you control a facedown card, deal 4 to it instead"
    const dmg: CardEffect = {
      op: 'DAMAGE_TARGET',
      amount: 1,
      alt: { amount: 3, when: { kind: 'XP', n: 2 } },
    };
    const low = Scenario.start({}, cast(dmg));
    const t1 = low.putUnit('p1', 'fx-order-titan', 'base');
    resolve(low, t1);
    expect(low.obj(t1).damage).toBe(1);

    const high = Scenario.start({}, cast(dmg));
    (high.state.players[0] as (typeof high.state.players)[number]).xp = 2;
    const t2 = high.putUnit('p1', 'fx-order-titan', 'base');
    resolve(high, t2);
    expect(high.obj(t2).damage).toBe(3);
  });

  it('a [Buff] with a "buffed" alternative gives +N this turn to an already buffed unit', () => {
    // Tests Rule 359.3: the alternative replaces the whole effect
    const e: CardEffect = {
      op: 'BUFF_TARGET',
      amount: 1,
      buff: true,
      alt: { amount: 2, target: 'BUFFED', temp: true },
    };
    const sc = Scenario.start({}, cast(e));
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    resolve(sc, u);
    expect(sc.obj(u).buffed).toBe(true);
    const mid = effectiveMight(sc.state, sc.cards, u, { role: null });
    resolve(sc, u);
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(mid + 2);
  });
});

describe('parser: "... instead" (R81)', () => {
  it('attaches the alternative to the previous effect', () => {
    // Tests Rule 359.3: parsed spell text
    expect(
      parseSpellText(
        "Give a unit +2 [M] this turn. If it's [Empowered], give it +4 [M] this turn instead.",
      ),
    ).toEqual([
      { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', alt: { amount: 4, target: 'EMPOWERED' } },
    ]);
    expect(
      parseSpellText("Deal 2 to a unit at a battlefield. If it's attacking, deal 4 to it instead."),
    ).toEqual([
      {
        op: 'DAMAGE_TARGET',
        amount: 2,
        atBattlefield: true,
        alt: { amount: 4, target: 'ATTACKING' },
      },
    ]);
  });

  it('refuses an "instead" with nothing to replace', () => {
    // Tests Rule 359.3: all-or-nothing parsing
    expect(parseSpellText("If it's attacking, deal 4 to it instead.")).toBeNull();
  });
});

describe('scenario: if the unit is attacking (R81)', () => {
  const dmg: CardEffect = {
    op: 'DAMAGE_TARGET',
    amount: 1,
    atBattlefield: true,
    alt: { amount: 3, target: 'ATTACKING' },
  };
  /** A combat Showdown at bf1; p0 hits either its attacker or the defender. */
  function hit(which: 'attacker' | 'defender'): number {
    // Tests Rule 466.2.c: the units of the attacking player are the Attackers
    const sc = Scenario.start({}, cast(dmg));
    const defender = sc.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
    const attacker = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [attacker],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.giveRunes('p0', 2);
    const target = which === 'attacker' ? attacker : defender;
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: target }],
    });
    sc.pass('p1');
    sc.pass('p0');
    return sc.obj(target).damage;
  }

  it('only the attacking unit takes the alternative damage', () => {
    // Tests Rule 466.2.c: attackers versus defenders
    expect(hit('defender')).toBe(1);
    expect(hit('attacker')).toBe(3);
  });
});
