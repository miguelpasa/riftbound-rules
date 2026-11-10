import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When you play a spell, if you spent [4] or more, ready me.';

function setup(): { sc: Scenario; me: string } {
  const fx = parseCardAbilities(TEXT);
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), triggers: fx?.triggers ?? [] },
  };
  const sc = Scenario.start({}, cards);
  const me = sc.putUnit('p0', 'fx-ash-tank', 'base');
  (sc.state.objects[me] as { ready: boolean }).ready = false;
  sc.giveRunes('p0', 6);
  return { sc, me };
}
const cast = (sc: Scenario, energy: number): void => {
  const spell = sc.putInHand('p0', 'fx-flare');
  const def = sc.cards['fx-flare'] as CardDef;
  (sc.cards as Record<string, CardDef>)['fx-flare'] = { ...def, cost: { ...def.cost, energy } };
  sc.play('p0', spell, { payment: sc.exhaustPlan('p0', energy) });
  for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
};

describe('scenario: "When you play a spell, if you spent [4] or more" (Revna the Lorekeeper)', () => {
  it('reads the condition as the Energy paid for the spell just played', () => {
    // Tests Rule 303: a general condition on a triggered ability
    expect(parseCondition('you spent [4] or more')).toEqual({
      kind: 'TURN_SPENT',
      what: 'lastSpellEnergy',
      n: 4,
    });
  });

  it('readies the unit for a 4-Energy spell but not for a 1-Energy spell', () => {
    // Tests Rule 303: the condition is checked as the ability triggers
    const a = setup();
    cast(a.sc, 1);
    expect(a.sc.obj(a.me).ready).toBe(false);
    const b = setup();
    cast(b.sc, 4);
    expect(b.sc.obj(b.me).ready).toBe(true);
  });

  it('a big spell earlier in the turn does not count for a later small one', () => {
    // Tests Rule 303: "you spent" is about the spell being played now
    const { sc, me } = setup();
    cast(sc, 4);
    expect(sc.obj(me).ready).toBe(true);
    (sc.state.objects[me] as { ready: boolean }).ready = false;
    cast(sc, 1);
    expect(sc.obj(me).ready).toBe(false);
  });
});
