import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { parseOptionalAdditionalCost } from '../cardText.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;
const db = (optionalAdditionalCost: CardDef['optionalAdditionalCost']): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), optionalAdditionalCost },
});
const extras = (sc: Scenario, id: string): Play[] =>
  getLegalActions(sc.state, sc.cards, 'p0').filter(
    (i): i is Play =>
      i.type === 'PLAY_CARD' && i.cardInstanceId === id && i.additionalCosts?.extra === true,
  );

describe('scenario: optional additional costs with cards / XP (R63)', () => {
  it('a card-choice extra lists one variant per card, discards it and makes the card cheaper', () => {
    // Tests Rule 356.2: additional costs are paid with the card; "if you do" reductions apply
    const sc = Scenario.start({}, db({ energy: 0, card: { kind: 'DISCARD' }, reduceEnergy: 1 }));
    const tank = sc.putInHand('p0', 'fx-ash-tank'); // cost 3, only 2 ready runes
    const other = sc.putInHand('p0', 'fx-grunt');
    const plays = extras(sc, tank);
    expect(plays.length).toBeGreaterThan(0);
    const pick = plays.find((p) => p.costCards?.[0] === other) as Play;
    expect(pick).toBeDefined();
    sc.do(pick);
    expect(sc.obj(other).zone.kind).toBe('trash'); // discarded
    expect(sc.obj(tank).zone.kind).not.toBe('hand');
    sc.verify();
  });

  it('an XP extra needs the XP, spends it, and is not offered without it', () => {
    // Tests Rule 356.2: a cost that cannot be paid makes the variant unavailable
    const sc = Scenario.start({}, db({ energy: 0, xp: 2, reduceEnergy: 1 }));
    const tank = sc.putInHand('p0', 'fx-ash-tank');
    expect(extras(sc, tank)).toHaveLength(0);
    const s = structuredClone(sc.state);
    (s.players[0] as { xp?: number }).xp = 3;
    sc.state = s;
    const plays = extras(sc, tank);
    expect(plays.length).toBeGreaterThan(0);
    const r = sc.do(plays[0] as Play);
    expect(sc.eventsOfType('XP_SPENT', r.events)).toEqual([expect.objectContaining({ amount: 2 })]);
    expect((sc.player('p0') as { xp?: number }).xp).toBe(1);
  });
});

describe('parser: optional additional costs (R63)', () => {
  it('reads card-choice, XP and "If you do, I cost [N] less" forms', () => {
    // Tests Rule 356.2: parsed text
    expect(
      parseOptionalAdditionalCost('You may discard 1 as an additional cost to play me.')?.cost,
    ).toEqual({
      energy: 0,
      card: { kind: 'DISCARD' },
    });
    expect(
      parseOptionalAdditionalCost(
        'You may spend 3 XP as an additional cost to play me. If you do, I cost [3] less.',
      )?.cost,
    ).toEqual({ energy: 0, xp: 3, reduceEnergy: 3 });
    expect(
      parseOptionalAdditionalCost('As an additional cost to play this, you may discard 1.')?.cost
        .card,
    ).toEqual({
      kind: 'DISCARD',
    });
    expect(
      parseOptionalAdditionalCost('You may pay [1][C] as an additional cost to play me.')?.cost,
    ).toEqual({
      energy: 1,
      power: 1,
    });
  });
});
