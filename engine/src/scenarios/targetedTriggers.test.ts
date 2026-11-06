import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { actorToAct, reduce } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import type { CardDatabase, CardDef, CardEffect, CardTrigger, Intent } from '../types/index.js';

const BUFF: CardEffect = { op: 'BUFF_TARGET', amount: 2, duration: 'TURN' };
const BUFF_FRIENDLY: CardEffect = {
  op: 'BUFF_TARGET',
  amount: 2,
  duration: 'TURN',
  side: 'friendly',
};
const BUFF_ENEMY: CardEffect = { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'enemy' };

/** fx-grunt (p0's deck) gets the given triggers and abilities. */
const withGrunt = (patch: Partial<CardDef>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), ...patch },
});
const withTriggers = (triggers: CardTrigger[]): CardDatabase => withGrunt({ triggers });

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

/** p0 plays fx-grunt (trigger given by `cards`) with two other units on the board. */
function playWithTwoUnits(cards: CardDatabase): { sc: Scenario; a: string; b: string } {
  const sc = Scenario.start({}, cards);
  const a = sc.putUnit('p0', 'fx-ash-tank', 'base');
  const b = sc.putUnit('p1', 'fx-tide-grunt', 'base');
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  return { sc, a, b };
}

describe('scenario: targeted triggered abilities (R41)', () => {
  it('asks the controller to pick the target when there are several, and blocks everything else', () => {
    // Tests Rule 355.10: targets of a triggered ability are chosen when it is put on the Chain
    const { sc, a, b } = playWithTwoUnits(withTriggers([{ on: 'PLAY', effects: [BUFF] }]));
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    expect(sc.state.flow.chain[0]).toMatchObject({ status: 'PENDING', triggered: true });
    expect(actorToAct(sc.state)).toBe('p0');
    sc.reject({ type: 'PASS_PRIORITY', playerId: 'p0' });
    sc.reject({ type: 'PASS_PRIORITY', playerId: 'p1' });
    sc.reject({ type: 'END_TURN', playerId: 'p0' });
    sc.reject(choose(sc, [b], 'p1')); // not their choice
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal.length).toBeGreaterThanOrEqual(3); // the new grunt, a and b
    expect(legal.every((i) => i.type === 'CHOOSE_TRIGGER_TARGET')).toBe(true);
    expect(getLegalActions(sc.state, sc.cards, 'p1')).toEqual([]);
    const r = sc.do(choose(sc, [a]));
    expect(sc.eventsOfType('TRIGGER_TARGETED', r.events)).toHaveLength(1);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.chain[0]).toMatchObject({ status: 'FINALIZED' });
    expect(sc.state.flow.chain[0]?.targets).toEqual([{ kind: 'object', id: a }]);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(a).mightBonus).toBe(2);
    expect(sc.obj(b).mightBonus).toBe(0);
    sc.verify();
  });

  it('rejects an illegal target choice and leaves the choice pending', () => {
    // Tests Rule 355.10: a chosen target must be legal for the effect
    const { sc, a, b } = playWithTwoUnits(withTriggers([{ on: 'PLAY', effects: [BUFF_FRIENDLY] }]));
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    expect(sc.reject(choose(sc, [b])).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject(choose(sc, [])).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject(choose(sc, [a, a])).code).toBe('ILLEGAL_TARGET');
    sc.do(choose(sc, [a]));
  });

  it('takes the only legal target automatically', () => {
    // Tests Rule 355.10: with exactly one legal choice nothing is asked
    const { sc, b } = playWithTwoUnits(withTriggers([{ on: 'PLAY', effects: [BUFF_ENEMY] }]));
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.chain[0]).toMatchObject({ status: 'FINALIZED' });
    expect(sc.state.flow.chain[0]?.targets).toEqual([{ kind: 'object', id: b }]);
    expect(sc.events.some((e) => e.type === 'TRIGGER_TARGETED')).toBe(true);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(b).mightBonus).toBe(2);
  });

  it('puts nothing on the Chain when there is no legal target', () => {
    // Tests Rule 355.10: an ability that cannot choose its required target is not put on the Chain
    const sc = Scenario.start({}, withTriggers([{ on: 'PLAY', effects: [BUFF_ENEMY] }]));
    const unit = sc.putInHand('p0', 'fx-grunt');
    const r = sc.play('p0', unit, {
      payment: sc.exhaustPlan('p0', 2),
      location: { kind: 'base' },
    });
    expect(sc.eventsOfType('TRIGGER_NO_TARGET', r.events)).toHaveLength(1);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.chain.some((i) => i.triggered)).toBe(false);
  });

  it('fizzles when the target is gone by the time it resolves', () => {
    // Tests Rule 355.10: targets are checked again on resolution
    const { sc, a } = playWithTwoUnits(
      withTriggers([{ on: 'PLAY', effects: [{ op: 'BUFF_TARGET', amount: 1, side: 'friendly' }] }]),
    );
    sc.do(choose(sc, [a]));
    sc['edit']((s) => {
      const o = s.objects[a]!;
      s.players[0].base = s.players[0].base.filter((x) => x !== a);
      s.players[0].trash.push(a);
      o.zone = { kind: 'trash', player: 'p0' };
    });
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(r.events.some((e) => e.type === 'EFFECT_FIZZLED')).toBe(true);
  });

  it('asks for each waiting trigger in turn', () => {
    // Tests Rule 355.10: several triggers each get their targets chosen
    const sc = Scenario.start({}, withTriggers([{ on: 'HOLD', effects: [BUFF] }]));
    const bf = sc.state.battlefields[0]!.id;
    const g1 = sc.putUnit('p0', 'fx-grunt', bf, { control: true });
    sc.putUnit('p0', 'fx-grunt', bf);
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.endTurn('p0');
    sc.endTurn('p1');
    expect(sc.state.flow.chain.filter((i) => i.triggered)).toHaveLength(2);
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    const first = sc.state.flow.pendingChoice as { chainItemId: string };
    sc.do(choose(sc, [foe]));
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    expect((sc.state.flow.pendingChoice as { chainItemId: string }).chainItemId).not.toBe(
      first.chainItemId,
    );
    sc.do(choose(sc, [g1]));
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    while (sc.state.flow.chain.length > 0) sc.pass(sc.state.flow.priority!);
    expect(sc.obj(foe).mightBonus).toBe(2);
    expect(sc.obj(g1).mightBonus).toBe(2);
  });

  it('is visible in the opponent view and CONCEDE stays available', () => {
    // Tests Rule 649: conceding is always possible, even while a choice is pending
    const { sc } = playWithTwoUnits(withTriggers([{ on: 'PLAY', effects: [BUFF] }]));
    const view = sanitizeFor(sc.state, 'p1');
    expect(view.flow.pendingChoice).toMatchObject({ kind: 'TRIGGER_TARGET', player: 'p0' });
    const r = reduce(sc.state, sc.cards, { type: 'CONCEDE', playerId: 'p0' });
    expect(r.ok).toBe(true);
  });
});

