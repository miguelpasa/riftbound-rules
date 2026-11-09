import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance } from '../types/index.js';

const cards: CardDatabase = {
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-ember-totem': {
    ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
    statics: [{ affects: 'FRIENDLY_UNITS', might: 2 }],
    triggers: [{ on: 'YOU_PLAY', playFilter: { type: 'UNIT' }, effects: [{ op: 'KILL_SELF' }] }],
  },
};

describe('scenario: "Kill this" and "Your units have +N" (Ephemeral Ward pattern)', () => {
  it('buffs every friendly unit until a unit is played, then the gear kills itself', () => {
    // Tests Rule 583.3: a triggered ability kills its own source
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 4);
    const totem = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const mate = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const printed = SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0;
    expect(effectiveMight(sc.state, sc.cards, mate, { role: null })).toBe(printed + 2);
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect((sc.state.objects[totem] as CardInstance).zone.kind).toBe('trash');
    expect(effectiveMight(sc.state, sc.cards, mate, { role: null })).toBe(printed);
  });

  it('parses Ephemeral Ward', () => {
    // Tests Rule 583.1: a triggered ability
    expect(parseStaticLines('Your units have +2 [M].')?.statics).toEqual([
      { affects: 'FRIENDLY_UNITS', might: 2 },
    ]);
    expect(parseCardAbilities('When you play a unit, kill this.')?.triggers[0]).toMatchObject({
      on: 'YOU_PLAY',
      effects: [{ op: 'KILL_SELF' }],
    });
  });
});
