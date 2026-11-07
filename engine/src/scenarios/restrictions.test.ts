import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { staticBonus } from '../statics.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, Intent, StaticAbility } from '../types/index.js';

const withCards = (patch: Record<string, Partial<CardDef>>): CardDatabase => {
  const out: CardDatabase = { ...SCENARIO_CARDS };
  for (const [id, p] of Object.entries(patch)) {
    out[id] = { ...(SCENARIO_CARDS[id] as CardDef), ...p };
  }
  return out;
};
const withStatic = (id: string, s: StaticAbility): CardDatabase =>
  withCards({
    [id]: { statics: [s] },
    'fx-flare': { supportLevel: 'partial', effects: [{ op: 'KILL_TARGET' }] },
  });

describe('statics: combat damage and targeting restrictions (R74)', () => {
  it('"I don\'t deal combat damage" removes the unit from the damage total', () => {
    // Tests Rule 467.2: a unit that deals no combat damage contributes no Might
    const sc = Scenario.start(
      {},
      withStatic('fx-order-tank', { affects: 'SELF', restrict: 'NO_COMBAT_DAMAGE' }),
    );
    const tank = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [titan],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: tank, amount: 7 }],
    });
    // The defender has nothing to assign: the combat resolved and the attacker won.
    expect(sc.state.flow.combat).toBeUndefined();
    expect(sc.bf('bf1').controller).toBe('p0');
  });

  it('"... unless <condition>" restores the damage while the condition holds', () => {
    // Tests Rule 467.2: a conditional restriction is read live
    const sc = Scenario.start(
      {},
      withStatic('fx-order-tank', {
        affects: 'SELF',
        restrict: 'NO_COMBAT_DAMAGE',
        unless: { kind: 'XP', n: 1 },
      }),
    );
    const tank = sc.obj(sc.putUnit('p1', 'fx-order-tank', 'bf1'));
    expect(staticBonus(sc.state, sc.cards, tank).noCombatDamage).toBe(true);
    (sc.state.players[1] as (typeof sc.state.players)[number]).xp = 1;
    expect(staticBonus(sc.state, sc.cards, tank).noCombatDamage).toBeUndefined();
  });

  it('"Enemy units here with less Might than me" only affects weaker enemies at my battlefield', () => {
    // Tests Rule 143.2: Might comparisons use the printed Might plus bonuses
    const sc = Scenario.start(
      {},
      withStatic('fx-titan', {
        affects: 'ENEMY_UNITS_HERE',
        restrict: 'NO_COMBAT_DAMAGE',
        lessMight: true,
      }),
    );
    sc.putUnit('p0', 'fx-titan', 'bf1');
    const weak = sc.obj(sc.putUnit('p1', 'fx-tide-grunt', 'bf1'));
    const strong = sc.obj(sc.putUnit('p1', 'fx-order-titan', 'bf1'));
    const away = sc.obj(sc.putUnit('p1', 'fx-tide-grunt', 'base'));
    sc.setMightBonus(strong.id, 10);
    expect(staticBonus(sc.state, sc.cards, weak).noCombatDamage).toBe(true);
    expect(staticBonus(sc.state, sc.cards, strong).noCombatDamage).toBeUndefined();
    expect(staticBonus(sc.state, sc.cards, away).noCombatDamage).toBeUndefined();
  });

  it('"can\'t be chosen by enemy spells and abilities": the owner may still choose it', () => {
    // Tests Rule 355.10: targets must be legal; an enemy cannot choose the protected unit
    const sc = Scenario.start(
      {},
      {
        ...withStatic('fx-tide-grunt', { affects: 'SELF', restrict: 'NO_ENEMY_CHOOSE' }),
        'fx-grunt': {
          ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
          statics: [{ affects: 'SELF', restrict: 'NO_ENEMY_CHOOSE' }],
        },
      },
    );
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    const err = sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: spell,
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: enemy }],
    });
    expect(err.code).toBe('ILLEGAL_TARGET');
    expect(staticBonus(sc.state, sc.cards, sc.obj(enemy)).noEnemyChoose).toBe(true);
    // The same card under its own controller's control can be chosen by that controller.
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: mine }],
    });
    expect(sc.state.flow.chain).toHaveLength(1);
  });

  it('"... unless I\'m in combat" lifts the protection during a combat there', () => {
    // Tests Rule 462: a combat Showdown is in progress at the battlefield
    const sc = Scenario.start(
      {},
      withStatic('fx-order-tank', {
        affects: 'SELF',
        restrict: 'NO_ENEMY_CHOOSE',
        unless: { kind: 'IN_COMBAT' },
      }),
    );
    const tank = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    expect(staticBonus(sc.state, sc.cards, sc.obj(tank)).noEnemyChoose).toBe(true);
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [titan],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    expect(staticBonus(sc.state, sc.cards, sc.obj(tank)).noEnemyChoose).toBeUndefined();
  });
});

