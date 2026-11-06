import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities, parseOptionalAdditionalCost } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

/** fx-grunt costs 2; "You may pay [1] as an additional cost"; "if you paid it" draws a card. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    optionalAdditionalCost: { energy: 1 },
    triggers: [
      { on: 'PLAY', when: { kind: 'PAID_ADDITIONAL' }, effects: [{ op: 'DRAW', amount: 1 }] },
    ],
  },
};

function play(extra: boolean): Scenario {
  const sc = Scenario.start({}, cards).giveRunes('p0', 1);
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, {
    payment: sc.exhaustPlan('p0', extra ? 3 : 2),
    location: { kind: 'base' },
    ...(extra ? { additionalCosts: { extra: true } } : {}),
  } as never);
  for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(actorToAct(sc.state));
  }
  return sc;
}

describe('scenario: optional additional cost to play (R58)', () => {
  it('"if you paid the additional cost" triggers only when it was paid', () => {
    // Tests Rule 356.2: additional costs are paid with the card's cost; the effect reads whether they were
    const handBefore = Scenario.start({}, cards).giveRunes('p0', 1).player('p0').hand.length;
    const no = play(false);
    const yes = play(true);
    expect(no.player('p0').hand.length).toBe(handBefore);
    expect(yes.player('p0').hand.length).toBe(handBefore + 1);
    yes.verify();
  });

  it('is listed as a separate play variant only when affordable, and refused on other cards', () => {
    // Tests Rule 356.2: a play with an extra cost needs the extra Energy
    const sc = Scenario.start({}, cards);
    const unit = sc.putInHand('p0', 'fx-grunt');
    const variants = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === unit,
    );
    // Only 2 ready runes: the 3-Energy variant is not affordable, the plain one is.
    expect(variants.some((i) => i.type === 'PLAY_CARD' && i.additionalCosts?.extra)).toBe(false);
    expect(variants.length).toBeGreaterThan(0);
    const other = Scenario.start();
    const u2 = other.putInHand('p0', 'fx-grunt');
    other.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: u2,
      payment: other.exhaustPlan('p0', 2),
      location: { kind: 'base' },
      additionalCosts: { extra: true },
    });
  });
});

describe('parser: optional additional cost', () => {
  it('reads the cost line and the "if you paid" trigger condition', () => {
    // Tests Rule 356.2: parsed text
    expect(
      parseOptionalAdditionalCost('You may pay [1][C] as an additional cost to play me.'),
    ).toEqual({
      cost: { energy: 1, power: 1 },
      rest: '',
    });
    expect(
      parseCardAbilities('When you play me, if you paid the additional cost, draw 1.')?.triggers[0],
    ).toMatchObject({
      on: 'PLAY',
      when: { kind: 'PAID_ADDITIONAL' },
      effects: [{ op: 'DRAW', amount: 1 }],
    });
  });
});
