import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger, Intent } from '../types/index.js';

const withTriggers = (triggers: CardTrigger[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers },
});

const DISCARD_THEN_DRAW: CardTrigger = {
  on: 'PLAY',
  optional: { card: { kind: 'DISCARD', count: 1 }, mandatory: true },
  effects: [{ op: 'DRAW', amount: 2 }],
};

function playAndResolve(cards: CardDatabase): Scenario {
  const sc = Scenario.start({}, cards);
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  sc.pass('p1');
  sc.pass('p0');
  return sc;
}

describe('scenario: mandatory discard costs (R77)', () => {
  it('cannot be declined; the discard then the effect happen together', () => {
    // Tests Rule 340.1: the ability waits for its controller's choice of cards
    const sc = playAndResolve(withTriggers([DISCARD_THEN_DRAW]));
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'OPTIONAL_EFFECT', cost: { mandatory: true } });
    if (pc?.kind !== 'OPTIONAL_EFFECT') throw new Error('no choice');
    sc.reject({
      type: 'DECIDE_OPTIONAL',
      playerId: 'p0',
      chainItemId: pc.chainItemId,
      accept: false,
    });
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((i) => i.type === 'DECIDE_OPTIONAL' && i.accept)).toBe(true);
    const hand = sc.player('p0').hand;
    const pick = hand[0] as string;
    const trashBefore = sc.player('p0').trash.length;
    sc.do({
      type: 'DECIDE_OPTIONAL',
      playerId: 'p0',
      chainItemId: pc.chainItemId,
      accept: true,
      costCards: [pick],
    } as Intent);
    expect(sc.player('p0').trash.length).toBe(trashBefore + 1);
    expect(sc.player('p0').trash).toContain(pick);
    expect(sc.player('p0').hand.length).toBe(hand.length - 1 + 2);
    sc.verify();
  });

  it('with no card in hand there is nothing to discard and the effect just happens', () => {
    // Tests Rule 340.1: an empty hand discards nothing
    const sc = Scenario.start({}, withTriggers([DISCARD_THEN_DRAW]));
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.emptyHand('p0');
    sc.putInHand('p0', 'fx-grunt');
    // Play the grunt just put in hand, leaving the hand empty.
    const only = sc.player('p0').hand[0] as string;
    sc.play('p0', only, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.player('p0').hand).toHaveLength(0);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.player('p0').hand).toHaveLength(2);
    expect(unit).toBeDefined();
  });

  it('discards what it can when the hand is smaller than the cost', () => {
    // Tests Rule 340.1: "discard 3" with two cards in hand discards those two
    const t: CardTrigger = {
      ...DISCARD_THEN_DRAW,
      optional: { card: { kind: 'DISCARD', count: 3 }, mandatory: true },
      effects: [],
    };
    const sc = Scenario.start({}, withTriggers([t]));
    sc.emptyHand('p0');
    const a = sc.putInHand('p0', 'fx-grunt');
    sc.putInHand('p0', 'fx-flare');
    sc.putInHand('p0', 'fx-flare');
    sc.play('p0', a, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ cost: { card: { count: 2 } } });
  });
});

describe('parser: mandatory discards (R77)', () => {
  it('reads "Discard N[, then ...]" bodies for triggers', () => {
    // Tests Rule 340.1: parsed trigger text
    expect(parseCardAbilities('When you play me, discard 1, then draw 1.')?.triggers[0]).toEqual({
      on: 'PLAY',
      effects: [{ op: 'DRAW', amount: 1 }],
      optional: { card: { kind: 'DISCARD' }, mandatory: true },
    });
    expect(parseCardAbilities('When you play me, discard 2.')?.triggers[0]).toMatchObject({
      effects: [],
      optional: { mandatory: true, card: { count: 2 } },
    });
    expect(parseCardAbilities('[Deathknell] — Discard 2, then draw 2.')?.triggers[0]?.on).toBe(
      'DEATH',
    );
  });
});

describe('scenario: mandatory discard on a Battlefield card (R77 audit)', () => {
  it('"When you conquer here, discard 1, then draw 1" asks the conqueror and cannot be declined', () => {
    // Tests Rule 473: conquering a battlefield triggers its abilities; the choice is the conqueror's
    const sc0 = Scenario.start();
    const bfCard = sc0.bf('bf1').cardId;
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [bfCard]: {
        ...(SCENARIO_CARDS[bfCard] as CardDef),
        triggers: [
          {
            on: 'CONQUER',
            optional: { card: { kind: 'DISCARD' }, mandatory: true },
            effects: [{ op: 'DRAW', amount: 1 }],
          },
        ],
      },
    };
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1');
    for (let i = 0; i < 6 && sc.state.flow.pendingChoice?.kind !== 'OPTIONAL_EFFECT'; i++) {
      if (sc.state.flow.chain.length === 0) break;
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'OPTIONAL_EFFECT', player: 'p0', cost: { mandatory: true } });
    if (pc?.kind !== 'OPTIONAL_EFFECT') return;
    sc.reject({
      type: 'DECIDE_OPTIONAL',
      playerId: 'p0',
      chainItemId: pc.chainItemId,
      accept: false,
    });
    const hand = sc.player('p0').hand.length;
    sc.do({
      type: 'DECIDE_OPTIONAL',
      playerId: 'p0',
      chainItemId: pc.chainItemId,
      accept: true,
      costCards: [sc.player('p0').hand[0] as string],
    } as Intent);
    expect(sc.player('p0').hand.length).toBe(hand); // one discarded, one drawn
  });
});
