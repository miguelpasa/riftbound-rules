import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { runEffects } from '../effects.js';
import { parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance } from '../types/index.js';

describe('scenario: more spell shapes (Danger Zone, Existential Dread, Piercing Light)', () => {
  it('"Give your <subtype>s +N [M] this turn" buffs only friendly units of that subtype', () => {
    // Tests Rule 637.3: arithmetic on Might
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), subtypes: ['Mech'] },
    };
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const other = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const s = structuredClone(sc.state);
    const effects = parseSpellText('Give your Mechs +1 [M] this turn.');
    expect(effects).toEqual([
      { op: 'BUFF_ALL', amount: 1, side: 'friendly', duration: 'TURN', subtype: 'Mech' },
    ]);
    runEffects(s, 'p0', effects ?? [], sc.cards);
    expect(effectiveMight(s, sc.cards, mine, { role: null })).toBe(
      (SCENARIO_CARDS['fx-grunt']?.stats.might ?? 0) + 1,
    );
    expect(effectiveMight(s, sc.cards, other, { role: null })).toBe(
      SCENARIO_CARDS['fx-ash-tank']?.stats.might ?? 0,
    );
  });

  it('stuns a unit, and returns it to its owner hand when it is already stunned', () => {
    // Tests Rule 573.1: "instead" changes the effect when the unit is already stunned
    const effects = parseSpellText(
      'Stun an enemy unit. If it is already stunned, return it to its owner’s hand instead.'.replace(
        'it is',
        'it’s',
      ),
    );
    expect(effects).toEqual([{ op: 'STUN_TARGET', side: 'enemy', orReturn: true }]);
    const sc = Scenario.start();
    const foe = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    const target = [{ kind: 'object' as const, id: foe }];
    runEffects(s, 'p0', effects ?? [], sc.cards, target);
    expect((s.objects[foe] as CardInstance).stunned).toBe(true);
    runEffects(s, 'p0', effects ?? [], sc.cards, target);
    expect((s.objects[foe] as CardInstance).zone.kind).toBe('hand');
  });

  it('parses Piercing Light: a unit at a battlefield, then up to one other unit', () => {
    // Tests Rule 559.3.c.6: optional extra choices are targeted independently
    expect(
      parseSpellText('Deal 2 to a unit at a battlefield, then deal 2 to up to one other unit.'),
    ).toEqual([
      { op: 'DAMAGE_TARGET', amount: 2, atBattlefield: true },
      { op: 'DAMAGE_TARGET', amount: 2, count: { min: 0, max: 1 }, another: true, slot: 1 },
    ]);
  });
});
