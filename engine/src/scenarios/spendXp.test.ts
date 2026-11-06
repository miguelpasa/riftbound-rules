import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, Intent } from '../types/index.js';

/** fx-ash-tank: "Spend 2 XP: Buff me". */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-ash-tank': {
    ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
    abilities: [{ cost: { xp: 2 }, effects: [{ op: 'BUFF_SELF', amount: 1, buff: true }] }],
  },
};

const withXp = (sc: Scenario, xp: number): void => {
  const s = structuredClone(sc.state);
  (s.players[0] as { xp?: number }).xp = xp;
  sc.state = s;
};
const activate = (u: string): Intent => ({
  type: 'ACTIVATE_ABILITY',
  playerId: 'p0',
  sourceId: u,
  abilityIndex: 0,
  payment: [],
});

describe('scenario: Spend XP costs (R60)', () => {
  it('is refused and not offered without enough XP', () => {
    // Tests Rule 145.1: an ability's cost must be payable
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    withXp(sc, 1);
    sc.reject(activate(u));
    expect(
      getLegalActions(sc.state, sc.cards, 'p0').some((i) => i.type === 'ACTIVATE_ABILITY'),
    ).toBe(false);
  });

  it('pays the XP and resolves the effect', () => {
    // Tests Rule 145.1: the cost is paid on activation, the effect resolves from the Chain
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    withXp(sc, 3);
    const r = sc.do(activate(u));
    expect(sc.eventsOfType('XP_SPENT', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', amount: 2 }),
    ]);
    expect((sc.player('p0') as { xp?: number }).xp).toBe(1);
    for (let i = 0; i < 4 && sc.state.flow.chain.length > 0; i++) sc.pass(actorToAct(sc.state));
    expect(sc.obj(u).buffed).toBe(true);
    sc.verify();
  });
});

describe('parser: Spend XP', () => {
  it('reads "Spend N XP[, [E]]: effect" abilities', () => {
    // Tests Rule 145.1: parsed cost text
    expect(parseCardAbilities('Spend 2 XP: [Buff] me.')?.abilities[0]).toEqual({
      cost: { xp: 2 },
      effects: [{ op: 'BUFF_SELF', amount: 1, buff: true }],
    });
    expect(
      parseCardAbilities('Spend 3 XP, [E]: Draw 1.', { gearLike: true })?.abilities[0]?.cost,
    ).toEqual({
      xp: 3,
      exhaust: true,
    });
  });
});
