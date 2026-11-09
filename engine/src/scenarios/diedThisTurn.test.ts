import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { evalCondition } from '../conditions.js';
import { killLethalUnits } from '../combat.js';
import { runEffects } from '../effects.js';
import { parseCardAbilities, parseCondition, parseSelfCostReduction } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

/** A card in the database asks for deaths, so they are recorded. */
const asking: CardDatabase = {
  ...SCENARIO_CARDS,
  'fx-ash-tank': {
    ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
    entersReadyWhen: { kind: 'DIED_THIS_TURN', who: 'any' },
  },
};

describe('scenario: "a unit died this turn" (R56)', () => {
  it('records deaths per side and turn, only when some card asks', () => {
    // Tests Rule 323: units with lethal damage die in Cleanup
    const sc = Scenario.start({}, asking);
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(
      evalCondition(sc.state, sc.cards, { kind: 'DIED_THIS_TURN', who: 'any' }, 'p0', mine),
    ).toBe(false);
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'KILL_TARGET', side: 'enemy' }], sc.cards, [
      { kind: 'object', id: foe },
    ]);
    killLethalUnits(s, sc.cards);
    sc.state = s;
    const at = (who: 'friendly' | 'enemy' | 'any') =>
      evalCondition(sc.state, sc.cards, { kind: 'DIED_THIS_TURN', who }, 'p0', mine);
    expect(at('enemy')).toBe(true);
    expect(at('any')).toBe(true);
    expect(at('friendly')).toBe(false);
  });

  it('records nothing when no card asks (states of ordinary games stay unchanged)', () => {
    // Tests Rule 323: bookkeeping is opt-in
    const sc = Scenario.start();
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'KILL_TARGET', side: 'enemy' }], sc.cards, [
      { kind: 'object', id: foe },
    ]);
    killLethalUnits(s, sc.cards);
    expect(s.players[1]?.diedThisTurn).toBeUndefined();
  });
});

describe('parser: died this turn', () => {
  it('reads the condition, "If <cond>, I enter ready" and the reversed cost reduction', () => {
    // Tests Rule 323: parsed text
    expect(parseCondition('a unit died this turn')).toEqual({ kind: 'DIED_THIS_TURN', who: 'any' });
    expect(parseCondition('an enemy unit has died this turn')).toEqual({
      kind: 'DIED_THIS_TURN',
      who: 'enemy',
    });
    expect(parseCardAbilities('If a unit died this turn, I enter ready.')?.entersReadyWhen).toEqual(
      {
        kind: 'DIED_THIS_TURN',
        who: 'any',
      },
    );
    expect(
      parseSelfCostReduction('If an enemy unit has died this turn, this costs [2] less.')
        ?.reduction,
    ).toEqual({
      energy: 2,
      when: { kind: 'DIED_THIS_TURN', who: 'enemy' },
    });
  });
});

describe('scenario: "a friendly unit or gear died this turn" (Lingering Animus)', () => {
  const orGear: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ash-tank': {
      ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
      entersReadyWhen: { kind: 'DIED_THIS_TURN', who: 'friendly', orGear: true },
    },
  };
  const cond = { kind: 'DIED_THIS_TURN', who: 'friendly', orGear: true } as const;

  it('reads the printed sentence', () => {
    // Tests Rule 323: units with lethal damage die in Cleanup
    expect(parseCondition('a friendly unit or gear died this turn')).toEqual(cond);
    expect(parseCardAbilities('I enter ready if a friendly unit or gear died this turn.')).toMatchObject({
      entersReadyWhen: cond,
    });
  });

  it('counts a friendly gear dying, but a plain "unit died" condition does not', () => {
    // Tests Rule 323.4: a killed permanent goes to its owner's Trash
    const sc = Scenario.start({}, orGear);
    const mine = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const gear = sc.putUnit('p1', 'fx-tide-totem', 'base');
    expect(evalCondition(sc.state, sc.cards, cond, 'p1', mine)).toBe(false);
    const s = structuredClone(sc.state);
    runEffects(s, 'p1', [{ op: 'KILL_GEAR', side: 'friendly' }], sc.cards, [
      { kind: 'object', id: gear },
    ]);
    sc.state = s;
    expect(evalCondition(sc.state, sc.cards, cond, 'p1', mine)).toBe(true);
    expect(
      evalCondition(sc.state, sc.cards, { kind: 'DIED_THIS_TURN', who: 'friendly' }, 'p1', mine),
    ).toBe(false);
  });
});
