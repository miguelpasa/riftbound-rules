/** R42: attack / defend triggers, "here" / "another" scopes, optional ("you may") targets, Weaponmaster. */
import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { reduce } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardEffect, CardTrigger, Intent } from '../types/index.js';

const withGrunt = (patch: Partial<CardDef>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), ...patch },
});
const withTriggers = (triggers: CardTrigger[]): CardDatabase => withGrunt({ triggers });

const DISARM_1: CardEffect = { op: 'DEBUFF_TARGET', amount: 1, side: 'enemy', here: true };

const choose = (sc: Scenario, targets: string[], player: 'p0' | 'p1' = 'p0'): Intent => {
  const pc = sc.state.flow.pendingChoice;
  if (pc?.kind !== 'TRIGGER_TARGET') throw new Error('no trigger choice pending');
  return {
    type: 'CHOOSE_TRIGGER_TARGET',
    playerId: player,
    chainItemId: pc.chainItemId,
    targets: targets.map((id) => ({ kind: 'object' as const, id })),
  };
};

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });

/** p0's fx-grunt (cards decide its triggers) attacks bf1 where p1 holds two units; p1 has one in base. */
function attackSetup(cards: CardDatabase) {
  const sc = Scenario.start({}, cards);
  const d1 = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
  const d2 = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
  const away = sc.putUnit('p1', 'fx-tide-archer', 'base');
  const att = sc.putUnit('p0', 'fx-grunt', 'base');
  sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [att], destination: toBf('bf1') });
  return { sc, d1, d2, away, att };
}

describe('scenario: attack and defend triggers (R42)', () => {
  it('"When I attack" asks for a target among the enemy units HERE only', () => {
    // Tests Rule 466.2.c: the attacker's units are Attackers once the combat Showdown begins
    const { sc, d1, d2, away } = attackSetup(withTriggers([{ on: 'ATTACK', effects: [DISARM_1] }]));
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    const picked = legal.map((i) =>
      i.type === 'CHOOSE_TRIGGER_TARGET' && i.targets[0]?.kind === 'object' ? i.targets[0].id : '',
    );
    expect(picked.sort()).toEqual([d1, d2].sort());
    expect(picked).not.toContain(away);
    expect(sc.reject(choose(sc, [away])).code).toBe('ILLEGAL_TARGET');
    sc.do(choose(sc, [d2]));
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(d2).mightBonus).toBe(-1);
    expect(sc.obj(d1).mightBonus).toBe(0);
    sc.verify();
  });

  it('"When I defend" fires for the defender, with the lone attacker taken automatically', () => {
    // Tests Rule 466.2.c: the defender's units are Defenders in the combat Showdown
    const cards = withGrunt({});
    cards['fx-order-tank'] = {
      ...(cards['fx-order-tank'] as CardDef),
      triggers: [{ on: 'DEFEND', effects: [DISARM_1] }],
    };
    const { sc, d1, att } = attackSetup(cards);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.chain.filter((i) => i.triggered)).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ controller: 'p1', sourceObjectId: d1 });
    expect(sc.state.flow.chain[0]?.targets).toEqual([{ kind: 'object', id: att }]);
    sc.pass('p0');
    sc.pass('p1');
    expect(sc.obj(att).mightBonus).toBe(-1);
  });

  it('does not fire for units that are not in the combat or for a non-combat Showdown', () => {
    // Tests Rule 466.2.c: only the units at the battlefield are Attackers / Defenders
    const sc = Scenario.start({}, withTriggers([{ on: 'ATTACK', effects: [DISARM_1] }]));
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1', { control: true });
    sc.putUnit('p0', 'fx-grunt', 'base'); // stays home
    const mover = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [mover], destination: toBf('bf1') });
    expect(sc.state.flow.chain.some((i) => i.triggered)).toBe(false);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
  });
});

