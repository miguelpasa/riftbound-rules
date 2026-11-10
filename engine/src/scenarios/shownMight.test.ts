import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseSpellText } from '../cardText.js';
import { reduce } from '../reducer.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const TEXT = "If you showed off a unit, deal damage equal to that unit's Might to a unit.";

describe('scenario: "If you showed off a unit, deal damage equal to that unit\'s Might" (Primordial Roar)', () => {
  it('reads a Show Off-gated damage from the shown unit', () => {
    // Tests Rule 357: additional costs are paid as the card is played
    expect(parseSpellText(TEXT)).toEqual([
      { op: 'DAMAGE_TARGET', amount: 0, amountFrom: 'SHOWN_MIGHT', when: { kind: 'SHOWED_OFF' } },
    ]);
  });

  it('deals the shown unit’s Might, and nothing when nothing was shown', () => {
    // Tests Rule 357: additional costs are paid as the card is played
    const effects = parseSpellText(TEXT) as CardEffect[];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'full',
        effects,
        optionalAdditionalCost: { energy: 0, card: { kind: 'REVEAL', what: 'unit' } },
      },
    };
    const run = (show: boolean): number => {
      const sc = Scenario.start({}, cards);
      const victim = sc.putUnit('p1', 'fx-order-tank', 'base');
      const shown = sc.putInHand('p0', 'fx-grunt');
      const flare = sc.putInHand('p0', 'fx-flare');
      const r = reduce(sc.state, cards, {
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: flare,
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: victim }],
        ...(show ? { additionalCosts: { extra: true }, costCards: [shown] } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return -1;
      sc.state = r.state;
      for (let i = 0; i < 12 && sc.state.flow.chain.length > 0; i++) sc.pass(sc.state.flow.priority!);
      const gruntMight = (SCENARIO_CARDS['fx-grunt'] as CardDef).stats.might ?? 0;
      expect(gruntMight).toBeGreaterThan(0);
      return (sc.state.objects[victim]?.damage ?? 0) / gruntMight;
    };
    expect(run(true)).toBe(1); // damage = the shown grunt's printed Might
    expect(run(false)).toBe(0);
  });
});
