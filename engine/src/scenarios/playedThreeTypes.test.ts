import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import { evalCondition } from '../conditions.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT =
  "When I conquer, if you've played a non-token unit, a non-token gear, and a spell this turn, you score 1 point.";

describe('scenario: "if you\'ve played a non-token unit, a non-token gear, and a spell this turn" (Swain)', () => {
  it('reads the condition onto a CONQUER trigger', () => {
    // Tests Rule 303: a general condition on a triggered ability
    expect(parseCondition("you've played a non-token unit, a non-token gear, and a spell this turn")).toEqual({
      kind: 'PLAYED_UNIT_GEAR_SPELL',
    });
    expect(parseCardAbilities(TEXT)?.triggers[0]).toMatchObject({
      on: 'CONQUER',
      when: { kind: 'PLAYED_UNIT_GEAR_SPELL' },
    });
  });

  it('holds only once all three card types were played this turn', () => {
    // Tests Rule 303: the turn's plays are read as the ability resolves
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), cost: { energy: 0 } },
      'fx-blade': { ...(SCENARIO_CARDS['fx-blade'] as CardDef), cost: { energy: 0 } },
      'fx-wisp': { ...(SCENARIO_CARDS['fx-wisp'] as CardDef), cost: { energy: 0 } },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const holds = (): boolean =>
      evalCondition(sc.state, sc.cards, { kind: 'PLAYED_UNIT_GEAR_SPELL' }, 'p0', 'x');
    expect(holds()).toBe(false);
    const play = (id: string, loc?: boolean): void => {
      sc.play('p0', id, { payment: [], ...(loc ? { location: { kind: 'base' } } : {}) });
      for (let i = 0; i < 8 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    };
    play(sc.putInHand('p0', 'fx-wisp'), true);
    expect(holds()).toBe(false);
    play(sc.putInHand('p0', 'fx-blade'), true);
    expect(holds()).toBe(false);
    play(sc.putInHand('p0', 'fx-flare'));
    expect(holds()).toBe(true);
  });
});
