import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { effectiveMight } from '../combat.js';
import { staticBonus } from '../statics.js';
import { evalCondition } from '../conditions.js';
import { parseCardAbilities, parseSpellText, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, CardInstance } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;

describe('scenario: Bonus Damage (Annie, Void Gate)', () => {
  it("adds damage to the controller's spells and abilities, and to every spell at one battlefield", () => {
    // Tests Rule 573: damage dealt by an effect
    const annie = parseStaticLines('Your spells and abilities deal 1 Bonus Damage.');
    const gate = parseStaticLines('Spells and abilities deal 1 Bonus Damage to units here.');
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': { ...base('fx-ember-totem'), statics: annie?.statics ?? [] },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const target = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'DAMAGE_TARGET', amount: 1 }], cards, [
      { kind: 'object', id: target },
    ]);
    expect((s.objects[target] as CardInstance).damage).toBe(2);
    // the opponent's spell gets no bonus from Annie
    const s2 = structuredClone(sc.state);
    runEffects(
      s2,
      'p1',
      [{ op: 'DAMAGE_ALL', amount: 1, side: 'any', scope: 'here' }],
      cards,
      [],
      '',
      target,
    );
    expect((s2.objects[target] as CardInstance).damage).toBe(1);
    // Void Gate: a Battlefield card's static counts for units at that battlefield
    expect(gate?.statics[0]).toMatchObject({ bonusDamage: { amount: 1, scope: 'HERE' } });
    const cards2: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-bf-4': { ...base('fx-bf-4'), statics: gate?.statics ?? [] },
    };
    const s3 = structuredClone(sc.state);
    runEffects(s3, 'p0', [{ op: 'DAMAGE_TARGET', amount: 1 }], cards2, [
      { kind: 'object', id: target },
    ]);
    const at = (s3.objects[target] as CardInstance).zone;
    const bf = s3.battlefields.find((b) => at.kind === 'battlefield' && b.id === at.battlefieldId);
    expect((s3.objects[target] as CardInstance).damage).toBe(bf?.cardId === 'fx-bf-4' ? 2 : 1);
  });
});

describe('scenario: small shapes (Qiyana, Dune Drake, Stand United)', () => {
  it('reads "draw 1 or channel 1 rune exhausted" as two modes', () => {
    // Tests Rule 583.3: a triggered ability with modes
    const r = parseCardAbilities('When I conquer, draw 1 or channel 1 rune exhausted.');
    expect(r?.triggers[0]?.modes).toEqual([
      [{ op: 'DRAW', amount: 1 }],
      [{ op: 'CHANNEL', amount: 1, exhausted: true }],
    ]);
  });

  it('checks for a ready enemy unit here', () => {
    // Tests Rule 583.3: a condition on a triggered ability
    const r = parseCardAbilities(
      'When I attack, give me +2 [M] this turn if there is a ready enemy unit here.',
    );
    const cond = r?.triggers[0]?.when;
    expect(cond).toMatchObject({ kind: 'COUNT', who: 'enemy', ready: true });
    const sc = Scenario.start();
    const me = sc.putUnit('p0', 'fx-grunt', 'bf1');
    if (!cond) throw new Error('no condition');
    expect(evalCondition(sc.state, sc.cards, cond, 'p0', me)).toBe(false);
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    expect(evalCondition(sc.state, sc.cards, cond, 'p0', me)).toBe(true);
    (sc.state.objects[enemy] as CardInstance).ready = false;
    expect(evalCondition(sc.state, sc.cards, cond, 'p0', me)).toBe(false);
  });

  it('Stand United gives buffed friendly units extra Might until the turn ends', () => {
    // Tests Rule 563: an effect that lasts for the turn
    const eff = parseSpellText(
      'Buff a friendly unit. Buffs give an additional +1 [M] to friendly units this turn.',
    );
    expect(eff?.[1]).toEqual({ op: 'BUFF_BONUS_TURN', amount: 1 });
    const sc = Scenario.start();
    const buffed = sc.putUnit('p0', 'fx-grunt', 'base');
    const plain = sc.putUnit('p0', 'fx-ash-tank', 'base');
    (sc.state.objects[buffed] as CardInstance).buffed = true;
    const before = effectiveMight(sc.state, sc.cards, buffed, { role: null });
    const plainBefore = effectiveMight(sc.state, sc.cards, plain, { role: null });
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'BUFF_BONUS_TURN', amount: 1 }], sc.cards);
    expect(effectiveMight(s, sc.cards, buffed, { role: null })).toBe(before + 1);
    expect(effectiveMight(s, sc.cards, plain, { role: null })).toBe(plainBefore);
    s.turn.number += 1;
    expect(effectiveMight(s, sc.cards, buffed, { role: null })).toBe(before);
  });
});

describe('scenario: more statics (Leona, Fiora, Wuju Bladesman)', () => {
  const withStatic = (
    line: string,
  ): { cards: CardDatabase; st: ReturnType<typeof parseStaticLines> } => {
    const st = parseStaticLines(line);
    return {
      st,
      cards: {
        ...SCENARIO_CARDS,
        'fx-ember-totem': { ...base('fx-ember-totem'), statics: st?.statics ?? [] },
      },
    };
  };

  it('Leona: stunned enemy units here lose Might but not below the minimum', () => {
    // Tests Rule 563: a static ability changes Might
    const { cards } = withStatic('Stunned enemy units here have -2 [M], to a minimum of 1 [M].');
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'bf1');
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'bf1'); // 2 [M]
    const printed = effectiveMight(sc.state, cards, enemy, { role: null });
    expect(printed).toBe(2);
    (sc.state.objects[enemy] as CardInstance).stunned = true;
    expect(effectiveMight(sc.state, cards, enemy, { role: null })).toBe(1);
  });

  it('Fiora: gains the keywords only while she is Mighty', () => {
    // Tests Rule 563: a static ability grants keywords while its condition holds
    const { cards } = withStatic("While I'm [Mighty], I have [Deflect], [Ganking], and [Shield].");
    const sc = Scenario.start({}, cards);
    const me = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const kw = (): string[] =>
      staticBonus(sc.state, cards, sc.state.objects[me] as CardInstance).keywords.map(
        (k) => k.name,
      );
    expect(kw()).toEqual([]);
    (sc.state.objects[me] as CardInstance).mightBonus = 9;
    expect(kw()).toEqual(['Deflect', 'Ganking', 'Shield']);
  });

  it('Wuju Bladesman: a friendly unit defending alone gets +1 [M]', () => {
    // Tests Rule 563: a static ability changes Might
    const { cards, st } = withStatic('While a friendly unit defends alone, it gets +1 [M].');
    expect(st?.statics[0]).toMatchObject({ onlyDefendingAlone: true, might: 1 });
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const d = sc.putUnit('p0', 'fx-grunt', 'bf0');
    const printed = effectiveMight(sc.state, cards, d, { role: null });
    expect(effectiveMight(sc.state, cards, d, { role: null })).toBe(printed); // no combat
    const s = structuredClone(sc.state);
    s.flow.combat = {
      battlefieldId: 'bf0',
      attacker: 'p1',
      defender: 'p0',
      step: 'DAMAGE',
    } as never;
    expect(effectiveMight(s, cards, d, { role: null })).toBe(printed + 1);
  });
});