describe('scenario: "another" and optional targets (R42)', () => {
  it('"another friendly unit" never picks the source itself', () => {
    // Tests Rule 355.10: the legal target set honours the "another" restriction
    const effect: CardEffect = { op: 'READY_TARGET', side: 'friendly', another: true };
    const sc = Scenario.start({}, withTriggers([{ on: 'PLAY', effects: [effect] }]));
    const other = sc.putUnit('p0', 'fx-ash-tank', 'base', { ready: false });
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.flow.chain[0]?.targets).toEqual([{ kind: 'object', id: other }]);
  });

  it('skips the trigger when only the source qualifies for "another"', () => {
    // Tests Rule 355.10: no legal target, nothing goes on the Chain
    const effect: CardEffect = { op: 'READY_TARGET', side: 'friendly', another: true };
    const sc = Scenario.start({}, withTriggers([{ on: 'PLAY', effects: [effect] }]));
    const unit = sc.putInHand('p0', 'fx-grunt');
    const r = sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.eventsOfType('TRIGGER_NO_TARGET', r.events)).toHaveLength(1);
  });

  const MAY: CardEffect = {
    op: 'BUFF_TARGET',
    amount: 2,
    duration: 'TURN',
    side: 'friendly',
    count: { min: 0, max: 1 },
  };

  it('"you may": the controller can decline with an empty choice', () => {
    // Tests Rule 355.10: an optional ("up to one") target accepts none, which declines the effect
    const sc = Scenario.start({}, withTriggers([{ on: 'PLAY', effects: [MAY] }]));
    const a = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal.some((i) => i.type === 'CHOOSE_TRIGGER_TARGET' && i.targets.length === 0)).toBe(
      true,
    );
    sc.do(choose(sc, []));
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(a).mightBonus).toBe(0);
    expect(sc.obj(unit).mightBonus).toBe(0);
    sc.verify();
  });

  it('"you may": accepting applies the effect', () => {
    // Tests Rule 355.10: choosing a target for an optional effect applies it
    const sc = Scenario.start({}, withTriggers([{ on: 'PLAY', effects: [MAY] }]));
    const a = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.do(choose(sc, [a]));
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(a).mightBonus).toBe(2);
  });

  it('"you may" with no legal target is skipped, and a mandatory trigger still rejects an empty choice', () => {
    // Tests Rule 355.10: nothing to decline when nothing can be chosen
    const sc = Scenario.start(
      {},
      withTriggers([
        { on: 'PLAY', effects: [{ ...MAY, side: 'enemy' } as CardEffect] },
        { on: 'PLAY', effects: [{ op: 'BUFF_TARGET', amount: 1, side: 'friendly' }] },
      ]),
    );
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.putUnit('p0', 'fx-archer', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    const r = sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.eventsOfType('TRIGGER_NO_TARGET', r.events)).toHaveLength(1);
    expect(sc.reject(choose(sc, [])).code).toBe('ILLEGAL_TARGET');
  });

  it('the bot answers an optional trigger choice with a legal intent', () => {
    // Tests Rule 355.10: the bot resolves the same pending choice a human sees
    const sc = Scenario.start({}, withTriggers([{ on: 'PLAY', effects: [MAY] }]));
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const intent = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(intent?.type).toBe('CHOOSE_TRIGGER_TARGET');
    expect(reduce(sc.state, sc.cards, intent as Intent).ok).toBe(true);
  });
});

