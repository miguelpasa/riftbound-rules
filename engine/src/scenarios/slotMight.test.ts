import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [
      { op: 'READY_TARGET', side: 'friendly' },
      {
        op: 'DAMAGE_TARGET',
        amount: 0,
        side: 'enemy',
        slot: 1,
        amountFrom: 'SLOT_MIGHT',
        amountSlot: 0,
        amountSlotSide: 'friendly',
      },
    ],
  },
};

describe('scenario: "It deals damage equal to its Might" (R94)', () => {
  it('the chosen friendly unit readies and the chosen enemy takes damage equal to its Might', () => {
    // Tests Rule 143.2: damage equal to a unit's Might
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-titan', 'base');
    const foe = sc.putUnit('p1', 'fx-order-titan', 'base');
    sc.setReady(mine, false);
    const m = effectiveMight(sc.state, sc.cards, mine, { role: null });
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [
        { kind: 'object', id: mine },
        { kind: 'object', id: foe },
      ],
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(mine).ready).toBe(true);
    const hit = sc.obj(foe).zone.kind === 'trash' ? 'dead' : sc.obj(foe).damage;
    expect(hit === 'dead' || hit === m).toBe(true);
    expect(sc.obj(mine).damage).toBe(0);
  });

  it('needs both units: the dealer is a requirement even though only the second slot is hit', () => {
    // Tests Rule 355.10: every chosen unit must be legal
    const sc = Scenario.start({}, cards);
    const foe = sc.putUnit('p1', 'fx-order-titan', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: spell,
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: foe }],
      }).code,
    ).toBeDefined();
  });
});

describe('parser: one-way Might damage (R94)', () => {
  it('reads "It deals damage equal to its Might to <unit>" after a chosen unit', () => {
    // Tests Rule 143.2: parsed text
    expect(
      parseSpellText(
        'Ready a friendly unit. It deals damage equal to its Might to an enemy unit at a battlefield.',
      ),
    ).toEqual([
      { op: 'READY_TARGET', side: 'friendly' },
      {
        op: 'DAMAGE_TARGET',
        amount: 0,
        side: 'enemy',
        atBattlefield: true,
        slot: 1,
        amountFrom: 'SLOT_MIGHT',
        amountSlot: 0,
        amountSlotSide: 'friendly',
      },
    ]);
  });
});
