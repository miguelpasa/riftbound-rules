import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

/** fx-ash-tank (Might 3) can Empower for [2]; while Empowered it has +2 Might. */
const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-ash-tank': {
    ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
    abilities: [{ cost: { energy: 2 }, effects: [{ op: 'EMPOWER_SELF' }] }],
    statics: [{ affects: 'SELF', might: 2, when: { kind: 'EMPOWERED' } }],
  },
};
const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: Empower (R52)', () => {
  it('pays the cost, resolves, and the Empowered static applies; a second Empower is refused', () => {
    // Tests Rule 145.1: an activated ability pays its cost and resolves from the Chain
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const base = might(sc, u);
    sc.do({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: u,
      abilityIndex: 0,
      payment: sc.exhaustPlan('p0', 2),
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(u).empowered).toBe(true);
    expect(might(sc, u)).toBe(base + 2);
    sc.reject({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: u,
      abilityIndex: 0,
      payment: [],
    });
    sc.verify();
  });

  it('starts un-Empowered', () => {
    // Tests Rule 145.1: state exists only while the permanent is on the board
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(sc.obj(u).empowered).toBeUndefined();
    expect(might(sc, u)).toBe(SCENARIO_CARDS['fx-ash-tank']?.stats.might);
  });
});

describe('parser: Empower', () => {
  it('turns "[Empower] <cost>" into an Empower ability and "[Empowered][>]" into conditional statics / triggers', () => {
    // Tests Rule 145.1: parsed ability text
    const a = parseCardAbilities(
      '[Empower] [2][C] ([2][C]: Empower me. Use only if not Empowered.)',
    );
    expect(a?.abilities).toEqual([
      { cost: { energy: 2, power: 1 }, effects: [{ op: 'EMPOWER_SELF' }] },
    ]);
    const d = parseCardAbilities('[Empower] — Discard 1 (Pay the cost: Empower me.)');
    expect(d?.abilities[0]?.cost.card).toMatchObject({ kind: 'DISCARD' });
    expect(parseStaticLines('[Empowered][>] I have [Deflect] and [Shield 3].')?.statics[0]).toEqual(
      {
        affects: 'SELF',
        keywords: [{ name: 'Deflect' }, { name: 'Shield', value: 3 }],
        when: { kind: 'EMPOWERED' },
      },
    );
    const t = parseCardAbilities('[Empowered][>] When I conquer, you score 1 point.');
    expect(t?.triggers[0]).toMatchObject({ on: 'CONQUER', when: { kind: 'EMPOWERED' } });
  });

  it('reads kill-cost Empower and an Empowered Deathknell with its icon', () => {
    // Tests Rule 145.1: parsed ability text (R66)
    const k = parseCardAbilities('[Empower] — Kill a friendly unit (Pay the cost: Empower me.)');
    expect(k?.abilities[0]?.cost.card).toMatchObject({ kind: 'KILL' });
    const d = parseCardAbilities('[Empowered][>][>>][Deathknell][>] Channel 2 runes exhausted.');
    expect(d?.triggers[0]).toMatchObject({ on: 'DEATH', when: { kind: 'EMPOWERED' } });
  });
});
