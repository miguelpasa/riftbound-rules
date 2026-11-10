import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

type Activate = Extract<Intent, { type: 'ACTIVATE_ABILITY' }>;
const TEXT = 'Exhaust a friendly [Mighty] unit, [E]: Draw 1.';

describe('scenario: "Exhaust a friendly [Mighty] unit, [E]: ..." (Invigorating Bloom)', () => {
  it('reads the cost as exhausting a Mighty unit', () => {
    // Tests Rule 145.1: the part before the colon is the cost
    expect(parseCardAbilities(TEXT, { gearLike: true })?.abilities[0]?.cost).toEqual({
      card: { kind: 'EXHAUST', mighty: true },
      exhaust: true,
    });
  });

  it('offers the ability only with a ready Mighty (5+ Might) unit, and pays by exhausting it', () => {
    // Tests Rule 145.1: a cost must be paid in full; Rule 709: Mighty = 5+ Might
    const fx = parseCardAbilities(TEXT, { gearLike: true });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-blade': { ...(SCENARIO_CARDS['fx-blade'] as CardDef), abilities: fx?.abilities ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const gear = sc.putUnit('p0', 'fx-blade', 'base');
    const small = sc.putUnit('p0', 'fx-grunt', 'base');
    const acts = (): Activate[] =>
      getLegalActions(sc.state, sc.cards, 'p0').filter(
        (i): i is Activate => i.type === 'ACTIVATE_ABILITY' && i.sourceId === gear,
      );
    expect(acts()).toEqual([]); // no Mighty unit
    const big = sc.putUnit('p0', 'fx-ash-tank', 'base');
    (sc.state.objects[big] as { mightBonus: number }).mightBonus = 5;
    expect(acts().map((a) => a.costCards)).toEqual([[big]]); // only the Mighty one qualifies
    const hand = sc.player('p0').hand.length;
    sc.do(acts()[0] as Activate);
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(big).ready).toBe(false);
    expect(sc.obj(small).ready).toBe(true);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });
});
