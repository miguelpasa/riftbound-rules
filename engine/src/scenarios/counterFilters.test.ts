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

describe('scenario: "Counter a spell if an opponent has played another spell this turn" (Crumbling Sands)', () => {
  const text = 'Counter a spell if an opponent has played another spell this turn.';
  const counter = parseSpellText(text) ?? [];

  it('reads the counter with its condition on the countered spell', () => {
    // Tests Rule 359.3: parsed spell text
    expect(counter).toEqual([{ op: 'COUNTER_SPELL', when: { kind: 'OPP_OTHER_SPELL', slot: 0 } }]);
  });

  /** p0 plays `n` flares at a unit, p1 answers the last with the guard; returns the damage the unit took. */
  function damageAfter(n: number): number {
    const cards = counterCard(counter[0] as CardEffect);
    const sc = Scenario.start({}, cards);
    const victim = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    sc.state.objects[victim]!.mightBonus = 9; // survives the damage
    sc.giveRunes('p0', 4);
    sc.giveRunes('p1', 2);
    const guard = sc.putInHand('p1', 'fx-tide-guard');
    let last = '';
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        sc.pass('p1');
        sc.pass('p0'); // the earlier flare resolves
      }
      last = sc.putInHand('p0', 'fx-flare');
      sc.play('p0', last, {
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: victim }],
      });
    }
    sc.play('p1', guard, {
      payment: sc.exhaustPlan('p1', 1),
      targets: [{ kind: 'object', id: last }],
    });
    for (let k = 0; k < 10 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    return sc.state.objects[victim]?.damage ?? 0;
  }

  it('counters the second spell, but not the first one of the turn', () => {
    // Tests Rule 359.3: the counter works only when its condition holds as it resolves
    expect(damageAfter(2)).toBe(1); // the second flare was countered
    expect(damageAfter(1)).toBe(1); // the only flare resolved: nothing to counter
  });
});
