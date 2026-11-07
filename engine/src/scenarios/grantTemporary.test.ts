import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (...effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), supportLevel: 'partial', effects },
});
function resolve(sc: Scenario, target: string): void {
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, {
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: target }],
  });
  sc.pass('p1');
  sc.pass('p0');
}

describe('scenario: "Give it [Temporary]" and "Double its Might" (R98)', () => {
  it("doubles the Might this turn and kills the unit at its controller's next Beginning Phase", () => {
    // Tests Rule 816: Temporary permanents are killed at the start of their controller's Beginning Phase
    const sc = Scenario.start(
      {},
      cast(
        { op: 'DOUBLE_MIGHT_TARGET', side: 'friendly' },
        { op: 'GRANT_TEMPORARY_TARGET', side: 'friendly' },
      ),
    );
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const before = effectiveMight(sc.state, sc.cards, u, { role: null });
    resolve(sc, u);
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(before * 2);
    sc.endTurn('p0');
    expect(sc.obj(u).zone.kind).toBe('base'); // the opponent's Beginning Phase does not touch it
    sc.endTurn('p1'); // p0's Beginning Phase
    expect(sc.obj(u).zone.kind).toBe('trash');
    sc.verify();
  });

  it('a gear can be made Temporary too, and a returned card is no longer Temporary', () => {
    // Tests Rule 816: the keyword stays with the permanent only while it is on the board
    const sc = Scenario.start({}, cast({ op: 'GRANT_TEMPORARY_TARGET', kind: 'gear' }));
    sc.giveRunes('p0', 3);
    const totem = sc.putInHand('p0', 'fx-ember-totem');
    sc.play('p0', totem, { payment: sc.exhaustPlan('p0', 2) });
    resolve(sc, totem);
    expect(sc.obj(totem).temporaryOf).toBeDefined();
    // Simulate the card leaving and re-entering: a new stay has a new enteredTurn.
    sc.obj(totem).enteredTurn = (sc.obj(totem).enteredTurn ?? 0) + 5;
    sc.endTurn('p0');
    sc.endTurn('p1');
    expect(sc.obj(totem).zone.kind).toBe('base');
  });
});

describe('parser: Temporary grants and doubling (R98)', () => {
  it('reads the phrases', () => {
    // Tests Rule 816: parsed text
    expect(parseSpellText('Give a gear [Temporary].')).toEqual([
      { op: 'GRANT_TEMPORARY_TARGET', kind: 'gear' },
    ]);
    expect(
      parseSpellText("Double a friendly unit's Might this turn. Give it [Temporary]."),
    ).toEqual([
      { op: 'DOUBLE_MIGHT_TARGET', side: 'friendly' },
      { op: 'GRANT_TEMPORARY_TARGET', side: 'friendly' },
    ]);
  });
});