describe('scenario: Weaponmaster (821, R42)', () => {
  const WM: CardTrigger = {
    on: 'PLAY',
    effects: [{ op: 'WEAPONMASTER_EQUIP', count: { min: 0, max: 1 } }],
  };
  const bladeDb = (energy: number): CardDatabase => {
    const db = withTriggers([WM]);
    db['fx-blade'] = {
      ...(SCENARIO_CARDS['fx-blade'] as CardDef),
      equipCost: { energy, power: 0, anyPower: 1 },
    };
    return db;
  };

  it('attaches a chosen Equipment and pays its Equip cost minus [A]', () => {
    // Tests Rule 821: pay the Equip cost reduced by [A], then attach to this unit
    const sc = Scenario.start({}, bladeDb(2));
    const blade = sc.putUnit('p0', 'fx-blade', 'base');
    sc.setPool('p0', 10);
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: [], location: { kind: 'base' } });
    expect(sc.player('p0').runePool.energy).toBe(8);
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal.some((i) => i.type === 'CHOOSE_TRIGGER_TARGET' && i.targets.length === 0)).toBe(
      true,
    );
    sc.do(choose(sc, [blade]));
    expect(sc.player('p0').runePool.energy).toBe(8); // paid on resolution
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(blade).attachedTo).toBe(unit);
    expect(sc.player('p0').runePool.energy).toBe(6);
    expect(sc.events.some((e) => e.type === 'EQUIPPED')).toBe(true);
    sc.verify();
  });

  it('declining pays nothing and attaches nothing', () => {
    // Tests Rule 821: Weaponmaster is a "you may" effect
    const sc = Scenario.start({}, bladeDb(2));
    const blade = sc.putUnit('p0', 'fx-blade', 'base');
    sc.setPool('p0', 10);
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: [], location: { kind: 'base' } });
    sc.do(choose(sc, []));
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(blade).attachedTo).toBeUndefined();
    expect(sc.player('p0').runePool.energy).toBe(8);
  });

  it('offers no Equipment that cannot be paid for, and skips the trigger', () => {
    // Tests Rule 821: the reduced Equip cost must be payable
    const sc = Scenario.start({}, bladeDb(30));
    sc.putUnit('p0', 'fx-blade', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    const r = sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.eventsOfType('TRIGGER_NO_TARGET', r.events)).toHaveLength(1);
  });

  it('never targets an opponent Equipment', () => {
    // Tests Rule 821: "one of your Equipment"
    const sc = Scenario.start({}, bladeDb(0));
    const theirs = sc.putUnit('p1', 'fx-blade', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    const r = sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.eventsOfType('TRIGGER_NO_TARGET', r.events)).toHaveLength(1);
    expect(sc.obj(theirs).attachedTo).toBeUndefined();
  });
});

describe('scenario: "This enters exhausted" (R42)', () => {
  it('a Gear with entersExhausted enters exhausted, other Gear enters ready', () => {
    // Tests Rule 359.2.d: Gear enters ready unless its text says it enters exhausted
    const db: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': { ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef), entersExhausted: true },
    };
    const sc = Scenario.start({}, db);
    const g = sc.putInHand('p0', 'fx-ember-totem');
    sc.play('p0', g, { payment: sc.exhaustPlan('p0', 2) });
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(g).zone.kind).toBe('base');
    expect(sc.obj(g).ready).toBe(false);
  });
});

describe('parser: R42 sentence shapes', () => {
  it('parses attack / defend heads, scopes and the Disarm and Weaponmaster keywords', () => {
    // Tests Rule 831: Disarm is the attack trigger "give an enemy unit here -N [M] this turn"
    const leona = parseCardAbilities('When I attack, stun an enemy unit here.');
    expect(leona?.triggers).toEqual([
      { on: 'ATTACK', effects: [{ op: 'STUN_TARGET', side: 'enemy', here: true }] },
    ]);
    const both = parseCardAbilities(
      'When I attack or defend, give an enemy unit here -1 [M] this turn, to a minimum of 1 [M].',
    );
    expect(both?.triggers.map((t) => t.on)).toEqual(['ATTACK', 'DEFEND']);
    const reveler = parseCardAbilities('When I attack, ready another friendly unit.');
    expect(reveler?.triggers[0]?.effects).toEqual([
      { op: 'READY_TARGET', side: 'friendly', another: true },
    ]);
    const disarm = parseCardAbilities(
      '[Disarm 2] (When I attack, give an enemy unit here -2 [M] this turn.)',
    );
    expect(disarm?.triggers).toEqual([
      { on: 'ATTACK', effects: [{ op: 'DEBUFF_TARGET', amount: 2, side: 'enemy', here: true }] },
    ]);
    // Several Disarm instances sum into one trigger (831)
    const sum = parseCardAbilities('[Disarm]\n[Disarm 2]');
    expect(sum?.triggers).toHaveLength(1);
    expect(sum?.triggers[0]?.effects[0]).toMatchObject({ amount: 3 });
    // Prose that merely mentions the keyword is not Disarm
    expect(parseCardAbilities('Your Mechs have [Disarm].')).toBeNull();
    const wm = parseCardAbilities(
      '[Weaponmaster] (When you play me, you may [Equip] one of your Equipment to me for [A] less.)',
    );
    expect(wm?.triggers).toEqual([
      { on: 'PLAY', effects: [{ op: 'WEAPONMASTER_EQUIP', count: { min: 0, max: 1 } }] },
    ]);
  });

  it('parses "you may" choosers, gear Energy limits and "This enters exhausted"', () => {
    // Tests Rule 355.10: optional targets are "up to one"
    const goat = parseCardAbilities(
      'When you play me, you may kill a gear with Energy cost [2] or less.',
    );
    expect(goat?.triggers[0]?.effects).toEqual([
      { op: 'KILL_GEAR', maxEnergy: 2, count: { min: 0, max: 1 } },
    ]);
    const ballista = parseCardAbilities(
      'This enters exhausted.\n[E]: Deal 2 to a unit at a battlefield.',
      {
        gearLike: true,
      },
    );
    expect(ballista?.entersExhausted).toBe(true);
    expect(ballista?.abilities).toHaveLength(1);
    // Not for non-gear, not as a trigger-less spell fragment
    expect(parseCardAbilities('This enters exhausted.', { gearLike: false })).toBeNull();
    // Scopes cannot ride on gear choosers
    expect(parseCardAbilities('When I attack, kill a gear here.')).toBeNull();
    // Mournful Spirit: a Deathknell's "here" is where the unit died (see deathknellHere.test.ts)
    expect(parseCardAbilities('[Deathknell][>] You may kill a unit or gear here.')).not.toBeNull();
  });
});

