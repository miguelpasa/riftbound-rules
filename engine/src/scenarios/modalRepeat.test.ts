import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { parseModalSpell, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

describe('scenario: modal spell with Repeat (R84)', () => {
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-flare': {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      modes: [[{ op: 'DRAW', amount: 1 }], [{ op: 'DRAW', amount: 2 }]],
      repeatCost: { energy: 1, power: 0 },
    },
  };
  const draws = (mode: number, repeat: boolean): number => {
    const sc = Scenario.start({}, cards);
    const spell = sc.putInHand('p0', 'fx-flare');
    const before = sc.player('p0').hand.length - 1;
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', repeat ? 2 : 1),
      mode,
      ...(repeat ? { additionalCosts: { repeat: true } } : {}),
    } as never);
    for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(actorToAct(sc.state));
    sc.verify();
    return sc.player('p0').hand.length - before;
  };

  it('repeats the chosen mode once more when the Repeat cost is paid', () => {
    // Tests Rule 820: Repeat makes the effect happen twice
    expect(draws(0, false)).toBe(1);
    expect(draws(0, true)).toBe(2);
    expect(draws(1, true)).toBe(4);
  });
});

describe('scenario: damage to a unit in a base (R84)', () => {
  it('only units standing in a Base are legal targets', () => {
    // Tests Rule 355.10: the target must match "a unit in a base"
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'DAMAGE_TARGET', amount: 1, inBase: true }],
      },
    };
    const sc = Scenario.start({}, cards);
    const home = sc.putUnit('p1', 'fx-order-titan', 'base');
    const away = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const spell = sc.putInHand('p0', 'fx-flare');
    const base = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      cardInstanceId: spell,
      payment: sc.exhaustPlan('p0', 1),
    };
    expect(sc.reject({ ...base, targets: [{ kind: 'object', id: away }] }).code).toBe(
      'ILLEGAL_TARGET',
    );
    sc.play('p0', spell, { payment: base.payment, targets: [{ kind: 'object', id: home }] });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(home).damage).toBe(1);
  });
});

describe('parser: modal Repeat and base targets (R84)', () => {
  it('accepts a Repeat line before the modes and reads "in a base"', () => {
    // Tests Rule 820: parsed spell text
    const modes = parseModalSpell(
      '[Repeat] [4][C]\nChoose one —\n- Deal 4 to a unit in a base.\n- Kill a gear.',
    );
    expect(modes).toEqual([
      [{ op: 'DAMAGE_TARGET', amount: 4, inBase: true }],
      [{ op: 'KILL_GEAR' }],
    ]);
    expect(parseSpellText('Deal 4 to a unit in a base.')).toEqual([
      { op: 'DAMAGE_TARGET', amount: 4, inBase: true },
    ]);
  });
});
