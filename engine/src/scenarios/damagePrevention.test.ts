import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { applyDamageMods } from '../damageMod.js';
import { expireTurnEffects, runEffects } from '../effects.js';
import { parseSpellText, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect, CardInstance, GameState } from '../types/index.js';

function hit(
  sc: Scenario,
  s: GameState,
  unit: string,
  amount: number,
  by: 'p0' | 'p1' = 'p0',
): void {
  runEffects(
    s,
    by,
    [{ op: 'DAMAGE_TARGET', amount }],
    sc.cards,
    [{ kind: 'object', id: unit }],
    'fx-flare',
  );
}

const dmg = (s: GameState, id: string): number => (s.objects[id] as CardInstance).damage;

describe('scenario: damage prevention and doubling (X7)', () => {
  it('"prevent the next damage" stops one instance only', () => {
    // Tests Rule 573: a replacement effect alters the execution of a damage event
    const sc = Scenario.start();
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p1', [{ op: 'DAMAGE_MOD_TARGET', mod: 'PREVENT_NEXT' }], sc.cards, [
      { kind: 'object', id: u },
    ]);
    hit(sc, s, u, 2);
    expect(dmg(s, u)).toBe(0);
    hit(sc, s, u, 2);
    expect(dmg(s, u)).toBe(2);
  });

  it('"prevent the next 7 damage" is spent across several hits', () => {
    // Tests Rule 573: prevention of a fixed amount is used up
    const sc = Scenario.start();
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p1', [{ op: 'DAMAGE_MOD_TARGET', mod: 'PREVENT_AMOUNT', amount: 7 }], sc.cards, [
      { kind: 'object', id: u },
    ]);
    const o = s.objects[u] as CardInstance;
    expect(applyDamageMods(s, sc.cards, o, 5, { kind: 'COMBAT' })).toBe(0);
    expect(applyDamageMods(s, sc.cards, o, 5, { kind: 'COMBAT' })).toBe(3);
    expect(o.dmgMod).toBeUndefined();
  });

  it('doubling applies after prevention', () => {
    // Tests Rule 575: the owner orders replacements; prevention first leaves less to double
    const sc = Scenario.start();
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    const o = s.objects[u] as CardInstance;
    o.dmgMod = { prevent: 1, double: true };
    expect(applyDamageMods(s, sc.cards, o, 3, { kind: 'EFFECT', controller: 'p0' })).toBe(4);
    expect(applyDamageMods(s, sc.cards, o, 3, { kind: 'EFFECT', controller: 'p0' })).toBe(6);
  });

  it('the markers end with the turn', () => {
    // Tests Rule 317: "this turn" effects end in the Ending step
    const sc = Scenario.start();
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    (s.objects[u] as CardInstance).dmgMod = { double: true };
    s.noEffectDamageTurn = s.turn.number;
    const ended = expireTurnEffects(s, sc.cards).state;
    expect((ended.objects[u] as CardInstance).dmgMod).toBeUndefined();
  });

  it('a Static prevents damage from enemy spells only (Esteemed Hierophant)', () => {
    // Tests Rule 573: "prevent all damage that enemy spells and abilities would deal to me"
    const cards: CardDatabase = {
      ...TOKEN_CARDS,
      ...SCENARIO_CARDS,
      'fx-order-tank': {
        ...(SCENARIO_CARDS['fx-order-tank'] as CardDef),
        statics: [{ affects: 'SELF', restrict: 'NO_ENEMY_EFFECT_DAMAGE' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    hit(sc, s, u, 2, 'p0'); // an enemy spell
    expect(dmg(s, u)).toBe(0);
    hit(sc, s, u, 2, 'p1'); // its own controller
    expect(dmg(s, u)).toBe(2);
    const o = s.objects[u] as CardInstance;
    expect(applyDamageMods(s, sc.cards, o, 2, { kind: 'COMBAT' })).toBe(2);
  });

  it('"prevent all spell and ability damage this turn" leaves combat damage alone (Unyielding Spirit)', () => {
    // Tests Rule 573: prevention scoped to spells and abilities
    const sc = Scenario.start();
    const u = sc.putUnit('p1', 'fx-order-tank', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p1', [{ op: 'PREVENT_EFFECT_DAMAGE_TURN' }], sc.cards);
    hit(sc, s, u, 3, 'p0');
    hit(sc, s, u, 3, 'p1');
    expect(dmg(s, u)).toBe(0);
    const o = s.objects[u] as CardInstance;
    expect(applyDamageMods(s, sc.cards, o, 3, { kind: 'COMBAT' })).toBe(3);
  });

  it('parses the four cards', () => {
    // Tests Rule 573.1: replacement effects
    const one = (e: CardEffect): CardEffect[] => [e];
    expect(
      parseSpellText(
        'Choose a unit. The next time that unit would be dealt damage this turn, prevent it. Draw 1.',
      ),
    ).toEqual([
      ...one({ op: 'DAMAGE_MOD_TARGET', mod: 'PREVENT_NEXT' }),
      { op: 'DRAW', amount: 1 },
    ]);
    expect(
      parseSpellText(
        'Choose a unit. Prevent the next 7 damage that would be dealt to it this turn.',
      ),
    ).toEqual(one({ op: 'DAMAGE_MOD_TARGET', mod: 'PREVENT_AMOUNT', amount: 7 }));
    expect(
      parseSpellText('Choose a unit. Double all damage that would be dealt to it this turn.'),
    ).toEqual(one({ op: 'DAMAGE_MOD_TARGET', mod: 'DOUBLE' }));
    expect(parseSpellText('Prevent all spell and ability damage this turn.')).toEqual(
      one({ op: 'PREVENT_EFFECT_DAMAGE_TURN' }),
    );
    expect(
      parseStaticLines(
        'While you control 7 or more runes, prevent all damage that enemy spells and abilities would deal to me.',
      )?.statics[0],
    ).toMatchObject({ affects: 'SELF', restrict: 'NO_ENEMY_EFFECT_DAMAGE' });
  });
});