describe('abilities: only at a battlefield, damage equal to my Might (R74)', () => {
  const cards = withCards({
    'fx-grunt': {
      abilities: [
        {
          cost: { exhaust: true },
          atBattlefield: true,
          effects: [
            { op: 'DAMAGE_TARGET', amount: 0, amountFrom: 'MY_MIGHT', atBattlefield: true },
          ],
        },
      ],
    },
  });

  it("cannot be used from the Base, and deals damage equal to the source's Might at a battlefield", () => {
    // Tests Rule 145.1: activated abilities; the source's Might is read as the ability resolves
    const sc = Scenario.start({}, cards);
    const target = sc.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
    const home = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(home, true);
    const use = (src: string): Intent => ({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: src,
      abilityIndex: 0,
      targets: [{ kind: 'object', id: target }],
      payment: [],
    });
    expect(sc.reject(use(home)).code).toBe('ABILITY_NOT_AVAILABLE');

    const there = sc.putUnit('p0', 'fx-grunt', 'bf1');
    sc.setReady(there, true);
    sc.do(use(there));
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(target).damage).toBe(effectiveMight(sc.state, sc.cards, there, { role: null }));
  });
});

describe('parser: restrictions (R74)', () => {
  const one = (t: string) => parseStaticLines(t)?.statics;

  it('reads combat-damage and targeting statics', () => {
    // Tests Rule 467.2: parsed static text
    expect(one("I don't deal combat damage.")).toEqual([
      { affects: 'SELF', restrict: 'NO_COMBAT_DAMAGE' },
    ]);
    expect(one("Enemy units here with less Might than me don't deal combat damage.")).toEqual([
      { affects: 'ENEMY_UNITS_HERE', lessMight: true, restrict: 'NO_COMBAT_DAMAGE' },
    ]);
    expect(one("I can't be chosen by enemy spells and abilities unless I'm in combat.")).toEqual([
      { affects: 'SELF', restrict: 'NO_ENEMY_CHOOSE', unless: { kind: 'IN_COMBAT' } },
    ]);
    expect(
      one("Your units here with less Might than me can't be chosen by enemy spells and abilities."),
    ).toEqual([{ affects: 'FRIENDLY_UNITS_HERE', lessMight: true, restrict: 'NO_ENEMY_CHOOSE' }]);
    expect(one('I must be assigned combat damage last.')).toEqual([
      { affects: 'SELF', keywords: [{ name: 'Backline' }] },
    ]);
  });

  it('reads the "only at a battlefield" ability rider and Level-gated restrictions', () => {
    // Tests Rule 145.1: parsed ability text
    expect(
      parseCardAbilities("[E]: Draw 1. Use this ability only while I'm at a battlefield.")
        ?.abilities[0],
    ).toMatchObject({ atBattlefield: true, effects: [{ op: 'DRAW', amount: 1 }] });
    expect(one("[Level 16][>] I can't be chosen by enemy spells and abilities.")).toEqual([
      { affects: 'SELF', restrict: 'NO_ENEMY_CHOOSE', when: { kind: 'XP', n: 16 } },
    ]);
  });

  it('reads damage equal to my Might / Assault', () => {
    // Tests Rule 145.1: parsed effect text
    expect(
      parseCardAbilities('When I attack, deal damage equal to my [Assault] to an enemy unit here.')
        ?.triggers[0]?.effects[0],
    ).toMatchObject({ op: 'DAMAGE_TARGET', amountFrom: 'MY_ASSAULT', here: true, side: 'enemy' });
  });
});
