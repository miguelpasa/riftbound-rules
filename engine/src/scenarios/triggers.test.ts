import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

/** fx-grunt (in p0's deck) gets the given triggers. */
const withTriggers = (triggers: CardTrigger[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers },
});

describe('scenario: triggered abilities', () => {
  it('"When you play me" goes on the Chain and resolves after both players pass', () => {
    // Tests Rule 359.3: a triggered ability is put on the Chain and resolves like any item
    const sc = Scenario.start(
      {},
      withTriggers([{ on: 'PLAY', effects: [{ op: 'DRAW', amount: 2 }] }]),
    );
    const unit = sc.putInHand('p0', 'fx-grunt');
    const hand = sc.player('p0').hand.length;
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ kind: 'ABILITY', triggered: true });
    expect(sc.state.turnState.open).toBe(false);
    expect(sc.player('p0').hand.length).toBe(hand - 1); // not drawn yet
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.eventsOfType('CARD_DRAWN', r.events)).toHaveLength(2);
    expect(sc.state.flow.chain).toHaveLength(0);
    sc.verify();
  });

  it('Deathknell fires when the unit dies', () => {
    // Tests Rule 323.4: the unit dies in Cleanup, then its Deathknell triggers
    const cards: CardDatabase = {
      ...withTriggers([{ on: 'DEATH', effects: [{ op: 'DRAW', amount: 1 }] }]),
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'KILL_TARGET' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: unit }],
    });
    sc.pass('p1');
    sc.pass('p0'); // spell resolves; Cleanup kills the unit; Deathknell goes on the Chain
    expect(sc.obj(unit).zone.kind).toBe('trash');
    expect(sc.state.flow.chain.some((i) => i.triggered)).toBe(true);
    const hand = sc.player('p0').hand.length;
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
    sc.verify();
  });

  it('Hold fires for the unit at the held battlefield', () => {
    // Tests Rule 315.2.b: Hold at the Beginning Phase Scoring Step
    const sc = Scenario.start(
      {},
      withTriggers([{ on: 'HOLD', effects: [{ op: 'GAIN_POINT', amount: 1 }] }]),
    );
    const bf = sc.state.battlefields[0]!.id;
    sc.putUnit('p0', 'fx-grunt', bf, { control: true });
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's next Beginning Phase: Hold scores 1, the trigger is on the Chain
    expect(sc.player('p0').points).toBe(1);
    expect(sc.state.flow.chain.some((i) => i.triggered)).toBe(true);
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(sc.player('p0').points).toBe(2);
  });
});
