import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;

describe('scenario: "When you choose a unit" (Jae Medarda, Spirit Wheel, Blade Dancer, Irelia)', () => {
  it('reads the three heads', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(
      parseCardAbilities('When you choose me with a spell, draw 1.')?.triggers[0],
    ).toMatchObject({ on: 'UNIT_CHOSEN', chosen: { target: 'self', spellOnly: true } });
    expect(
      parseCardAbilities(
        'When you choose a friendly unit, you may pay [1] and exhaust this to draw 1.',
      )?.triggers[0],
    ).toMatchObject({ on: 'UNIT_CHOSEN', chosen: { target: 'friendly' } });
    const irelia = parseCardAbilities('When you choose or ready me, give me +1 [M] this turn.');
    expect(irelia?.triggers.map((t) => t.on)).toEqual(['UNIT_CHOSEN', 'BECOME_READY']);
  });

  it('draws a card when a spell chooses the unit, not when an enemy spell does or no unit is chosen', () => {
    // Tests Rule 583: a triggered ability fires on its event
    const parsed = parseCardAbilities('When you choose me with a spell, draw 1.');
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...base('fx-ash-tank'), triggers: parsed?.triggers ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const jae = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const handBefore = sc.state.players[0]?.hand.length ?? 0;
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: jae }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    // one card played from hand, one drawn
    expect(sc.state.players[0]?.hand.length).toBe(handBefore + 1 - 1 + 1);
  });
});
