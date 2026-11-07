import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { selfEnergyDiscount } from '../costReduction.js';
import { parseSpellText, parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (...effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), supportLevel: 'partial', effects },
});

describe('scenario: "units you play this turn enter ready" (R105)', () => {
  it('readies units played later this turn, not after the turn ends', () => {
    // Tests Rule 359.2: units normally enter exhausted
    const sc = Scenario.start({}, cast({ op: 'ENTER_READY_THIS_TURN' }));
    sc.giveRunes('p0', 4);
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    sc.pass('p0');
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(g).ready).toBe(true);
    sc.endTurn('p0');
    sc.endTurn('p1');
    sc.giveRunes('p0', 2);
    const g2 = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g2, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(g2).ready).toBe(false);
  });
});

describe('scenario: "the next spell you play this turn costs N less" (R105)', () => {
  it('discounts the next spell once, then goes away', () => {
    // Tests Rule 156: a one-shot cost reduction
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const spell = sc.putInHand('p0', 'fx-flare');
    const unit = sc.putInHand('p0', 'fx-grunt');
    const ps = sc.state.players[0] as (typeof sc.state.players)[number];
    ps.nextPlayDiscount = { turn: sc.state.turn.number, energy: 1, spellsOnly: true };
    const flare = sc.cards['fx-flare'] as CardDef;
    expect(selfEnergyDiscount(sc.state, sc.cards, 'p0', flare, spell)).toBe(
      Math.min(1, flare.cost.energy),
    );
    const grunt = sc.cards['fx-grunt'] as CardDef;
    expect(selfEnergyDiscount(sc.state, sc.cards, 'p0', grunt, unit)).toBe(0); // not a spell
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', Math.max(0, flare.cost.energy - 1)) });
    expect(sc.state.players[0]?.nextPlayDiscount).toBeUndefined();
  });
});

describe('parser: turn-wide effects (R105)', () => {
  it('reads both sentence shapes', () => {
    // Tests Rule 156: parsed text
    expect(parseSpellText('Units you play this turn enter ready.')).toEqual([
      { op: 'ENTER_READY_THIS_TURN' },
    ]);
    expect(
      parseCardAbilities('When you play me, the next spell you play this turn costs [5] less.')
        ?.triggers[0]?.effects,
    ).toEqual([{ op: 'NEXT_PLAY_DISCOUNT', amount: 5, spellsOnly: true }]);
  });
});
