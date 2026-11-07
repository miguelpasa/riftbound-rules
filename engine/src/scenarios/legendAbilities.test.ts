import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

function setup(): { sc: Scenario; legend: string } {
  const probe = Scenario.start();
  const legendId = probe.state.players[0]?.legend as string;
  const cardId = probe.state.objects[legendId]?.cardId as string;
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    [cardId]: {
      ...(SCENARIO_CARDS[cardId] as CardDef),
      abilities: [{ cost: { exhaust: true }, effects: [{ op: 'DRAW', amount: 1 }] }],
    },
  };
  const sc = Scenario.start({}, cards);
  return { sc, legend: sc.state.players[0]?.legend as string };
}

describe('scenario: Legend activated abilities (R68)', () => {
  it('can be activated from the Legend zone, exhausts the Legend and resolves', () => {
    // Tests Rule 145.1: an activated ability pays its cost and resolves from the Chain
    const { sc, legend } = setup();
    const act = getLegalActions(sc.state, sc.cards, 'p0').find(
      (i): i is Extract<Intent, { type: 'ACTIVATE_ABILITY' }> =>
        i.type === 'ACTIVATE_ABILITY' && i.sourceId === legend,
    );
    expect(act).toBeDefined();
    const hand = sc.player('p0').hand.length;
    sc.do(act as Intent);
    expect(sc.obj(legend).ready).toBe(false);
    for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(actorToAct(sc.state));
    expect(sc.player('p0').hand.length).toBe(hand + 1);
    // Exhausted: no second activation.
    expect(
      getLegalActions(sc.state, sc.cards, 'p0').some(
        (i) => i.type === 'ACTIVATE_ABILITY' && i.sourceId === legend,
      ),
    ).toBe(false);
    sc.verify();
  });
});

describe('parser: Legend abilities', () => {
  it('reads "[1], [E]: Buff a friendly unit." as an activated ability', () => {
    // Tests Rule 145.1: parsed ability text
    expect(parseCardAbilities('[1], [E]: Buff a friendly unit.')?.abilities[0]).toEqual({
      cost: { energy: 1, exhaust: true },
      effects: [{ op: 'BUFF_TARGET', amount: 1, buff: true, side: 'friendly' }],
    });
  });
});
