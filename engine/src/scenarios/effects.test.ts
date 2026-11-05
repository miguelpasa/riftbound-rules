import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

// Override an in-deck fixture spell (fx-flare is in player p0's deck) with executable effects.
const withEffects = (effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    text: '[Action] test effect',
    supportLevel: 'partial',
    effects,
  },
});

describe('scenario: executable spell effects', () => {
  it('a spell with a DRAW effect draws on resolution and shows no unimplemented event', () => {
    // Tests Rule 359.3: a spell's effects happen as it resolves, then it goes to the Trash
    const sc = Scenario.start({}, withEffects([{ op: 'DRAW', amount: 2 }]));
    const spell = sc.putInHand('p0', 'fx-flare');
    const handBefore = sc.player('p0').hand.length;
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toHaveLength(2);
    expect(sc.eventsOfType('EFFECT_UNIMPLEMENTED', r.events)).toHaveLength(0);
    expect(sc.player('p0').hand.length).toBe(handBefore - 1 + 2);
    expect(sc.obj(spell).zone.kind).toBe('trash');
    sc.verify();
  });

  it('a GAIN_POINT effect scores for the controller', () => {
    // Tests Rule 359.3: effects resolve before the spell is trashed
    const sc = Scenario.start({}, withEffects([{ op: 'GAIN_POINT', amount: 1 }]));
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.player('p0').points).toBe(1);
    sc.verify();
  });
});

describe('scenario: targeted spell effects', () => {
  it('DAMAGE_TARGET marks damage and Cleanup kills a lethally damaged unit', () => {
    // Tests Rule 323: Cleanup kills units with damage >= Might
    const sc = Scenario.start({}, withEffects([{ op: 'DAMAGE_TARGET', amount: 99 }]));
    const victim = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: victim }],
    });
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.eventsOfType('EFFECT_DAMAGE', r.events)).toHaveLength(1);
    expect(sc.obj(victim).zone.kind).toBe('trash');
    sc.verify();
  });

  it('BUFF_TARGET raises Might; a missing target fizzles', () => {
    // Tests Rule 359.3: an effect whose target is gone does nothing
    const sc = Scenario.start({}, withEffects([{ op: 'BUFF_TARGET', amount: 2 }]));
    const ally = sc.putUnit('p0', 'fx-grunt', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: ally }],
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(ally).mightBonus).toBe(2);

    const sc2 = Scenario.start({}, withEffects([{ op: 'BUFF_TARGET', amount: 2 }]));
    const s2 = sc2.putInHand('p0', 'fx-flare');
    sc2.play('p0', s2, { payment: sc2.exhaustPlan('p0', 1) });
    sc2.pass('p1');
    const r = sc2.pass('p0');
    expect(sc2.eventsOfType('EFFECT_FIZZLED', r.events)).toHaveLength(1);
  });
});
