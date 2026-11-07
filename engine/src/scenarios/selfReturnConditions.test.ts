import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { evalCondition } from '../conditions.js';
import { runEffects } from '../effects.js';
import { parseCardAbilities, parseCondition } from '../cardText.js';

describe('scenario: return-self effect and battlefield / score conditions (R62)', () => {
  it('"return me to its owner\'s hand" moves the source to hand', () => {
    // Tests Rule 323: a permanent that leaves the board returns to its owner's hand
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'RETURN_SELF' }], sc.cards, [], '', u);
    expect(s.objects[u]?.zone.kind).toBe('hand');
    expect(s.players[0]?.hand).toContain(u);
    expect(s.players[0]?.base).not.toContain(u);
  });

  it('CONTROLS_BATTLEFIELD and SCORE_NEAR read the board and the scores', () => {
    // Tests Rule 473: scores and battlefield control
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const c = (cond: Parameters<typeof evalCondition>[2]) =>
      evalCondition(sc.state, sc.cards, cond, 'p0', u);
    expect(c({ kind: 'CONTROLS_BATTLEFIELD', who: 'enemy' })).toBe(false);
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    expect(c({ kind: 'CONTROLS_BATTLEFIELD', who: 'enemy' })).toBe(true);
    expect(c({ kind: 'SCORE_NEAR', who: 'enemy' })).toBe(false);
    sc.setPoints('p1', sc.state.victoryScore - 2);
    expect(c({ kind: 'SCORE_NEAR', who: 'enemy' })).toBe(true);
    expect(c({ kind: 'SCORE_NEAR', who: 'enemy', not: true })).toBe(false);
  });
});

describe('parser: R62 shapes', () => {
  it('reads the conditions and the return-self sentence', () => {
    // Tests Rule 473: parsed text
    expect(parseCondition('an opponent controls a battlefield')).toEqual({
      kind: 'CONTROLS_BATTLEFIELD',
      who: 'enemy',
    });
    expect(parseCondition("an opponent's score is within 3 points of the Victory Score")).toEqual({
      kind: 'SCORE_NEAR',
      who: 'enemy',
    });
    expect(parseCondition('your score is not within 3 points of the Victory Score')).toEqual({
      kind: 'SCORE_NEAR',
      who: 'friendly',
      not: true,
    });
    expect(
      parseCardAbilities("When I hold, return me to my owner's hand.")?.triggers[0]?.effects,
    ).toEqual([{ op: 'RETURN_SELF' }]);
  });
});
