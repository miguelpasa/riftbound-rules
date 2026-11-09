import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { parseSelfCostReduction } from '../cardText.js';
import type { CardDatabase, CardDef, CostReduction } from '../types/index.js';

/** fx-ash-tank costs 3 Energy; p0 starts a turn with only 2 ready runes. */
const withReduction = (r: CostReduction): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), costReduction: r },
});

const playable = (sc: Scenario, id: string): boolean =>
  getLegalActions(sc.state, sc.cards, 'p0').some(
    (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === id,
  );

describe('scenario: self cost reductions (R50)', () => {
  it('"for each exhausted unit": the discount makes an unaffordable card playable and is what is paid', () => {
    // Tests Rule 356.6: cost reductions lower the Energy cost before it is paid
    const sc = Scenario.start({}, withReduction({ energy: 1, per: 'EXHAUSTED_UNIT' }));
    const tank = sc.putInHand('p0', 'fx-ash-tank');
    expect(playable(sc, tank)).toBe(false); // 3 Energy, 2 runes
    const other = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(other, false);
    expect(playable(sc, tank)).toBe(true); // 3 - 1 = 2
    sc.play('p0', tank, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(tank).zone.kind).not.toBe('hand');
    sc.verify();
  });

  it('"to a minimum of": the cost never drops below the minimum', () => {
    // Tests Rule 356.6: a minimum cost floors the reduction
    const sc = Scenario.start({}, withReduction({ energy: 2, per: 'EXHAUSTED_UNIT', min: 2 }));
    const tank = sc.putInHand('p0', 'fx-ash-tank');
    for (const id of [
      sc.putUnit('p0', 'fx-grunt', 'base'),
      sc.putUnit('p0', 'fx-archer', 'base'),
    ]) {
      sc.setReady(id, false);
    }
    // 2 exhausted units would take 4 off a cost of 3, but the minimum is 2.
    sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: tank,
      payment: sc.exhaustPlan('p0', 1),
      location: { kind: 'base' },
    });
    sc.play('p0', tank, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(tank).zone.kind).not.toBe('hand');
  });

  it('"if <condition>": applies only while the condition holds', () => {
    // Tests Rule 356.6: a conditional reduction is checked when the card is played
    const sc = Scenario.start(
      {},
      withReduction({
        energy: 1,
        when: { kind: 'COUNT', what: 'unit', where: 'base', who: 'friendly', cmp: 'GTE', n: 1 },
      }),
    );
    const tank = sc.putInHand('p0', 'fx-ash-tank');
    expect(playable(sc, tank)).toBe(false);
    sc.putUnit('p0', 'fx-grunt', 'base');
    expect(playable(sc, tank)).toBe(true);
  });
});

describe('parser: self cost reductions', () => {
  it('reads "for each", a minimum and "if", and strips the line', () => {
    // Tests Rule 356.6: parsed cost text
    expect(
      parseSelfCostReduction('I cost [1] less for each exhausted unit you control.'),
    ).toMatchObject({
      reduction: { energy: 1, per: 'EXHAUSTED_UNIT' },
      rest: '',
    });
    expect(
      parseSelfCostReduction(
        "[Assault]\nI cost [1] less for each card you've played this turn, to a minimum of [1].",
      )?.reduction,
    ).toEqual({ energy: 1, per: 'CARDS_PLAYED', min: 1 });
    expect(
      parseSelfCostReduction('This costs [2] less if you control a Mech.')?.reduction,
    ).toMatchObject({
      energy: 2,
      when: { kind: 'CONTROL_SUBTYPE', subtype: 'Mech' },
    });
    // Now read as a not-in-hand condition (tail round 8, Void Drone).
    expect(
      parseSelfCostReduction('I cost [2] less to play from anywhere other than your hand.')
        ?.reduction,
    ).toEqual({ energy: 2, when: { kind: 'NOT_IN_HAND' } });
  });
});
