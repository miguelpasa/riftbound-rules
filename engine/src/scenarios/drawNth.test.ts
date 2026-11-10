import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When you draw your second card each turn, give a friendly unit +2 [M] this turn.';

function setup(draw: number): { sc: Scenario; unit: string; cast: () => void } {
  const fx = parseCardAbilities(TEXT);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-blade': { ...(SCENARIO_CARDS['fx-blade'] as CardDef), triggers: fx?.triggers ?? [] },
    'fx-flare': {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      supportLevel: 'partial',
      effects: [{ op: 'DRAW', amount: draw }],
    },
  };
  const sc = Scenario.start({}, cards);
  sc.putUnit('p0', 'fx-blade', 'base');
  const unit = sc.putUnit('p0', 'fx-grunt', 'base');
  const cast = (): void => {
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [] });
    for (let i = 0; i < 8 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
  };
  return { sc, unit, cast };
}
const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: "When you draw your second card each turn" (Frigid Jewel)', () => {
  it('reads the trigger', () => {
    // Tests Rule 303: parsed trigger text
    expect(parseCardAbilities(TEXT)?.triggers[0]).toMatchObject({ on: 'YOU_DRAW', drawNth: 2 });
  });

  it('fires on the second card of a two-card draw', () => {
    // Tests Rule 303: a triggered ability fires on its event
    const { sc, unit, cast } = setup(2);
    const before = might(sc, unit);
    cast();
    expect(might(sc, unit)).toBe(before + 2);
  });

  it('counts the Draw Phase card: the first spell draw is the second card, later ones are not', () => {
    // Tests Rule 315: the Draw Phase draw is the turn's first card; the count is per turn
    const { sc, unit, cast } = setup(1);
    expect(sc.player('p0').turnFlags?.drawn).toBe(1); // drawn in the Draw Phase
    const before = might(sc, unit);
    cast();
    expect(might(sc, unit)).toBe(before + 2); // the second card of the turn
    cast();
    expect(might(sc, unit)).toBe(before + 2); // the third does not
  });
});
