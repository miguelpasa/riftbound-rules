import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import { scoreBattlefield } from '../scoring.js';
import { runEffects } from '../effects.js';
import { burnOut } from '../burnout.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text = "While I'm at a battlefield, opponents can't gain points.";
const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
const statics = parseStaticLines(text)?.statics ?? [];
/** `fx-ash-tank` stands in for Tianna Crownguard. */
const tianna: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-tide-grunt': { ...base('fx-tide-grunt'), statics },
};

describe('parser: "While I\'m at a battlefield, opponents can\'t gain points" (Tianna Crownguard)', () => {
  it('reads as a restriction that applies only at a battlefield', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(statics).toEqual([
      { affects: 'SELF', restrict: 'NO_ENEMY_POINTS', when: { kind: 'AT_BATTLEFIELD' } },
    ]);
  });
});

describe('scenario: opponents cannot gain points while Tianna is at a battlefield', () => {
  const holdPoints = (cards: CardDatabase, tiannaAt: 'bf0' | 'base' | null): number => {
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    if (tiannaAt) sc.putUnit('p1', 'fx-tide-grunt', tiannaAt);
    const before = sc.player('p0').points;
    const r = scoreBattlefield(sc.state, cards, 'p0', 'bf1', 'HOLD');
    return (r.state.players[0]?.points ?? 0) - before;
  };

  it('blocks a Hold point but still counts the battlefield as scored', () => {
    // Tests Rule 473: a Hold scores one point, unless something stops the player gaining it
    expect(holdPoints(tianna, null)).toBe(1);
    expect(holdPoints(tianna, 'bf0')).toBe(0);
    const sc = Scenario.start({}, tianna);
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const r = scoreBattlefield(sc.state, tianna, 'p0', 'bf1', 'HOLD');
    expect(r.state.battlefields.find((b) => b.id === 'bf1')?.scoredThisTurnBy).toContain('p0');
  });

  it('does nothing while she waits in the Base', () => {
    // Tests Rule 584: the static condition ("at a battlefield") must hold
    expect(holdPoints(tianna, 'base')).toBe(1);
  });

  it('does not stop her own controller scoring', () => {
    // Tests Rule 584: it restricts opponents only
    const sc = Scenario.start({}, tianna);
    sc.putUnit('p1', 'fx-tide-grunt', 'bf0', { control: true });
    const r = scoreBattlefield(sc.state, tianna, 'p1', 'bf0', 'HOLD');
    expect(r.state.players[1]?.points).toBe(1);
  });

  it('also stops point-gaining effects, but not the Burn Out point', () => {
    // Tests Rule 432.2: Burn Out's point is not an effect of a card and stays (UNCLEAR, see docs/ASSUMPTIONS.md)
    const sc = Scenario.start({}, tianna);
    sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'GAIN_POINT', amount: 1 }], tianna, [], 'fx-grunt', '');
    expect(s.players[0]?.points).toBe(0);
    const b = structuredClone(sc.state);
    burnOut(b, 'p1', tianna); // p1 burns out: p0 gains 1
    expect(b.players[0]?.points).toBe(1);
  });
});
