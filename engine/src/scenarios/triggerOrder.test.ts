import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const cards: CardDatabase = {
  ...TOKEN_CARDS,
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'HOLD', effects: [{ op: 'DRAW', amount: 1 }] }],
  },
  'fx-ash-tank': {
    ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
    triggers: [{ on: 'HOLD', effects: [{ op: 'CHANNEL', amount: 1 }] }],
  },
};

/** p0 holds a battlefield with two different units whose hold triggers fire together. */
function holding(): Scenario {
  const sc = Scenario.start({}, cards);
  const bf = sc.state.battlefields[0]!.id;
  sc.putUnit('p0', 'fx-grunt', bf, { control: true });
  sc.putUnit('p0', 'fx-ash-tank', bf);
  sc.endTurn('p0');
  sc.endTurn('p1');
  return sc;
}

describe('scenario: ordering simultaneous triggers (X6)', () => {
  it('asks the controller to order two different triggers and applies the order', () => {
    // Tests Rule 583.3.b: the controller selects the order to place them on the Chain
    const sc = holding();
    const pc = sc.state.flow.pendingChoice;
    expect(pc?.kind).toBe('TRIGGER_ORDER');
    if (pc?.kind !== 'TRIGGER_ORDER') return;
    expect(pc.player).toBe('p0');
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal).toHaveLength(2);
    expect(legal.every((i) => i.type === 'CHOOSE_TRIGGER_ORDER')).toBe(true);
    expect(getLegalActions(sc.state, sc.cards, 'p1')).toEqual([]);
    const flipped = [...pc.chainItemIds].reverse();
    sc.do({ type: 'CHOOSE_TRIGGER_ORDER', playerId: 'p0', order: flipped });
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    const chain = sc.state.flow.chain.filter((i) => i.triggered).map((i) => i.id);
    expect(chain[chain.length - 1]).toBe(flipped[0]); // first to resolve is on top
    expect(sc.state.flow.chain.some((i) => i.unordered)).toBe(false);
  });

  it('rejects an order that is not a permutation, and blocks other actions meanwhile', () => {
    // Tests Rule 583.3.b: all simultaneous triggers are ordered
    const sc = holding();
    const bad = sc.tryDo({ type: 'CHOOSE_TRIGGER_ORDER', playerId: 'p0', order: ['x1', 'x2'] });
    expect(bad.ok).toBe(false);
    expect(sc.tryDo({ type: 'PASS_PRIORITY', playerId: 'p1' }).ok).toBe(false);
  });

  it('two copies of the same ability need no ordering', () => {
    // Tests Rule 583.3.b: identical abilities have nothing to order
    const sc = Scenario.start({}, cards);
    const bf = sc.state.battlefields[0]!.id;
    sc.putUnit('p0', 'fx-grunt', bf, { control: true });
    sc.putUnit('p0', 'fx-grunt', bf);
    sc.endTurn('p0');
    sc.endTurn('p1');
    expect(sc.state.flow.pendingChoice?.kind).not.toBe('TRIGGER_ORDER');
  });
});
