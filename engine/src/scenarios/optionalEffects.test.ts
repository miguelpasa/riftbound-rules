import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { actorToAct } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeFor } from '../sanitize.js';
import { reduce } from '../reducer.js';
import { stateHash } from '../replay.js';
import type { CardDatabase, CardDef, CardTrigger, Intent } from '../types/index.js';

/** fx-grunt (Fury, p0's deck) gets the given triggers. */
const withTriggers = (triggers: CardTrigger[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers },
});

const DRAW_FOR_ONE: CardTrigger = {
  on: 'PLAY',
  optional: { energy: 1 },
  effects: [{ op: 'DRAW', amount: 1 }],
};

/** p0 has `runes` ready runes, plays fx-grunt (2 Energy) and both players pass: the item resolves. */
function playAndResolve(
  cards: CardDatabase,
  runes = 4,
  after: (sc: Scenario) => void = () => undefined,
): { sc: Scenario; unit: string } {
  const sc = Scenario.start({}, cards);
  sc.giveRunes('p0', runes);
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  after(sc);
  sc.pass('p1');
  sc.pass('p0');
  return { sc, unit };
}

const decide = (sc: Scenario, accept: boolean, extra: Partial<Intent> = {}): Intent => {
  const pc = sc.state.flow.pendingChoice;
  if (pc?.kind !== 'OPTIONAL_EFFECT') throw new Error('no optional effect pending');
  return {
    type: 'DECIDE_OPTIONAL',
    playerId: pc.player,
    chainItemId: pc.chainItemId,
    accept,
    ...extra,
  } as Intent;
};

const readyRunes = (sc: Scenario): number => sc.runes('p0').filter((r) => r.ready).length;

