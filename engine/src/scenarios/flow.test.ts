import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { parseFlowCost } from '../cardText.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

/** fx-flare (1 Energy spell) gets "Flow [2]" and draws 1. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    flowCost: { energy: 2 },
    effects: [{ op: 'DRAW', amount: 1 }],
  },
};

/** The spell in the Trash: cast it from hand first, then let it resolve. */
function trashedFlare(): { sc: Scenario; id: string } {
  const sc = Scenario.start({}, cards).giveRunes('p0', 3);
  const id = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', id, { payment: sc.exhaustPlan('p0', 1) });
  for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(actorToAct(sc.state));
  expect(sc.obj(id).zone.kind).toBe('trash');
  return { sc, id };
}

describe('scenario: Flow (R61)', () => {
  it('lists the Trash play, pays the Flow cost, and banishes the spell afterwards', () => {
    // Tests Rule 359.3: a spell goes to the Trash after resolving, unless it was played with Flow
    const { sc, id } = trashedFlare();
    const flow = getLegalActions(sc.state, sc.cards, 'p0').find(
      (i): i is Extract<Intent, { type: 'PLAY_CARD' }> =>
        i.type === 'PLAY_CARD' && i.cardInstanceId === id && i.additionalCosts?.flow === true,
    );
    expect(flow).toBeDefined();
    const hand = sc.player('p0').hand.length;
    sc.do(flow as Intent);
    for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(actorToAct(sc.state));
    expect(sc.obj(id).zone.kind).toBe('banishment');
    expect(sc.player('p0').banishment).toContain(id);
    expect(sc.player('p0').trash).not.toContain(id);
    expect(sc.player('p0').hand.length).toBe(hand + 1); // the spell's draw
    sc.verify();
  });

  it('is refused without the Flow flag, from the wrong zone, and on cards without Flow', () => {
    // Tests Rule 356: a card can only be played from a zone the rules allow
    const { sc, id } = trashedFlare();
    const base = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      cardInstanceId: id,
      payment: sc.exhaustPlan('p0', 2),
    };
    expect(sc.reject(base).code).toBe('NOT_IN_HAND');
    const plain = Scenario.start();
    const h = plain.putInHand('p0', 'fx-flare');
    plain.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: h,
      payment: plain.exhaustPlan('p0', 1),
      additionalCosts: { flow: true },
    });
  });
});

describe('parser: Flow', () => {
  it('reads the Flow cost line', () => {
    // Tests Rule 359.3: parsed text
    expect(
      parseFlowCost(
        'Kill a gear.\n[Flow] [4][C] (You may play this from your trash. Then banish it.)',
      ),
    ).toEqual({
      cost: { energy: 4, power: 1 },
      rest: 'Kill a gear.',
    });
    expect(parseFlowCost('Kill a gear.')).toBeNull();
  });
});
