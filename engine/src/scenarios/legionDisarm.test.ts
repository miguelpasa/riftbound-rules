/** R6a: Legion (812) played-card tracking, and Disarm status (831 / 832). */
import { describe, expect, it } from 'vitest';
import { KEYWORD_IMPLEMENTED, legionActive } from '../keywords.js';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import type { CardDatabase, CardDef } from '../types/index.js';

/** fx-grunt (in p0's deck) gets the Legion keyword. */
const LEGION_CARDS: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    keywords: [{ name: 'Legion' }],
    supportLevel: 'partial',
  },
};

describe('Legion (812): cards played this turn', () => {
  it('Legion is an implemented keyword; Disarm lives in the parser, not the MVP list', () => {
    // Tests Rule 812: Legion is a dependent keyword the engine now tracks
    expect(KEYWORD_IMPLEMENTED.Legion).toBe(true);
    // Tests Rule 831: since R42 Disarm runs as a parsed attack trigger (cardText.ts, parserRound3.test.ts);
    // the MVP keyword table (KEYWORD_IMPLEMENTED) still lists it as deferred because the keyword has no engine hook
    expect(KEYWORD_IMPLEMENTED.Disarm).toBe(false);
  });

  it('is inactive before any card is played and counts only other cards', () => {
    // Tests Rule 812: the Legion effect needs you to have played another card this turn
    const sc = Scenario.start({}, LEGION_CARDS);
    const a = sc.putInHand('p0', 'fx-grunt');
    const b = sc.putInHand('p0', 'fx-grunt');
    sc.setPool('p0', 10);
    expect(legionActive(sc.state, 'p0', a)).toBe(false);
    sc.play('p0', a, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    // The card itself does not satisfy its own Legion; another card's Legion does see it
    expect(legionActive(sc.state, 'p0', a)).toBe(false);
    expect(legionActive(sc.state, 'p0', b)).toBe(true);
    sc.verify();
  });

  it("the opponent's plays do not count for you", () => {
    // Tests Rule 812: "you have played another card this turn" is about the Legion controller
    const sc = Scenario.start({}, LEGION_CARDS);
    const mine = sc.putInHand('p0', 'fx-grunt');
    sc.setPool('p0', 10);
    sc.play('p0', mine, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    const theirs = sc.putInHand('p1', 'fx-tide-grunt');
    expect(legionActive(sc.state, 'p1', theirs)).toBe(false);
    expect(legionActive(sc.state, 'p0', theirs)).toBe(true);
    sc.verify();
  });

  it('resets when a new turn starts', () => {
    // Tests Rule 812: "this turn" ends with the turn, so an earlier play no longer counts
    const sc = Scenario.start({}, LEGION_CARDS);
    const a = sc.putInHand('p0', 'fx-grunt');
    const b = sc.putInHand('p0', 'fx-grunt');
    sc.setPool('p0', 10);
    sc.play('p0', a, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(legionActive(sc.state, 'p0', b)).toBe(true);
    const turnBefore = sc.state.turn.number;
    sc.endTurn('p0');
    sc.endTurn('p1');
    expect(sc.state.turn.number).toBeGreaterThan(turnBefore);
    expect(legionActive(sc.state, 'p0', b)).toBe(false);
    sc.verify();
  });
});
