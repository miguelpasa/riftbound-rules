import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const counterCard = (counter: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    text: '[Action] test effect',
    supportLevel: 'partial',
    effects: [{ op: 'DAMAGE_TARGET', amount: 1 }],
  },
  'fx-tide-guard': {
    ...(SCENARIO_CARDS['fx-tide-guard'] as CardDef),
    text: '[Reaction] test effect',
    supportLevel: 'partial',
    effects: [counter],
  },
});

/** Ways p1 can play the guard while p0's flare (printed cost changed to `cost` once it is on the Chain) waits. */
function counterOptions(counter: CardEffect, energy: number, power: number): number {
  const cards = counterCard(counter);
  const sc = Scenario.start({}, cards);
  const victim = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
  sc.giveRunes('p1', 2);
  const guard = sc.putInHand('p1', 'fx-tide-guard');
  const flare = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', flare, {
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: victim }],
  });
  // The countering rule reads the printed cost of the spell on the Chain.
  (cards['fx-flare'] as CardDef).cost = { energy, ...(power ? { power } : {}) };
  return getLegalActions(sc.state, sc.cards, 'p1').filter(
    (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === guard,
  ).length;
}
describe("scenario: counters limited by the countered spell's cost (R80)", () => {
  it('"Power cost [A][A] or more" only counters spells with enough Power cost', () => {
    // Tests Rule 359.3: a counter needs a legal spell to target
    const counter: CardEffect = { op: 'COUNTER_SPELL', minPower: 2 };
    expect(counterOptions(counter, 1, 0)).toBe(0);
    expect(counterOptions(counter, 1, 1)).toBe(0);
    expect(counterOptions(counter, 1, 2)).toBeGreaterThan(0);
  });

  it('"costs no more than [4] and no more than [A]" limits Energy and Power', () => {
    // Tests Rule 359.3: both limits must hold
    const counter: CardEffect = { op: 'COUNTER_SPELL', maxEnergy: 2, maxPower: 1 };
    expect(counterOptions(counter, 2, 1)).toBeGreaterThan(0);
    expect(counterOptions(counter, 3, 1)).toBe(0);
    expect(counterOptions(counter, 1, 2)).toBe(0);
  });
});

describe('parser: limited counters (R80)', () => {
  it('reads both phrasings', () => {
    // Tests Rule 359.3: parsed spell text
    expect(parseSpellText('Counter a spell with Power cost [A][A] or more.')).toEqual([
      { op: 'COUNTER_SPELL', minPower: 2 },
    ]);
    expect(
      parseSpellText('Counter a spell that costs no more than [4] and no more than [A].'),
    ).toEqual([{ op: 'COUNTER_SPELL', maxEnergy: 4, maxPower: 1 }]);
  });
});
