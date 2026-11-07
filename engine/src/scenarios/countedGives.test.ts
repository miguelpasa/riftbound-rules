import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { defWithGrants } from '../statics.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const cast = (effect: CardEffect): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [effect],
  },
});
function resolve(sc: Scenario, target: string): void {
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, {
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: target }],
  });
  sc.pass('p1');
  sc.pass('p0');
}
const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: amounts that depend on the board (R93)', () => {
  it('"[Assault] equal to its Might" gives the target Assault with its Might as value', () => {
    // Tests Rule 143.2: the keyword value is read from the unit
    const sc = Scenario.start(
      {},
      cast({ op: 'GRANT_KEYWORD_TARGET', keywords: [{ name: 'Assault' }], valueFromMight: true }),
    );
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    const m = might(sc, u);
    resolve(sc, u);
    const kws = defWithGrants(sc.state, sc.cards, sc.obj(u))?.keywords ?? [];
    expect(kws.find((k) => k.name === 'Assault')?.value).toBe(m);
  });

  it('"-[M] equal to the number of exhausted units you control" counts exhausted friendly units', () => {
    // Tests Rule 143.2: debuff scaled by a board count
    const sc = Scenario.start({}, cast({ op: 'DEBUFF_TARGET', amount: 1, timesExhausted: true }));
    const target = sc.putUnit('p1', 'fx-order-titan', 'base');
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const b = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.setReady(a, false);
    sc.setReady(b, false);
    const before = might(sc, target);
    resolve(sc, target);
    expect(might(sc, target)).toBe(before - 2);
  });

  it('"+N [M] for each enemy unit there" scales with the enemies at the battlefield', () => {
    // Tests Rule 143.2: bonus scaled by enemies at the target's battlefield
    const sc = Scenario.start(
      {},
      cast({
        op: 'BUFF_TARGET',
        amount: 2,
        duration: 'TURN',
        timesEnemiesThere: true,
        atBattlefield: true,
        side: 'friendly',
      }),
    );
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    sc.putUnit('p1', 'fx-order-tank', 'bf1');
    const mine = sc.putUnit('p0', 'fx-grunt', 'bf1');
    const before = might(sc, mine);
    resolve(sc, mine);
    expect(might(sc, mine)).toBe(before + 4);
  });
});

describe('scenario: buff all units here (R93)', () => {
  it("buffs every unit at the source's battlefield, optionally skipping the source", () => {
    // Tests Rule 143.2: a buff is a +1 Might marker
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [
          {
            on: 'PLAY',
            effects: [
              { op: 'BUFF_ALL', amount: 1, buff: true, side: 'friendly', here: true, others: true },
            ],
          },
        ],
      },
    };
    const sc = Scenario.start({}, cards);
    const mate = sc.putUnit('p0', 'fx-ash-tank', 'bf1', { control: true });
    const far = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const g = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', g, {
      payment: sc.exhaustPlan('p0', 2),
      location: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(mate).buffed).toBe(true);
    expect(sc.obj(far).buffed).toBeFalsy();
    expect(sc.obj(g).buffed).toBeFalsy();
  });
});

describe('parser: counted gives and buff-all-here (R93)', () => {
  it('reads the phrases', () => {
    // Tests Rule 143.2: parsed text
    expect(parseSpellText('Give a unit [Assault] this turn equal to its Might.')).toEqual([
      { op: 'GRANT_KEYWORD_TARGET', keywords: [{ name: 'Assault' }], valueFromMight: true },
    ]);
    expect(parseCardAbilities('When I hold, [Buff] all units here.')?.triggers[0]?.effects).toEqual(
      [{ op: 'BUFF_ALL', amount: 1, buff: true, side: 'any', here: true }],
    );
    expect(
      parseCardAbilities(
        'When you play me, buff me. Then, if I am at a battlefield, buff all other friendly units there.',
      )?.triggers[0]?.effects[1],
    ).toMatchObject({ op: 'BUFF_ALL', here: true, others: true, side: 'friendly' });
  });
});
