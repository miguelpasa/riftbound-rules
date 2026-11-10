import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseSelfCostReduction } from '../cardText.js';
import { getLegalActions } from '../legalActions.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT =
  "If you've spent [4] or more to play a spell this turn, you may play me for [C].";

function setup(runes: number): { sc: Scenario; jhin: string } {
  const red = parseSelfCostReduction(TEXT)?.reduction;
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-grunt': {
      ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
      cost: { energy: 4, power: 1, domain: [{ element: 'Fury', amount: 1 }] },
      ...(red ? { costReduction: red } : {}),
    },
    'fx-flare': {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      cost: { energy: 4 },
    },
  };
  const sc = Scenario.start({}, cards);
  sc.setRunes('p0', Array.from({ length: runes }, () => 'Fury' as const));
  const jhin = sc.putInHand('p0', 'fx-grunt');
  return { sc, jhin };
}
const offered = (sc: Scenario, id: string): boolean =>
  getLegalActions(sc.state, sc.cards, 'p0').some(
    (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === id,
  );

describe('scenario: "If you\'ve spent [4] or more to play a spell this turn, you may play me for [C]" (Jhin)', () => {
  it('reads an Energy waiver that applies once the condition holds, paying the printed Power', () => {
    // Tests Rule 3 (costs): a self cost reduction with a condition
    const r = parseSelfCostReduction(TEXT);
    expect(r?.forPower).toBe(1);
    expect(r?.reduction.when).toEqual({ kind: 'TURN_SPENT', what: 'spellEnergy', n: 4 });
  });

  it('is playable for just [C] after a 4-Energy spell, and not otherwise', () => {
    // Tests Rule 357: the total cost is computed with the reduction in force
    const a = setup(1);
    expect(offered(a.sc, a.jhin)).toBe(false); // 1 rune cannot pay [4][C]

    const b = setup(5);
    const spell = b.sc.putInHand('p0', 'fx-flare');
    b.sc.play('p0', spell, { payment: b.sc.exhaustPlan('p0', 4) });
    for (let i = 0; i < 6 && b.sc.state.flow.chain.length > 0; i++) b.sc.pass(b.sc.state.flow.priority!);
    expect(offered(b.sc, b.jhin)).toBe(true); // one ready rune left pays [C]
  });
});
