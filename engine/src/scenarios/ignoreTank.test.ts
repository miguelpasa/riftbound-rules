import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseStaticLines } from '../cardText.js';
import { computeAssignmentConstraints, effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const text = 'You ignore [Tank] while assigning combat damage here.';
const statics = parseStaticLines(text)?.statics ?? [];
const toBf = (battlefieldId: string) => ({ kind: 'battlefield' as const, battlefieldId });

/** `fx-grunt` stands in for Dune Surfer. */
const surfer: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), statics },
};

/** p0 attacks bf1 with `attacker`; p1 defends with a Tank and an ordinary unit. Returns the required order. */
function tiersFor(cards: CardDatabase, attacker: 'fx-grunt' | 'fx-archer'): string[] {
  const sc = Scenario.start({}, cards);
  sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true }); // Tank, Might 3
  sc.putUnit('p1', 'fx-tide-grunt', 'bf1'); // ordinary
  const unit = sc.putUnit('p0', attacker, 'base');
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [unit], destination: toBf('bf1') });
  sc.pass('p0');
  sc.pass('p1');
  return computeAssignmentConstraints(sc.state, cards, 'p0').ordered.map((u) => u.tier);
}

describe('parser: "You ignore [Tank] while assigning combat damage here" (Dune Surfer)', () => {
  it('reads as a static on the unit', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(statics).toEqual([{ affects: 'SELF', ignoreTank: true }]);
  });
});

describe('scenario: ignoring Tank while assigning combat damage (467.2.c)', () => {
  it('without the static the Tank must be assigned damage first', () => {
    // Tests Rule 467.2.c: Tank units are assigned lethal damage first
    expect(tiersFor(SCENARIO_CARDS, 'fx-grunt')).toEqual(['TANK', 'NORMAL']);
  });

  it('with a Surfer among the attackers the Tank is an ordinary unit', () => {
    // Tests Rule 467.2.c: the assigner ignores Tank
    expect(tiersFor(surfer, 'fx-grunt')).toEqual(['NORMAL', 'NORMAL']);
  });
});

describe('scenario: "[Empowered][>] Your units that are [Empowered] have +2 [M]" (Aurok General)', () => {
  const text = '[Empowered][>] Your units that are [Empowered] have +2 [M] (including me).';
  const parsed = parseStaticLines(text)?.statics ?? [];

  it('reads a static for the Empowered friendly units, gated on the source being Empowered', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(parsed).toEqual([
      {
        affects: 'FRIENDLY_UNITS',
        onlyEmpowered: true,
        might: 2,
        when: { kind: 'EMPOWERED' },
      },
    ]);
  });

  it('boosts only Empowered friendly units, and only while the General is Empowered', () => {
    // Tests Rule 584: the static applies while its condition holds
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics: parsed },
    };
    const sc = Scenario.start({}, cards);
    const general = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const empowered = sc.putUnit('p0', 'fx-grunt', 'base');
    const plain = sc.putUnit('p0', 'fx-archer', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const m = (id: string) => effectiveMight(sc.state, cards, id, { role: null });
    const base = { e: m(empowered), p: m(plain), f: m(foe) };
    sc.state.objects[empowered]!.empowered = true;
    sc.state.objects[foe]!.empowered = true;
    expect(m(empowered)).toBe(base.e); // the General is not Empowered: nothing
    sc.state.objects[general]!.empowered = true;
    expect(m(empowered)).toBe(base.e + 2);
    expect(m(plain)).toBe(base.p);
    expect(m(foe)).toBe(base.f); // enemy units never count
    expect(m(general)).toBe(3 + 2); // including itself
  });
});

describe('scenario: "Your units have +1 [M]. If I\'m [Empowered], they have +2 [M] instead." (Rage Amplifier)', () => {
  const text = "Your units have +1 [M]. If I'm [Empowered], they have +2 [M] instead.";
  const parsed = parseStaticLines(text)?.statics ?? [];

  it('reads two statics: +1 normally, +2 while Empowered', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(parsed).toEqual([
      { affects: 'FRIENDLY_UNITS', might: 1, when: { kind: 'NOT', cond: { kind: 'EMPOWERED' } } },
      { affects: 'FRIENDLY_UNITS', might: 2, when: { kind: 'EMPOWERED' } },
    ]);
  });

  it('gives +1 to friendly units, or +2 (not +3) once the gear is Empowered', () => {
    // Tests Rule 584: the "instead" replaces the smaller bonus
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': { ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef), statics: parsed },
    };
    const sc = Scenario.start({}, cards);
    const amp = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const m = (id: string) => effectiveMight(sc.state, cards, id, { role: null });
    expect(m(mine)).toBe(3); // 2 + 1
    expect(m(foe)).toBe(2); // enemies are not affected
    sc.state.objects[amp]!.empowered = true;
    expect(m(mine)).toBe(4); // 2 + 2, not 2 + 1 + 2
  });
});

describe('scenario: "[Empowered][>] I have +3 [M] and can\'t be dealt damage unless I\'m in combat" (Ambessa)', () => {
  const text = "[Empowered][>] I have +3 [M] and can't be dealt damage unless I'm in combat.";
  const parsed = parseStaticLines(text)?.statics ?? [];

  it('reads a Might bonus and a damage shield that lapses in combat, both only while Empowered', () => {
    // Tests Rule 584: static abilities apply while their condition holds
    expect(parsed).toEqual([
      { affects: 'SELF', might: 3, when: { kind: 'EMPOWERED' } },
      {
        affects: 'SELF',
        restrict: 'NO_DAMAGE',
        when: {
          kind: 'ALL',
          conds: [
            { kind: 'EMPOWERED' },
            { kind: 'NOT', cond: { kind: 'COMBAT_ROLE', role: 'EITHER' } },
          ],
        },
      },
    ]);
  });

  it('takes +3 Might and no damage outside combat while Empowered', () => {
    // Tests Rule 584: the static applies while its condition holds
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), statics: parsed },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'DAMAGE_TARGET', amount: 2 }],
      },
    };
    const hit = (empowered: boolean): { damage: number; might: number } => {
      const sc = Scenario.start({}, cards);
      const me = sc.putUnit('p0', 'fx-ash-tank', 'base');
      if (empowered) sc.state.objects[me]!.empowered = true;
      const flare = sc.putInHand('p0', 'fx-flare');
      sc.play('p0', flare, {
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: me }],
      });
      for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
        sc.pass(sc.state.flow.priority as 'p0' | 'p1');
      }
      return {
        damage: sc.obj(me).damage,
        might: effectiveMight(sc.state, cards, me, { role: null }),
      };
    };
    expect(hit(false)).toEqual({ damage: 2, might: 3 });
    expect(hit(true)).toEqual({ damage: 0, might: 6 });
  });
});
