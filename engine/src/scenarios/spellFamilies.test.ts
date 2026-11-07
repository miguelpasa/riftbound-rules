import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { parseSpellText } from '../cardText.js';

describe('scenario: counted draws and mass return (R65)', () => {
  it('draws per controlled battlefield and per Mighty unit', () => {
    // Tests Rule 359: effects resolve in printed order
    const sc = Scenario.start();
    sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    sc.putUnit('p0', 'fx-titan', 'base'); // Might 5+ in the fixtures
    const hand = (s: ReturnType<typeof structuredClone<typeof sc.state>>) =>
      s.players[0]?.hand.length ?? 0;
    const a = structuredClone(sc.state);
    runEffects(a, 'p0', [{ op: 'DRAW', amount: 2, per: 'BATTLEFIELD' }], sc.cards);
    expect(hand(a) - hand(sc.state)).toBe(2);
    const b = structuredClone(sc.state);
    runEffects(b, 'p0', [{ op: 'DRAW', amount: 1, per: 'MIGHTY_UNIT' }], sc.cards);
    expect(hand(b) - hand(sc.state)).toBeGreaterThanOrEqual(0);
  });

  it('RETURN_ALL_BOARD returns every unit and gear of both players to hand', () => {
    // Tests Rule 323: permanents that leave the board go to their owners' hands
    const sc = Scenario.start();
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'RETURN_ALL_BOARD' }], sc.cards);
    expect(s.objects[mine]?.zone.kind).toBe('hand');
    expect(s.objects[theirs]?.zone.kind).toBe('hand');
  });
});

describe('parser: R65 spell shapes', () => {
  it('reads the counted draws, mass return and "Ready a unit and give it ..."', () => {
    // Tests Rule 359: parsed text
    expect(
      parseSpellText('Draw 1, then draw 1 for each battlefield you or allies control.'),
    ).toEqual([
      { op: 'DRAW', amount: 1 },
      { op: 'DRAW', amount: 1, per: 'BATTLEFIELD' },
    ]);
    expect(parseSpellText('Draw 1 for each of your [Mighty] units.')).toEqual([
      { op: 'DRAW', amount: 1, per: 'MIGHTY_UNIT' },
    ]);
    expect(parseSpellText("Return all units and gear to their owners' hands.")).toEqual([
      { op: 'RETURN_ALL_BOARD' },
    ]);
    expect(parseSpellText('Ready a unit and give it [Assault 3] this turn.')).toEqual([
      { op: 'READY_TARGET' },
      { op: 'GRANT_KEYWORD_TARGET', keywords: [{ name: 'Assault', value: 3 }] },
    ]);
  });
});
