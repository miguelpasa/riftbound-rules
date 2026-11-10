import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';
import { runEffects } from '../effects.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT =
  'When you play me, if you showed off a card, [Predict] equal to its Power cost, then draw 2.';

describe('scenario: "[Predict] equal to its Power cost" (The Empyrean)', () => {
  it('reads the condition and the variable Predict', () => {
    // Tests Rule 303: a triggered ability with a general condition
    expect(parseCondition('you showed off a card')).toEqual({ kind: 'SHOWED_OFF' });
    const t = parseCardAbilities(TEXT)?.triggers[0];
    expect(t).toMatchObject({ on: 'PLAY', when: { kind: 'SHOWED_OFF' } });
    expect(t?.effects).toEqual([
      { op: 'PREDICT', count: 0, countFrom: 'SHOWN_POWER' },
      { op: 'DRAW', amount: 2 },
    ]);
  });

  it('looks at as many cards as the shown card’s Power cost', () => {
    // Tests Rule 303: the effect reads the card this unit showed off
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        cost: { energy: 1, power: 2, domain: [{ element: 'Fury', amount: 2 }] },
      },
    };
    const sc = Scenario.start({}, cards);
    const me = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const shown = sc.putInHand('p0', 'fx-grunt');
    (sc.state.objects[me] as { showedOff?: string }).showedOff = shown;
    const effects = parseCardAbilities(TEXT)?.triggers[0]?.effects ?? [];
    const ev = runEffects(sc.state, 'p0', effects.slice(0, 1), cards, [], 'fx-ash-tank', me);
    const looked = ev.find((e) => e.type === 'CARDS_LOOKED_AT') as { count: number } | undefined;
    expect(looked?.count).toBe(2);
  });
});
