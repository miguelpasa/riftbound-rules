import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { getLegalActions } from '../legalActions.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const bf = (id: string) => ({ kind: 'battlefield' as const, battlefieldId: id });

/** fx-ember-totem (p0's 2 Energy gear) as a Deploy gear with the given extras. */
const deploy = (extra: Partial<CardDef> = {}): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-ember-totem': {
    ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
    keywords: [{ name: 'Deploy' }],
    ...extra,
  },
});

function playTotem(sc: Scenario, where: 'bf1' | 'base'): string {
  const g = sc.putInHand('p0', 'fx-ember-totem');
  sc.play('p0', g, {
    payment: sc.exhaustPlan('p0', 2),
    ...(where === 'base' ? {} : { location: bf(where) }),
  });
  return g;
}

describe('scenario: Deploy gear (R85)', () => {
  it('is played only to a battlefield its controller controls and is listed that way', () => {
    // Tests Rule 359.2: where a permanent may enter
    const sc = Scenario.start({}, deploy());
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const g = sc.putInHand('p0', 'fx-ember-totem');
    const locs = getLegalActions(sc.state, sc.cards, 'p0')
      .filter((i) => i.type === 'PLAY_CARD' && i.cardInstanceId === g)
      .map((i) => (i.type === 'PLAY_CARD' ? i.location : undefined));
    expect(locs).toEqual([bf('bf1')]);
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: g,
        payment: sc.exhaustPlan('p0', 2),
        location: { kind: 'base' },
      }).code,
    ).toBe('ILLEGAL_LOCATION');
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: g,
        payment: sc.exhaustPlan('p0', 2),
      }).code,
    ).toBe('ILLEGAL_LOCATION');
  });

  it('stays at the battlefield through the Cleanup, unlike other gear', () => {
    // Tests Rule 323.6: Recall brings non-unit permanents home, except a Deploy gear
    const sc = Scenario.start({}, deploy());
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const g = playTotem(sc, 'bf1');
    expect(sc.obj(g).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    sc.verify();
  });

  it('is killed when an opponent holds its battlefield', () => {
    // Tests Rule 473.1: Deploy -- "When an opponent holds here, kill this"
    const sc = Scenario.start({}, deploy());
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const g = playTotem(sc, 'bf1');
    // The opponent takes control of bf1 with units and holds it on their turn.
    for (const o of Object.values(sc.state.objects)) {
      if (o.zone.kind === 'battlefield' && o.zone.battlefieldId === 'bf1' && o.id !== g) {
        o.zone = { kind: 'base', player: 'p0' };
        sc.state.players[0]?.base.push(o.id);
      }
    }
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    sc.endTurn('p0'); // p1's Beginning Phase holds bf1
    expect(sc.obj(g).zone.kind).toBe('trash');
  });

  it('works with "here" triggers and statics: win a combat, friendly units here', () => {
    // Tests Rule 303: a Deploy gear acts for the battlefield it stands at
    const sc = Scenario.start(
      {},
      deploy({
        triggers: [{ on: 'WIN_COMBAT', effects: [{ op: 'DRAW', amount: 1 }] }],
        statics: [{ affects: 'FRIENDLY_UNITS_HERE', keywords: [{ name: 'Shield', value: 2 }] }],
      }),
    );
    const mine = sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const away = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const base = effectiveMight(sc.state, sc.cards, away, { role: null });
    playTotem(sc, 'bf1');
    // Shield 2 only counts for a defender at the battlefield; the unit in the Base gets nothing.
    expect(effectiveMight(sc.state, sc.cards, away, { role: 'DEFENDER' })).toBe(base);
    expect(effectiveMight(sc.state, sc.cards, mine, { role: 'DEFENDER' })).toBe(
      effectiveMight(sc.state, sc.cards, mine, { role: null }) + 2,
    );
  });
});

describe('parser: Deploy gear text (R85)', () => {
  it('reads "here" triggers for gear and the friendly-units-here static', () => {
    // Tests Rule 303: parsed text
    expect(
      parseCardAbilities('[Deploy]\nWhen you win a combat here, draw 1.', { gearLike: true })
        ?.triggers[0]?.on,
    ).toBe('WIN_COMBAT');
    expect(
      parseCardAbilities('When you play this or when you conquer here, [Buff] a friendly unit.', {
        gearLike: true,
      })?.triggers.map((t) => t.on),
    ).toEqual(['PLAY', 'CONQUER']);
    expect(parseStaticLines('Friendly units here have [Assault].')?.statics).toEqual([
      { affects: 'FRIENDLY_UNITS_HERE', keywords: [{ name: 'Assault' }] },
    ]);
    expect(
      parseCardAbilities('At the end of your turn, if you control this battlefield, draw 1.', {
        gearLike: true,
      })?.triggers[0],
    ).toMatchObject({ on: 'TURN_END', when: { kind: 'CONTROLS_HERE' } });
  });
});

describe('scenario: Deploy gear triggers on the battlefield (R85)', () => {
  it('"When you win a combat here" fires for the controller of a Deploy gear that defends', () => {
    // Tests Rule 468.3: the side with units left wins; the gear wins with its controller
    const sc = Scenario.start(
      {},
      deploy({ triggers: [{ on: 'WIN_COMBAT', effects: [{ op: 'DRAW', amount: 1 }] }] }),
    );
    const titan = sc.putUnit('p0', 'fx-titan', 'bf1', { control: true });
    playTotem(sc, 'bf1');
    sc.endTurn('p0');
    const grunt = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p1', unitIds: [grunt], destination: bf('bf1') });
    sc.pass('p1');
    sc.pass('p0');
    const mightG = effectiveMight(sc.state, sc.cards, grunt, { role: 'ATTACKER' });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: [{ unitId: titan, amount: mightG }],
    });
    const mightT = effectiveMight(sc.state, sc.cards, titan, { role: 'DEFENDER' });
    const hand = sc.player('p0').hand.length;
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: grunt, amount: mightT }],
    });
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.player('p0').hand.length).toBe(hand + 1);
    expect(sc.obj(titan).zone.kind).toBe('battlefield');
  });
});

describe('scenario: "When you hold here" on a Deploy gear (R85)', () => {
  it("the gear's hold trigger can return it to its owner's hand", () => {
    // Tests Rule 473: a Hold triggers abilities of the holder's permanents at that battlefield
    const sc = Scenario.start(
      {},
      deploy({ triggers: [{ on: 'HOLD', effects: [{ op: 'RETURN_SELF' }] }] }),
    );
    sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const g = playTotem(sc, 'bf1');
    sc.endTurn('p0');
    sc.endTurn('p1'); // p0's Beginning Phase: Hold bf1
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.obj(g).zone.kind).toBe('hand');
  });
});
