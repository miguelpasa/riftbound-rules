import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const xpOf = (sc: Scenario, p: 'p0' | 'p1' = 'p0'): number =>
  (sc.state.players[p === 'p0' ? 0 : 1] as { xp?: number }).xp ?? 0;

describe('scenario: XP, Hunt and Level (R53)', () => {
  it('"When you play me, gain N XP" adds XP and reports it', () => {
    // Tests Rule 303: a play trigger resolves from the Chain
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [{ on: 'PLAY', effects: [{ op: 'GAIN_XP', amount: 2 }] }],
      },
    };
    const sc = Scenario.start({}, cards);
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(xpOf(sc)).toBe(2);
    expect(xpOf(sc, 'p1')).toBe(0);
    sc.verify();
  });

  it('a Level static applies exactly while the controller has enough XP', () => {
    // Tests Rule 143.2: conditional continuous Might
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': {
        ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
        statics: [{ affects: 'SELF', might: 1, when: { kind: 'XP', n: 3 } }],
      },
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const base = SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0;
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(base);
    const s = structuredClone(sc.state);
    (s.players[0] as { xp?: number }).xp = 3;
    sc.state = s;
    expect(effectiveMight(sc.state, sc.cards, u, { role: null })).toBe(base + 1);
  });
});

describe('parser: XP', () => {
  it('reads Hunt, "gain N XP", Level lines and "When I move to a battlefield"', () => {
    // Tests Rule 303: parsed trigger / static text
    const hunt = parseCardAbilities('[Hunt 2]');
    expect(hunt?.triggers.map((t) => t.on).sort()).toEqual(['CONQUER', 'HOLD']);
    expect(hunt?.triggers[0]?.effects).toEqual([{ op: 'GAIN_XP', amount: 2 }]);
    expect(
      parseCardAbilities('When I move to a battlefield, gain 2 XP.')?.triggers[0],
    ).toMatchObject({
      on: 'MOVE',
      effects: [{ op: 'GAIN_XP', amount: 2 }],
    });
    expect(
      parseCardAbilities('When you play me, gain 1 XP for each friendly unit.')?.triggers[0]
        ?.effects,
    ).toEqual([{ op: 'GAIN_XP', amount: 1, perFriendlyUnit: true }]);
    expect(parseStaticLines('[Level 3][>] I have +1 [M] and [Ganking].')?.statics[0]).toEqual({
      affects: 'SELF',
      might: 1,
      keywords: [{ name: 'Ganking' }],
      when: { kind: 'XP', n: 3 },
    });
  });
});
