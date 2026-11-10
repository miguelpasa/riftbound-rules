import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { effectiveMight } from '../combat.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

type Activate = Extract<Intent, { type: 'ACTIVATE_ABILITY' }>;
const TEXT = 'Spend my buff: Give me +4 [M] this turn.';

function setup(): { sc: Scenario; me: string; other: string } {
  const fx = parseCardAbilities(TEXT);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-grunt': {
      ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
      abilities: fx?.abilities ?? [],
    },
  };
  const sc = Scenario.start({}, cards);
  const me = sc.putUnit('p0', 'fx-grunt', 'base');
  const other = sc.putUnit('p0', 'fx-ash-tank', 'base');
  return { sc, me, other };
}

describe('scenario: "Spend my buff: ..." (Sett, Udyr)', () => {
  it('reads the cost as spending the source’s own buff', () => {
    // Tests Rule 145.1: the part before the colon is the cost
    expect(parseCardAbilities(TEXT)?.abilities[0]?.cost).toEqual({
      card: { kind: 'SPEND_BUFF', self: true },
    });
  });

  it('is offered only while I am buffed, and removes my buff (not another unit’s)', () => {
    // Tests Rule 145.1: a cost must be paid in full
    const { sc, me, other } = setup();
    const acts = (): Activate[] =>
      getLegalActions(sc.state, sc.cards, 'p0').filter(
        (i): i is Activate => i.type === 'ACTIVATE_ABILITY' && i.sourceId === me,
      );
    expect(acts()).toEqual([]); // not buffed
    (sc.state.objects[other] as { buffed?: boolean }).buffed = true;
    expect(acts()).toEqual([]); // only ANOTHER unit is buffed
    (sc.state.objects[me] as { buffed?: boolean }).buffed = true;
    expect(acts().map((a) => a.costCards)).toEqual([[me]]);
    const before = effectiveMight(sc.state, sc.cards, me, { role: null });
    sc.do({ ...(acts()[0] as Activate) });
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(me).buffed).toBeFalsy();
    expect(sc.obj(other).buffed).toBe(true);
    expect(effectiveMight(sc.state, sc.cards, me, { role: null })).toBe(before - 1 + 4); // the spent buff's +1 is gone
  });

  it('reads Sett: "When I’m played and when I conquer, buff me." plus the spend ability', () => {
    // Tests Rule 303: both heads become triggers; Rule 145.1: the ability has its own cost
    const r = parseCardAbilities(
      'When I’m played and when I conquer, buff me.\nSpend my buff: Give me +4 [M] this turn.',
    );
    expect(r?.triggers.map((t) => t.on)).toEqual(['PLAY', 'CONQUER']);
    expect(r?.abilities).toHaveLength(1);
  });
});
