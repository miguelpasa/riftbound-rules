import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text = 'When my Might becomes 10 or more, empower me.';
const triggers = parseCardAbilities(text)?.triggers ?? [];
/** `fx-grunt` (Might 2) stands in for Renekton; a +N spell raises it. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers },
};

function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('parser: "When my Might becomes 10 or more, empower me" (Renekton)', () => {
  it('reads a Might-threshold trigger on the unit itself', () => {
    // Tests Rule 303: parsed trigger text
    expect(triggers).toMatchObject([
      { on: 'MIGHT_REACHES', mightAtLeast: 10, effects: [{ op: 'EMPOWER_SELF' }] },
    ]);
  });
});

describe('scenario: a unit whose Might reaches a threshold', () => {
  /** Gives the unit `bonus` Might through a +N spell; returns whether it ended up Empowered. */
  function empoweredAfter(bonus: number): boolean {
    const db: CardDatabase = {
      ...cards,
      'fx-flare': {
        ...(cards['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'BUFF_TARGET', amount: bonus, duration: 'TURN' }],
      },
    };
    const sc = Scenario.start({}, db);
    const me = sc.putUnit('p0', 'fx-grunt', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: me }],
    });
    settle(sc);
    return sc.obj(me).empowered === true;
  }

  it('is empowered when its Might goes from below the threshold to the threshold or more', () => {
    // Tests Rule 303: a triggered ability fires on its event
    expect(empoweredAfter(7)).toBe(false); // 2 + 7 = 9
    expect(empoweredAfter(8)).toBe(true); // 2 + 8 = 10
  });
});