describe('scenario: optional "you may pay ..." triggered abilities (R45)', () => {
  it('asks the controller when the ability resolves and blocks everything else', () => {
    // Tests Rule 340.1: the newest item resolves; an optional one waits for its controller's answer
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    expect(sc.state.flow.pendingChoice).toMatchObject({
      kind: 'OPTIONAL_EFFECT',
      player: 'p0',
      cost: { energy: 1 },
    });
    // The item has not resolved: it is still the newest item on the Chain.
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ kind: 'ABILITY', triggered: true });
    expect(actorToAct(sc.state)).toBe('p0');
    sc.reject({ type: 'PASS_PRIORITY', playerId: 'p0' });
    sc.reject({ type: 'PASS_PRIORITY', playerId: 'p1' });
    sc.reject({ type: 'END_TURN', playerId: 'p0' });
    sc.reject(decide(sc, true, { playerId: 'p1' })); // not their choice
    sc.reject({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId: 'nope', accept: true });
    expect(getLegalActions(sc.state, sc.cards, 'p1')).toEqual([]);
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    // Decline is listed first: a "take legal[0]" fallback declines instead of paying.
    expect(legal.map((i) => (i.type === 'DECIDE_OPTIONAL' ? i.accept : null))).toEqual([
      false,
      true,
    ]);
    const accept = legal[1] as Extract<Intent, { type: 'DECIDE_OPTIONAL' }>;
    expect(accept.payment).toHaveLength(1); // the automatic plan is spelled out
    sc.verify();
  });

  it('accepting pays the cost through the rune machinery, then runs the effects', () => {
    // Tests Rule 357.1.a: costs are paid by exhausting runes into the Rune Pool; the effect follows
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const hand = sc.player('p0').hand.length;
    const ready = readyRunes(sc);
    const r = sc.do(decide(sc, true));
    expect(readyRunes(sc)).toBe(ready - 1);
    expect(sc.player('p0').hand).toHaveLength(hand + 1);
    expect(sc.eventsOfType('OPTIONAL_EFFECT_DECIDED', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', accepted: true }),
    ]);
    expect(sc.eventsOfType('CHAIN_ITEM_RESOLVED', r.events)).toHaveLength(1);
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.priority).toBe('p0'); // Neutral Open: the turn player again (340.2)
    sc.verify();
  });

  it('declining pays nothing and does nothing', () => {
    // Tests Rule 340.1: the item resolves with no effect when its controller declines
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const hand = sc.player('p0').hand.length;
    const ready = readyRunes(sc);
    const r = sc.do(decide(sc, false));
    expect(readyRunes(sc)).toBe(ready);
    expect(sc.player('p0').hand).toHaveLength(hand);
    expect(sc.eventsOfType('OPTIONAL_EFFECT_DECIDED', r.events)).toEqual([
      expect.objectContaining({ accepted: false }),
    ]);
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    sc.verify();
  });

  it('is declined automatically (no prompt) when the cost cannot be paid', () => {
    // Tests Rule 357.1.a: a cost that cannot be paid cannot be chosen
    const trigger: CardTrigger = { ...DRAW_FOR_ONE, optional: { energy: 1 } };
    const { sc } = playAndResolve(withTriggers([trigger]), 2, (x) => {
      for (const r of x.runes('p0')) x.setReady(r.id, false); // nothing left to pay with
    });
    expect(readyRunes(sc)).toBe(0);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.events.filter((e) => e.type === 'OPTIONAL_EFFECT_DECIDED')).toEqual([
      expect.objectContaining({ accepted: false }),
    ]);
    sc.verify();
  });

  it('rejects an accept with an invalid payment and leaves the choice pending', () => {
    // Tests Rule 357.1.a: INSUFFICIENT_RESOURCES / INVALID_PAYMENT leave the state untouched
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const used = sc.runes('p0').find((r) => !r.ready);
    expect(used).toBeDefined();
    const bad = sc.reject(
      decide(sc, true, { payment: [{ runeId: used!.id, mode: 'EXHAUST' }] } as Partial<Intent>),
    );
    expect(bad.code).toBe('INVALID_PAYMENT');
    expect(sc.state.flow.pendingChoice?.kind).toBe('OPTIONAL_EFFECT');
    sc.do(decide(sc, true));
  });

  it('the player may choose which rune pays', () => {
    // Tests Rule 357.1.a: the payment plan names the runes that are exhausted
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const ready = sc.runes('p0').filter((r) => r.ready);
    const pick = ready[ready.length - 1]!;
    sc.do(decide(sc, true, { payment: [{ runeId: pick.id, mode: 'EXHAUST' }] } as Partial<Intent>));
    expect(sc.obj(pick.id).ready).toBe(false);
    expect(readyRunes(sc)).toBe(ready.length - 1);
  });

  it('uses Energy already in the Rune Pool', () => {
    // Tests Rule 357.1.a: the Rune Pool pays before any rune is exhausted
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]), 2, (x) => {
      for (const r of x.runes('p0')) x.setReady(r.id, false);
      x.setPool('p0', 1);
    });
    const accept = getLegalActions(sc.state, sc.cards, 'p0').find(
      (i) => i.type === 'DECIDE_OPTIONAL' && i.accept,
    ) as Extract<Intent, { type: 'DECIDE_OPTIONAL' }>;
    expect(accept.payment).toBeUndefined(); // nothing to exhaust
    const hand = sc.player('p0').hand.length;
    sc.do(accept);
    expect(sc.player('p0').hand).toHaveLength(hand + 1);
    expect(sc.player('p0').runePool.energy).toBe(0);
  });

  it('[C] is Power of the source card Domain: a recycled Fury rune pays, no rune means it cannot be paid', () => {
    // Tests Rule 357.1.a: Power is paid by recycling runes of the right Domain
    const trigger: CardTrigger = {
      on: 'PLAY',
      optional: { power: 1 },
      effects: [{ op: 'DRAW', amount: 1 }],
    };
    const { sc } = playAndResolve(withTriggers([trigger]), 4);
    expect(sc.state.flow.pendingChoice).toMatchObject({ cost: { power: 1 } });
    const accept = getLegalActions(sc.state, sc.cards, 'p0').find(
      (i) => i.type === 'DECIDE_OPTIONAL' && i.accept,
    ) as Extract<Intent, { type: 'DECIDE_OPTIONAL' }>;
    expect(accept.payment?.[0]?.mode).toBe('RECYCLE');
    const hand = sc.player('p0').hand.length;
    sc.do(accept);
    expect(sc.player('p0').hand).toHaveLength(hand + 1);
    // No Fury rune at all: not payable, so declined automatically.
    const none = playAndResolve(withTriggers([trigger]), 4, (x) => x.setRunes('p0', []));
    expect(none.sc.state.flow.pendingChoice).toBeUndefined();
  });

  it('[Burn N] cost: the top cards go to the Trash on accept, and an empty deck cannot pay', () => {
    // Tests Rule 357.1.a: a Burn cost puts the top cards of the Main Deck into the Trash
    const trigger: CardTrigger = {
      on: 'PLAY',
      optional: { burn: 2 },
      effects: [{ op: 'BUFF_SELF', amount: 1 }],
    };
    const { sc, unit } = playAndResolve(withTriggers([trigger]));
    const deck = sc.player('p0').mainDeck.length;
    const trash = sc.player('p0').trash.length;
    const r = sc.do(decide(sc, true));
    expect(sc.player('p0').mainDeck).toHaveLength(deck - 2);
    expect(sc.player('p0').trash).toHaveLength(trash + 2);
    expect(sc.eventsOfType('CARDS_BURNED', r.events)).toEqual([
      expect.objectContaining({ count: 2 }),
    ]);
    expect(sc.obj(unit).mightBonus).toBe(1);
    sc.verify();
    const empty = Scenario.start({}, withTriggers([trigger]));
    empty.giveRunes('p0', 4);
    const u = empty.putInHand('p0', 'fx-grunt');
    empty.setDeckSize('p0', 1);
    empty.play('p0', u, { payment: empty.exhaustPlan('p0', 2), location: { kind: 'base' } });
    empty.pass('p1');
    empty.pass('p0');
    expect(empty.state.flow.pendingChoice).toBeUndefined(); // 1 card < Burn 2
  });

  it('a free "you may" asks too, and a targeted optional effect chooses its target first', () => {
    // Tests Rule 355.10: targets are chosen when the ability is put on the Chain; the "may" at resolution
    const trigger: CardTrigger = {
      on: 'PLAY',
      optional: { energy: 1 },
      effects: [{ op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly' }],
    };
    const sc = Scenario.start({}, withTriggers([trigger]));
    sc.giveRunes('p0', 4);
    const other = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.flow.pendingChoice?.kind).toBe('TRIGGER_TARGET');
    const pc = sc.state.flow.pendingChoice as { chainItemId: string };
    sc.do({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p0',
      chainItemId: pc.chainItemId,
      targets: [{ kind: 'object', id: other }],
    });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.flow.pendingChoice?.kind).toBe('OPTIONAL_EFFECT');
    expect(sc.obj(other).mightBonus).toBe(0); // nothing happened yet
    sc.do(decide(sc, true));
    expect(sc.obj(other).mightBonus).toBe(2);
    sc.verify();

    const free: CardTrigger = { on: 'PLAY', optional: {}, effects: [{ op: 'DRAW', amount: 1 }] };
    const f = playAndResolve(withTriggers([free]));
    const accept = getLegalActions(f.sc.state, f.sc.cards, 'p0')[1] as Extract<
      Intent,
      { type: 'DECIDE_OPTIONAL' }
    >;
    expect(accept).toMatchObject({ accept: true });
    expect(accept.payment).toBeUndefined();
  });

  it('works for a Battlefield card trigger ("you may pay ... to score 1 point")', () => {
    // Tests Rule 473.2: Conquer triggers; the optional cost is paid when the controller accepts
    const cards: CardDatabase = { ...SCENARIO_CARDS };
    for (const id of ['fx-bf-1', 'fx-bf-2', 'fx-bf-3', 'fx-bf-4', 'fx-bf-5', 'fx-bf-6']) {
      cards[id] = {
        ...(SCENARIO_CARDS[id] as CardDef),
        supportLevel: 'full',
        triggers: [
          { on: 'CONQUER', optional: { anyPower: 1 }, effects: [{ op: 'GAIN_POINT', amount: 1 }] },
        ],
      };
    }
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 3);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1'); // conquer: 1 point, then the trigger goes on the Chain
    const before = sc.player('p0').points;
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.flow.pendingChoice).toMatchObject({ kind: 'OPTIONAL_EFFECT', player: 'p0' });
    expect(sc.state.flow.chain[0]).toMatchObject({ sourceBattlefieldId: 'bf1' });
    sc.do(decide(sc, true));
    expect(sc.player('p0').points).toBe(before + 1);
    sc.verify();
  });

  it('inside a combat Showdown the game carries on after the answer', () => {
    // Tests Rule 466.2.c: an attack trigger resolves in the Showdown; Focus then moves on as usual
    const trigger: CardTrigger = {
      on: 'ATTACK',
      optional: { energy: 1 },
      effects: [{ op: 'BUFF_SELF', amount: 2 }],
    };
    const sc = Scenario.start({}, withTriggers([trigger]));
    sc.giveRunes('p0', 3);
    sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const att = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [att],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    expect(sc.state.flow.chain).toHaveLength(1);
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(sc.state.flow.pendingChoice).toMatchObject({ kind: 'OPTIONAL_EFFECT', player: 'p0' });
    const before = sc.state.flow.showdown?.battlefieldId ?? sc.state.flow.combat?.battlefieldId;
    expect(before).toBe('bf1');
    sc.do(decide(sc, true));
    expect(sc.obj(att).mightBonus).toBe(2);
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.state.flow.priority).not.toBeNull(); // somebody can act: the Showdown continues
    expect(getLegalActions(sc.state, sc.cards, sc.state.flow.priority!).length).toBeGreaterThan(0);
    sc.verify();
  });

  it('either player may concede while the choice is pending', () => {
    // Tests Rule 649: conceding is always possible
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    sc.do({ type: 'CONCEDE', playerId: 'p1' });
    expect(sc.state.gameStatus).toBe('FINISHED');
    expect(sc.state.winner).toBe('p0');
  });

  it('the opponent sees the pending choice and its cost but nothing hidden', () => {
    // Tests Rule 106: hidden information stays hidden; the choice itself is public
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const view = sanitizeFor(sc.state, 'p1');
    expect(view.flow.pendingChoice).toEqual(sc.state.flow.pendingChoice);
    expect(JSON.stringify(sanitizeFor(sc.state, 'p1'))).not.toContain(
      sc.player('p0').hand[0] ?? 'no-hand-card',
    );
  });

  it('the bot answers a pending optional ability with a legal intent', () => {
    // Tests Rule 340.1: the bot never gets stuck on an optional ability
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const pick = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(pick).not.toBeNull();
    expect((pick as Intent).type).toBe('DECIDE_OPTIONAL');
    expect(sc.tryDo(pick as Intent).ok).toBe(true);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
  });

  it('survives persistence: a JSON round trip of the pending state answers identically', () => {
    // Tests Rule 340.1: the pending choice lives in the state, so a saved game resumes it
    const { sc } = playAndResolve(withTriggers([DRAW_FOR_ONE]));
    const saved = JSON.parse(JSON.stringify(sc.state)) as typeof sc.state;
    expect(saved.flow.pendingChoice?.kind).toBe('OPTIONAL_EFFECT');
    const intent = decide(sc, true);
    const a = reduce(sc.state, sc.cards, intent);
    const b = reduce(saved, sc.cards, intent);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(stateHash(a.state)).toBe(stateHash(b.state));
  });
});
