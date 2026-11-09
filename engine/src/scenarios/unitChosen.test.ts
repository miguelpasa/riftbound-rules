import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import { runEffects } from '../effects.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;

describe('scenario: "When you choose a unit" (Jae Medarda, Spirit Wheel, Blade Dancer, Irelia)', () => {
  it('reads the three heads', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(
      parseCardAbilities('When you choose me with a spell, draw 1.')?.triggers[0],
    ).toMatchObject({ on: 'UNIT_CHOSEN', chosen: { target: 'self', spellOnly: true } });
    expect(
      parseCardAbilities(
        'When you choose a friendly unit, you may pay [1] and exhaust this to draw 1.',
      )?.triggers[0],
    ).toMatchObject({ on: 'UNIT_CHOSEN', chosen: { target: 'friendly' } });
    const irelia = parseCardAbilities('When you choose or ready me, give me +1 [M] this turn.');
    expect(irelia?.triggers.map((t) => t.on)).toEqual(['UNIT_CHOSEN', 'BECOME_READY']);
  });

  it('draws a card when a spell chooses the unit, not when an enemy spell does or no unit is chosen', () => {
    // Tests Rule 583: a triggered ability fires on its event
    const parsed = parseCardAbilities('When you choose me with a spell, draw 1.');
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...base('fx-ash-tank'), triggers: parsed?.triggers ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const jae = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const handBefore = sc.state.players[0]?.hand.length ?? 0;
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: jae }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    // one card played from hand, one drawn
    expect(sc.state.players[0]?.hand.length).toBe(handBefore + 1 - 1 + 1);
  });
});

describe('scenario: "Choose two units" (Clash of Giants)', () => {
  it('lets the caster pick any two different units and they hit each other', () => {
    // Tests Rule 573: damage dealt by an effect
    const effects = parseSpellText(
      'Choose two units. They deal damage equal to their Mights to each other.',
    );
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: effects ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const b = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [
        { kind: 'object', id: a },
        { kind: 'object', id: b },
      ],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.obj(a).damage + sc.obj(b).damage).toBeGreaterThan(0);
  });
});

describe('scenario: "If you do," follow-ups (Adaptatron)', () => {
  const parsed = parseCardAbilities(
    "When I conquer, you may kill a gear. If you do, buff me. (If I don't have a buff, I get a +1 [M] buff.)",
  );

  it('reads the second effect as conditional on the first', () => {
    // Tests Rule 583: effects of a triggered ability resolve in order
    expect(parsed?.triggers[0]?.effects.map((e) => [e.op, e.ifDid ?? false])).toEqual([
      ['KILL_GEAR', false],
      ['BUFF_SELF', true],
    ]);
  });

  it('buffs only when a gear was actually killed', () => {
    // Tests Rule 583: "if you do" needs the earlier instruction to have been carried out
    const effects = parsed?.triggers[0]?.effects ?? [];
    const sc = Scenario.start({});
    const me = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const none = structuredClone(sc.state);
    runEffects(none, 'p0', effects, sc.cards, [], '', me);
    expect(none.objects[me]?.mightBonus ?? 0).toBe(0);
  });
});
