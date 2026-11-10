import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { runEffects, spellTargetsLegal } from '../effects.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const bf1 = { kind: 'battlefield' as const, battlefieldId: 'bf1' };
const legendWith = (t: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-legend-ember': { ...(SCENARIO_CARDS['fx-legend-ember'] as CardDef), triggers: [t] },
});
function settle(sc: Scenario): void {
  for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

describe('scenario: Legend triggers for winning a combat and holding (R101)', () => {
  it('"When you win a combat" fires for the winner\'s Legend', () => {
    // Tests Rule 468.3: the side with units left wins the combat
    const sc = Scenario.start(
      {},
      legendWith({ on: 'WIN_COMBAT', effects: [{ op: 'DRAW', amount: 1 }] }),
    );
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [titan], destination: bf1 });
    sc.pass('p0');
    sc.pass('p1');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: foe, amount: 7 }],
    });
    if (sc.state.flow.combat?.awaitingAssignmentFrom === 'p1') {
      sc.do({
        type: 'ASSIGN_COMBAT_DAMAGE',
        playerId: 'p1',
        assignments: [{ unitId: titan, amount: 2 }],
      });
    }
    const hand = sc.player('p0').hand.length;
    settle(sc);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });

  it('"When you hold" fires for the Legend of the player who holds', () => {
    // Tests Rule 473: a Hold happens in the Scoring step
    const sc = Scenario.start(
      {},
      legendWith({ on: 'HOLD', effects: [{ op: 'GAIN_XP', amount: 1 }] }),
    );
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const xp = sc.player('p0').xp ?? 0;
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's Scoring step holds bf1
    settle(sc);
    expect(sc.player('p0').xp ?? 0).toBe(xp + 1);
  });
});

describe('parser: Legend player triggers (R101)', () => {
  it('reads "When you win a combat / hold" for Legends only', () => {
    // Tests Rule 303: parsed text
    expect(
      parseCardAbilities('When you win a combat, draw 1.', { legend: true })?.triggers[0]?.on,
    ).toBe('WIN_COMBAT');
    expect(parseCardAbilities('When you hold, gain 1 XP.', { legend: true })?.triggers[0]?.on).toBe(
      'HOLD',
    );
    // on a unit or gear the same words are a youScore trigger (fires at any battlefield)
    expect(parseCardAbilities('When you hold, gain 1 XP.')?.triggers[0]).toMatchObject({
      on: 'HOLD',
      youScore: true,
    });
  });
});

describe('scenario: Legend "When you conquer, if you have 4+ units at that battlefield" (Might of Demacia)', () => {
  const text = 'When you conquer, if you have 4+ units at that battlefield, draw 2.';

  it('reads the condition as a count at the scored battlefield', () => {
    // Tests Rule 303: parsed text
    expect(parseCardAbilities(text, { legend: true })?.triggers[0]).toMatchObject({
      on: 'CONQUER',
      effects: [{ op: 'DRAW', amount: 2 }],
      when: { kind: 'COUNT', what: 'unit', where: 'scored', who: 'friendly', cmp: 'GTE', n: 4 },
    });
  });

  it("counts the units at the battlefield that was scored, not the Legend's own location", () => {
    // Tests Rule 473: a Hold scores one battlefield; the count is of the units standing there
    const trig: CardTrigger = {
      on: 'HOLD',
      effects: [{ op: 'DRAW', amount: 1 }],
      when: { kind: 'COUNT', what: 'unit', where: 'scored', who: 'friendly', cmp: 'GTE', n: 2 },
    };
    const run = (units: number, inBase = 0): number => {
      const sc = Scenario.start({}, legendWith(trig));
      sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
      for (let i = 1; i < units; i++) sc.putUnit('p0', 'fx-archer', 'bf1');
      for (let i = 0; i < inBase; i++) sc.putUnit('p0', 'fx-ash-tank', 'base');
      const hand = sc.player('p0').hand.length;
      sc.endTurn('p0');
      sc.endTurn('p1');
      settle(sc);
      return sc.player('p0').hand.length - hand;
    };
    const lone = run(1);
    expect(run(2)).toBe(lone + 1);
    expect(run(1, 3)).toBe(lone); // units in the Base do not count
  });
});

