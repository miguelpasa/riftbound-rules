import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const attackerWith = (effect: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-titan': {
    ...(SCENARIO_CARDS['fx-titan'] as CardDef),
    triggers: [{ on: 'ATTACK', effects: [effect] }],
  },
});

function attack(cards: CardDatabase): {
  sc: Scenario;
  titan: string;
  here: string[];
  away: string;
} {
  const sc = Scenario.start({}, cards);
  const a = sc.putUnit('p1', 'fx-order-titan', 'bf1', { control: true });
  const b = sc.putUnit('p1', 'fx-order-tank', 'bf1');
  const away = sc.putUnit('p1', 'fx-tide-grunt', 'base');
  const titan = sc.putUnit('p0', 'fx-titan', 'base');
  sc.do({
    type: 'STANDARD_MOVE',
    playerId: 'p0',
    unitIds: [titan],
    destination: { kind: 'battlefield', battlefieldId: 'bf1' },
  });
  for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
  return { sc, titan, here: [a, b], away };
}

describe('scenario: damage to all enemy units here (R86)', () => {
  it("hurts every enemy unit at the source's battlefield and nobody else", () => {
    // Tests Rule 466.2.c: an Attack trigger fires when the combat Showdown begins
    const { sc, here, away } = attack(
      attackerWith({ op: 'DAMAGE_ALL', amount: 1, side: 'enemy', scope: 'here' }),
    );
    for (const id of here) expect(sc.obj(id).damage).toBe(1);
    expect(sc.obj(away).damage).toBe(0);
  });

  it('"damage equal to my Might" deals the source\'s current Might to each', () => {
    // Tests Rule 143.2: damage equal to Might
    const { sc, titan, here } = attack(
      attackerWith({
        op: 'DAMAGE_ALL',
        amount: 0,
        amountFrom: 'MY_MIGHT',
        side: 'enemy',
        scope: 'here',
      }),
    );
    const might = Math.max(0, effectiveMight(sc.state, sc.cards, titan, { role: 'ATTACKER' }));
    expect(might).toBeGreaterThan(0);
    // Damage that reaches lethal is cleaned up; survivors carry exactly that damage.
    for (const id of here) {
      const o = sc.obj(id);
      expect(o.zone.kind === 'trash' || o.damage === might).toBe(true);
    }
  });
});

describe('parser: area damage here and "... here" statics (R86)', () => {
  it('reads the phrases', () => {
    // Tests Rule 143.2: parsed text
    expect(
      parseCardAbilities('When I attack, deal 3 to all enemy units here.')?.triggers[0]?.effects,
    ).toEqual([{ op: 'DAMAGE_ALL', amount: 3, side: 'enemy', scope: 'here' }]);
    expect(parseStaticLines('Other friendly units have +1 [M] here.')?.statics).toEqual([
      { affects: 'OTHER_FRIENDLY_HERE', might: 1 },
    ]);
    expect(parseStaticLines("While I'm buffed, I have an additional +1 [M].")?.statics).toEqual([
      { affects: 'SELF', might: 1, when: { kind: 'BUFFED' } },
    ]);
  });
});
