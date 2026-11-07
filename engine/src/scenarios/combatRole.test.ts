import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, Condition } from '../types/index.js';

const bf1 = { kind: 'battlefield' as const, battlefieldId: 'bf1' };
const withStatic = (when: Condition): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    statics: [{ affects: 'SELF', might: 2, when }],
  },
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [{ op: 'STUN_TARGET', attacking: true }],
  },
});

describe('scenario: combat-role statics (R95)', () => {
  it('"attacking or defending alone" applies only in a combat, and only without company', () => {
    // Tests Rule 466.2.c: Attackers and Defenders are the units in the combat
    const cond: Condition = { kind: 'COMBAT_ROLE', role: 'EITHER', alone: true };
    const sc = Scenario.start({}, withStatic(cond));
    sc.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    const base = effectiveMight(sc.state, sc.cards, g, { role: null });
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [g], destination: bf1 });
    expect(effectiveMight(sc.state, sc.cards, g, { role: 'ATTACKER' })).toBeGreaterThanOrEqual(
      base + 2,
    );

    const crowded = Scenario.start({}, withStatic(cond));
    crowded.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
    const a = crowded.putUnit('p0', 'fx-grunt', 'base');
    const b = crowded.putUnit('p0', 'fx-ash-tank', 'base');
    crowded.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [a, b], destination: bf1 });
    expect(effectiveMight(crowded.state, crowded.cards, a, { role: 'ATTACKER' })).toBe(base);
  });

  it('"attacking with another unit" needs company', () => {
    // Tests Rule 466.2.c: another friendly attacker at the battlefield
    const cond: Condition = { kind: 'COMBAT_ROLE', role: 'ATTACKING', withOther: true };
    const sc = Scenario.start({}, withStatic(cond));
    sc.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const b = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const base = effectiveMight(sc.state, sc.cards, a, { role: null });
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [a, b], destination: bf1 });
    expect(effectiveMight(sc.state, sc.cards, a, { role: 'ATTACKER' })).toBeGreaterThanOrEqual(
      base + 2,
    );
  });
});

describe('scenario: "Stun an attacking unit" (R95)', () => {
  it('can only target a unit attacking in the current combat', () => {
    // Tests Rule 355.10: the target must match the spell text
    const sc = Scenario.start({}, withStatic({ kind: 'COMBAT_ROLE', role: 'EITHER' }));
    const defender = sc.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
    const attacker = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [attacker], destination: bf1 });
    const spell = sc.putInHand('p0', 'fx-flare');
    const base = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      cardInstanceId: spell,
      payment: sc.exhaustPlan('p0', 1),
    };
    expect(sc.reject({ ...base, targets: [{ kind: 'object', id: defender }] }).code).toBe(
      'ILLEGAL_TARGET',
    );
    sc.play('p0', spell, { payment: base.payment, targets: [{ kind: 'object', id: attacker }] });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(attacker).stunned).toBe(true);
  });
});

describe('parser: combat roles (R95)', () => {
  it('reads both statics and the attacking filter', () => {
    // Tests Rule 466.2.c: parsed text
    expect(
      parseStaticLines("While I'm attacking or defending alone, I have +2 [M].")?.statics,
    ).toEqual([
      { affects: 'SELF', might: 2, when: { kind: 'COMBAT_ROLE', role: 'EITHER', alone: true } },
    ]);
    expect(
      parseStaticLines("I have +2 [M] while I'm attacking with another unit.")?.statics,
    ).toEqual([
      {
        affects: 'SELF',
        might: 2,
        when: { kind: 'COMBAT_ROLE', role: 'ATTACKING', withOther: true },
      },
    ]);
  });
});