describe('scenario: Legend "When you empower something else, empower me" (Matriarch of War)', () => {
  const text = 'When you empower something else, empower me.';

  it('reads a Legend trigger on empowering another permanent', () => {
    // Tests Rule 303: parsed text
    expect(parseCardAbilities(text, { legend: true })?.triggers[0]).toMatchObject({
      on: 'YOU_EMPOWER_ELSE',
      effects: [{ op: 'EMPOWER_SELF' }],
    });
  });

  /** p0's Legend carries the trigger; a spell empowers `target` (a gear of p0, or p1's gear). */
  function legendEmpowered(ownGear: boolean): boolean {
    const trig = parseCardAbilities(text, { legend: true })?.triggers ?? [];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-legend-ember': { ...(SCENARIO_CARDS['fx-legend-ember'] as CardDef), triggers: trig },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'EMPOWER_TARGET', gear: true }],
      },
    };
    const sc = Scenario.start({}, cards);
    const gear = sc.putUnit(ownGear ? 'p0' : 'p1', ownGear ? 'fx-blade' : 'fx-tide-totem', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: gear }],
    });
    settle(sc);
    const legend = sc.state.objects[sc.state.players[0]?.legend as string];
    return legend?.empowered === true;
  }

  it("the Legend is empowered when another of its controller's permanents is, not an enemy one", () => {
    // Tests Rule 303: a triggered ability fires on its event
    expect(legendEmpowered(true)).toBe(true);
    expect(legendEmpowered(false)).toBe(false);
  });
});

describe('scenario: Legend "When you banish a card you own, empower me" (Master of Shadows)', () => {
  const text = 'When you banish a card you own, empower me.';

  it('reads a Legend trigger on banishing one of your own cards', () => {
    // Tests Rule 303: parsed text
    expect(parseCardAbilities(text, { legend: true })?.triggers[0]).toMatchObject({
      on: 'YOU_BANISH_OWN',
      effects: [{ op: 'EMPOWER_SELF' }],
    });
  });

  /** p0 banishes `target` (its own unit, or p1's unit) with a spell; returns whether p0's Legend got empowered. */
  function legendEmpowered(own: boolean): boolean {
    const trig = parseCardAbilities(text, { legend: true })?.triggers ?? [];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-legend-ember': { ...(SCENARIO_CARDS['fx-legend-ember'] as CardDef), triggers: trig },
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'BANISH_TARGET' }],
      },
    };
    const sc = Scenario.start({}, cards);
    const victim = sc.putUnit(own ? 'p0' : 'p1', own ? 'fx-grunt' : 'fx-tide-grunt', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: victim }],
    });
    settle(sc);
    expect(sc.obj(victim).zone.kind).toBe('banishment');
    return sc.state.objects[sc.state.players[0]?.legend as string]?.empowered === true;
  }

  it("fires for a card its owner banished, not for an opponent's card", () => {
    // Tests Rule 303: a triggered ability fires on its event
    expect(legendEmpowered(true)).toBe(true);
    expect(legendEmpowered(false)).toBe(false);
  });
});

describe('scenario: Legend "Disempower me, [E]: Give a unit at a battlefield -2 [M] this turn" (Soul\'s Reflection)', () => {
  const text =
    'When you empower something else, empower me.\nDisempower me, [E]: Give a unit at a battlefield -2 [M] this turn.';

  it('reads the ability with a battlefield-only debuff target', () => {
    // Tests Rule 145.1: an activated ability with a cost and an effect
    const parsed = parseCardAbilities(text, { legend: true });
    expect(parsed?.abilities[0]).toMatchObject({
      cost: { disempower: true, exhaust: true },
      effects: [{ op: 'DEBUFF_TARGET', amount: 2, atBattlefield: true }],
    });
    expect(parsed?.triggers[0]?.on).toBe('YOU_EMPOWER_ELSE');
  });

  it('only a unit at a battlefield can be chosen', () => {
    // Tests Rule 355.10: a target must meet the ability\'s requirements
    const eff = parseCardAbilities(text, { legend: true })?.abilities[0]?.effects ?? [];
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const atBf = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const home = sc.putUnit('p1', 'fx-order-tank', 'base');
    const legal = (id: string) =>
      spellTargetsLegal(sc.state, SCENARIO_CARDS, 'p0', eff, [{ kind: 'object', id }]);
    expect(legal(atBf)).toBe(true);
    expect(legal(home)).toBe(false);
  });
});

describe('scenario: "When you play me, ready or exhaust a legend" (Royal Entourage)', () => {
  const text = 'When you play me, ready or exhaust a legend.';
  const trig = parseCardAbilities(text)?.triggers[0];

  it('reads a choice between readying and exhausting a legend', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(trig).toMatchObject({
      on: 'PLAY',
      modes: [[{ op: 'READY_LEGEND' }], [{ op: 'EXHAUST_LEGEND' }]],
    });
  });

  it("readies or exhausts the controller's Legend", () => {
    // Tests Rule 583: a triggered ability resolves its chosen mode
    const run = (mode: number, ready: boolean): boolean => {
      const sc = Scenario.start({}, SCENARIO_CARDS);
      const legendId = sc.state.players[0]?.legend as string;
      sc.state.objects[legendId]!.ready = ready;
      const s = structuredClone(sc.state);
      runEffects(s, 'p0', trig?.modes?.[mode] ?? [], SCENARIO_CARDS, [], 'fx-grunt', '');
      return s.objects[legendId]?.ready === true;
    };
    expect(run(0, false)).toBe(true); // ready it
    expect(run(1, true)).toBe(false); // exhaust it
    expect(run(0, true)).toBe(true);
    expect(run(1, false)).toBe(false);
  });
});
