/** X9: "When you stun an enemy unit", "When you discard", "When a unit you control becomes Mighty". */
import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect, CardTrigger } from '../types/index.js';

const watch = (trigger: CardTrigger, spellEffects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ash-tank': { ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef), triggers: [trigger] },
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    effects: spellEffects,
    supportLevel: 'full',
  } as CardDef,
});
const might = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: stun triggers (X9)', () => {
  it('fires once per newly stunned enemy unit; a stunned unit is not stunned again', () => {
    // Tests Rule 599.1.a.1: a stunned unit cannot be stunned again, so the trigger does not fire
    const sc = Scenario.start(
      {},
      watch({ on: 'YOU_STUN_ENEMY', effects: [{ op: 'BUFF_SELF', amount: 2 }] }, [
        { op: 'STUN_TARGET', side: 'enemy' },
      ]),
    );
    const w = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const enemy = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    sc.giveRunes('p0', 2);
    const base = might(sc, w);
    const f1 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f1, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: enemy }],
    });
    settle(sc);
    expect(sc.state.objects[enemy]?.stunned).toBe(true);
    expect(might(sc, w)).toBe(base + 2);
    const f2 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f2, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: enemy }],
    });
    settle(sc);
    expect(might(sc, w)).toBe(base + 2);
  });
});

describe('scenario: becomes Mighty (X9)', () => {
  it('fires when a unit reaches 5 Might, not when it was already Mighty or enters Mighty', () => {
    // Tests Rule 709: a unit becomes Mighty when its Might goes from below 5 to 5 or more
    const sc = Scenario.start(
      {},
      watch({ on: 'UNIT_BECOMES_MIGHTY', effects: [{ op: 'BUFF_SELF', amount: 1 }] }, [
        { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly' },
      ]),
    );
    const w = sc.putUnit('p0', 'fx-ash-tank', 'base'); // Might 3
    sc.giveRunes('p0', 2);
    const f1 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f1, { payment: sc.exhaustPlan('p0', 1), targets: [{ kind: 'object', id: w }] });
    settle(sc);
    expect(might(sc, w)).toBe(3 + 2 + 1); // buffed to 5, then its own trigger +1
    const f2 = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', f2, { payment: sc.exhaustPlan('p0', 1), targets: [{ kind: 'object', id: w }] });
    settle(sc);
    expect(might(sc, w)).toBe(3 + 2 + 1 + 2); // already Mighty: no second trigger
  });
});

describe('scenario: discard triggers (X9)', () => {
  it('"When you discard one or more cards" fires once for the discarding player only', async () => {
    // Tests Rule 598.1.b: abilities that trigger on discarding run after the discard has occurred
    const { fireTriggers } = await import('../triggers.js');
    const cards = watch({ on: 'YOU_DISCARD', effects: [{ op: 'BUFF_SELF', amount: 2 }] }, []);
    const sc = Scenario.start({}, cards);
    const w = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const ev = (player: 'p0' | 'p1') =>
      ({
        seq: 1,
        type: 'COST_CARDS_PAID',
        player,
        sourceId: w,
        kind: 'DISCARD',
        cardIds: ['x', 'y'],
        cardNames: ['a', 'b'],
      }) as never;
    const opp = fireTriggers(structuredClone(sc.state), cards, [ev('p1')]);
    expect(opp.state.flow.chain).toHaveLength(0);
    const mine = fireTriggers(structuredClone(sc.state), cards, [ev('p0')]);
    expect(mine.state.flow.chain).toHaveLength(1);
  });
});

describe('scenario: "When a unit you control becomes Mighty, you may pay [C] to ready it" (Fiora)', () => {
  const text = 'When a unit you control becomes [Mighty], you may pay [C] to ready it.';

  it('reads an optional payment that readies the unit that became Mighty', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(parseCardAbilities(text)?.triggers[0]).toMatchObject({
      on: 'UNIT_BECOMES_MIGHTY',
      optional: { power: 1 },
      effects: [{ op: 'READY_TARGET', side: 'friendly' }],
    });
  });

  it('offers to ready the unit that became Mighty, not the watcher or another unit', () => {
    // Tests Rule 709: the event is about the unit that crossed 5 Might
    const trig = parseCardAbilities(text)?.triggers[0] as CardTrigger;
    const sc = Scenario.start(
      {},
      watch(trig, [{ op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly' }]),
    );
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base'); // Fiora stand-in, Might 3
    const grunt = sc.putUnit('p0', 'fx-grunt', 'base'); // Might 2: 4 after the buff, not Mighty
    const target = sc.putUnit('p0', 'fx-archer', 'base');
    sc.state.objects[target]!.mightBonus = 1; // 3 Might; +2 makes it 5
    for (const id of [watcher, grunt, target]) sc.state.objects[id]!.ready = false;
    sc.giveRunes('p0', 2);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: target }],
    });
    for (let i = 0; i < 10 && sc.state.flow.chain.length > 0 && !sc.state.flow.pendingChoice; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    const pc = sc.state.flow.pendingChoice;
    expect(pc?.kind).toBe('OPTIONAL_EFFECT');
    if (pc?.kind !== 'OPTIONAL_EFFECT') return;
    sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId: pc.chainItemId, accept: true });
    expect(sc.obj(target).ready).toBe(true);
    expect(sc.obj(grunt).ready).toBe(false);
    expect(sc.obj(watcher).ready).toBe(false);
  });
});
