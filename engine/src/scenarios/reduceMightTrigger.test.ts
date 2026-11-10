import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT =
  'When you reduce the Might of an enemy unit here by 1 or more, give me +1 [M] this turn.';

describe('scenario: "When you reduce the Might of an enemy unit here by 1 or more" (Ahri)', () => {
  it('reads a trigger on reducing an enemy unit here', () => {
    // Tests Rule 303: a triggered ability fires on its event
    expect(parseCardAbilities(TEXT)?.triggers[0]).toMatchObject({ on: 'YOU_REDUCE_HERE' });
  });

  function run(enemyHere: boolean): number {
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': {
        ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
        triggers: parseCardAbilities(TEXT)?.triggers ?? [],
      },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'DEBUFF_TARGET', amount: 1, side: 'enemy' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const ahri = sc.putUnit('p0', 'fx-ash-tank', 'bf1', { control: true });
    const foe = sc.putUnit('p1', 'fx-tide-grunt', enemyHere ? 'bf1' : 'base');
    const before = effectiveMight(sc.state, sc.cards, ahri, { role: null });
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: foe }],
    });
    for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    return effectiveMight(sc.state, sc.cards, ahri, { role: null }) - before;
  }

  it('gives +1 [M] when an enemy unit at my battlefield is reduced, not elsewhere', () => {
    // Tests Rule 303: the reduction must happen to an enemy unit here
    expect(run(true)).toBe(1);
    expect(run(false)).toBe(0);
  });
});
