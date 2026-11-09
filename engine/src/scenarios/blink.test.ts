import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance } from '../types/index.js';

const cards: CardDatabase = {
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    effects: [{ op: 'BLINK_TARGET', to: 'BASE', side: 'friendly' }, { op: 'BANISH_THIS_SPELL' }],
  },
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'PLAY', effects: [{ op: 'DRAW', amount: 1 }] }],
  },
};

describe('scenario: banish a unit, then play it again (X5)', () => {
  it('the unit comes back to its base as a fresh exhausted object and its play trigger fires', () => {
    // Tests Rule 560.1.a: playing a card ignoring its cost; a played unit is a new object
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 4);
    const u = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true, damage: 1, mightBonus: 2 });
    const flare = sc.putInHand('p0', 'fx-flare');
    const handBefore = sc.player('p0').hand.length;
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: u }],
    });
    for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    const o = sc.state.objects[u] as CardInstance;
    expect(o.zone.kind).toBe('base');
    expect(o.ready).toBe(false);
    expect(o.damage).toBe(0);
    expect(o.mightBonus).toBe(0);
    expect(sc.player('p0').hand.length).toBe(handBefore - 1 + 1); // played the spell, drew from the trigger
    expect((sc.state.objects[flare] as CardInstance).zone.kind).toBe('banishment');
  });

  it('parses Portal Rescue, Temporal Breach and Arcane Shift text', () => {
    // Tests Rule 560.1.a: ignoring its cost
    expect(
      parseSpellText(
        'Banish a friendly unit, then its owner plays it to their base, ignoring its cost.',
      ),
    ).toEqual([{ op: 'BLINK_TARGET', to: 'BASE', side: 'friendly' }]);
    expect(
      parseSpellText(
        'Banish a unit, then its owner plays it to the same location, ignoring its cost.',
      ),
    ).toEqual([{ op: 'BLINK_TARGET', to: 'SAME' }]);
    expect(
      parseSpellText(
        'Banish a friendly unit, then its owner plays it, ignoring its cost. Deal 3 to an enemy unit at a battlefield. Banish this.',
      ),
    ).toEqual([
      { op: 'BLINK_TARGET', to: 'BASE', side: 'friendly' },
      { op: 'DAMAGE_TARGET', amount: 3, side: 'enemy', atBattlefield: true, slot: 1 },
      { op: 'BANISH_THIS_SPELL' },
    ]);
  });
});