describe('scenario: the bot answers target choices (R41)', () => {
  it('picks a legal CHOOSE_TRIGGER_TARGET when its trigger waits for targets', () => {
    // Tests Rule 355.10: the bot is asked like any player and must answer the pending choice
    const { sc } = playWithTwoUnits(withTriggers([{ on: 'PLAY', effects: [BUFF] }]));
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const intent = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(intent?.type).toBe('CHOOSE_TRIGGER_TARGET');
    expect(reduce(sc.state, sc.cards, intent as Intent).ok).toBe(true);
    const other = new AIController('p1', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    expect(other.decide(sanitizeFor(sc.state, 'p1'))).toBeNull();
  });

  it('activates a targeted ability with a target when that scores best', () => {
    // Tests Rule 145.1: bot-chosen targeted activations are accepted by the engine
    const sc = Scenario.start(
      {},
      withGrunt({ abilities: [{ cost: { exhaust: true }, effects: [BUFF_FRIENDLY] }] }),
    );
    sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    for (let i = 0; i < 6 && sc.state.flow.priority === 'p0'; i++) {
      const intent = bot.decide(sanitizeFor(sc.state, 'p0')) as Intent;
      sc.do(intent);
      if (intent.type === 'END_TURN') break;
    }
    sc.verify();
  });
});

describe('scenario: targeted activated abilities (R41)', () => {
  const cards = withGrunt({ abilities: [{ cost: { exhaust: true }, effects: [BUFF] }] });

  it('takes targets with ACTIVATE_ABILITY, validates them, and resolves on the Chain', () => {
    // Tests Rule 145.1: an activated ability may choose targets
    const sc = Scenario.start({}, cards);
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const base: Intent = {
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: src,
      abilityIndex: 0,
      payment: [],
    };
    expect(sc.reject(base).code).toBe('ILLEGAL_TARGET'); // needs a target
    expect(sc.reject({ ...base, targets: [{ kind: 'object', id: 'o99999' }] } as Intent).code).toBe(
      'ILLEGAL_TARGET',
    );
    sc.do({ ...base, targets: [{ kind: 'object', id: foe }] } as Intent);
    expect(sc.obj(src).ready).toBe(false);
    expect(sc.state.flow.chain[0]?.targets).toEqual([{ kind: 'object', id: foe }]);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(foe).mightBonus).toBe(2);
    sc.verify();
  });

  it('enumerates one ACTIVATE_ABILITY per legal target in getLegalActions', () => {
    // Tests Rule 145.1: legal actions list every target choice
    const sc = Scenario.start({}, cards);
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const acts = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'ACTIVATE_ABILITY',
    );
    const picked = acts.map((i) => (i.type === 'ACTIVATE_ABILITY' ? i.targets : undefined));
    expect(picked).toContainEqual([{ kind: 'object', id: src }]);
    expect(picked).toContainEqual([{ kind: 'object', id: foe }]);
    for (const i of acts) expect(reduce(sc.state, sc.cards, i).ok).toBe(true);
  });

  it('an ability with no legal target is not offered', () => {
    // Tests Rule 145.1: no candidate when the effect cannot choose
    const only = withGrunt({ abilities: [{ cost: { exhaust: true }, effects: [BUFF_ENEMY] }] });
    const sc = Scenario.start({}, only);
    sc.putUnit('p0', 'fx-grunt', 'base');
    expect(
      getLegalActions(sc.state, sc.cards, 'p0').filter((i) => i.type === 'ACTIVATE_ABILITY'),
    ).toHaveLength(0);
  });
});