describe('scenario: Repeat (820, R42)', () => {
  const repeatDb = (): CardDatabase => ({
    ...SCENARIO_CARDS,
    'fx-flare': {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      effects: [{ op: 'BUFF_TARGET', amount: 1, duration: 'TURN', side: 'friendly' }],
      repeatCost: { energy: 2, power: 0 },
    },
  });

  it('paying the Repeat cost runs the effects twice and charges the extra cost', () => {
    // Tests Rule 820: Repeat is an optional additional cost; the effects happen one more time
    const sc = Scenario.start({}, repeatDb());
    const target = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.setPool('p0', 10);
    const r = sc.play('p0', spell, {
      payment: [],
      targets: [{ kind: 'object', id: target }],
      additionalCosts: { repeat: true },
    });
    expect(sc.player('p0').runePool.energy).toBe(10 - 1 - 2);
    expect(sc.state.flow.chain[0]?.additionalCosts).toEqual({ repeat: true });
    expect(r.ok).toBe(true);
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(target).mightBonus).toBe(2);
    sc.verify();
  });

  it('without the Repeat cost the effects run once', () => {
    // Tests Rule 820: the cost is optional
    const sc = Scenario.start({}, repeatDb());
    const target = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.setPool('p0', 10);
    sc.play('p0', spell, { payment: [], targets: [{ kind: 'object', id: target }] });
    expect(sc.player('p0').runePool.energy).toBe(9);
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(target).mightBonus).toBe(1);
  });

  it('rejects Repeat on a card without a Repeat cost and lists both variants in legal actions', () => {
    // Tests Rule 820: only cards with Repeat offer it
    const plain = Scenario.start({}, SCENARIO_CARDS);
    const s1 = plain.putInHand('p0', 'fx-flare');
    plain.setPool('p0', 10);
    expect(
      plain.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: s1,
        payment: [],
        additionalCosts: { repeat: true },
      }).code,
    ).toBe('KEYWORD_RESTRICTION');
    const sc = Scenario.start({}, repeatDb());
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.setPool('p0', 10);
    const plays = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(plays.some((i) => i.type === 'PLAY_CARD' && i.additionalCosts?.repeat)).toBe(true);
    expect(plays.some((i) => i.type === 'PLAY_CARD' && !i.additionalCosts?.repeat)).toBe(true);
    for (const i of plays) expect(reduce(sc.state, sc.cards, i).ok).toBe(true);
  });

  it('a Repeat variant is not offered when it cannot be paid', () => {
    // Tests Rule 820: the additional cost must be payable
    const db = repeatDb();
    db['fx-flare'] = { ...(db['fx-flare'] as CardDef), repeatCost: { energy: 40, power: 0 } };
    const sc = Scenario.start({}, db);
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    const plays = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.some((i) => i.type === 'PLAY_CARD' && i.additionalCosts?.repeat)).toBe(false);
  });
});
