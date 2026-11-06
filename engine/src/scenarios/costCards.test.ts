import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { TOKEN_CARDS } from '../tokens.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { reduce } from '../reducer.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeEvents, sanitizeFor } from '../sanitize.js';
import { stateHash } from '../replay.js';
import { costCardCandidates, costCardText } from '../costCards.js';
import type {
  ActivatedAbility,
  CardDatabase,
  CardDef,
  CardEffect,
  CardTrigger,
  CostCardChoice,
  Intent,
} from '../types/index.js';

type Decide = Extract<Intent, { type: 'DECIDE_OPTIONAL' }>;
type Activate = Extract<Intent, { type: 'ACTIVATE_ABILITY' }>;

const DRAW: CardEffect = { op: 'DRAW', amount: 1 };

/** fx-grunt (Fury, p0's deck) gets the given triggers / abilities. */
const withGrunt = (patch: Partial<CardDef>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), ...patch },
});

const payTrigger = (card: CostCardChoice, extra: CardTrigger['optional'] = {}): CardTrigger => ({
  on: 'PLAY',
  optional: { ...extra, card },
  effects: [DRAW],
});

/** p0 plays fx-grunt (2 Energy) and both players pass: the optional trigger is about to ask. */
function playAndResolve(
  cards: CardDatabase,
  setup: (sc: Scenario) => void = () => undefined,
): { sc: Scenario; unit: string } {
  const sc = Scenario.start({}, cards);
  sc.giveRunes('p0', 4);
  setup(sc);
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  sc.pass('p1');
  sc.pass('p0');
  return { sc, unit };
}

const accepts = (sc: Scenario): Decide[] =>
  getLegalActions(sc.state, sc.cards, 'p0').filter(
    (i): i is Decide => i.type === 'DECIDE_OPTIONAL' && i.accept,
  );

const decideWith = (sc: Scenario, costCards: string[] | undefined, accept = true): Decide => {
  const pc = sc.state.flow.pendingChoice;
  if (pc?.kind !== 'OPTIONAL_EFFECT') throw new Error('no optional effect pending');
  return {
    type: 'DECIDE_OPTIONAL',
    playerId: pc.player,
    chainItemId: pc.chainItemId,
    accept,
    ...(costCards ? { costCards } : {}),
  };
};

describe('scenario: optional ability with a DISCARD cost (R46)', () => {
  const cards = withGrunt({ triggers: [payTrigger({ kind: 'DISCARD' })] });

  it('asks, lists one accept per hand card, and decline stays first', () => {
    // Tests Rule 357.1.a: a cost is paid by choosing what pays it
    const { sc } = playAndResolve(cards);
    expect(sc.state.flow.pendingChoice).toMatchObject({
      kind: 'OPTIONAL_EFFECT',
      cost: { card: { kind: 'DISCARD' } },
    });
    const legal = getLegalActions(sc.state, sc.cards, 'p0');
    expect(legal[0]).toMatchObject({ type: 'DECIDE_OPTIONAL', accept: false });
    expect(legal[0]).not.toHaveProperty('costCards');
    const hand = [...sc.player('p0').hand].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    expect(accepts(sc).map((a) => a.costCards)).toEqual(hand.map((id) => [id]));
    expect(getLegalActions(sc.state, sc.cards, 'p1')).toEqual([]);
    sc.verify();
  });

  it('accept discards the chosen card to the Trash, then runs the effect, atomically', () => {
    // Tests Rule 357.1.a: the cost is paid together with accepting; the effect follows
    const { sc } = playAndResolve(cards);
    const hand = sc.player('p0').hand;
    const pick = hand[1] as string;
    const trash = sc.player('p0').trash.length;
    const r = sc.do(decideWith(sc, [pick]));
    expect(sc.player('p0').hand).not.toContain(pick);
    expect(sc.player('p0').trash).toContain(pick);
    expect(sc.player('p0').trash).toHaveLength(trash + 1);
    expect(sc.obj(pick).zone).toEqual({ kind: 'trash', player: 'p0' });
    // one card out, one card drawn
    expect(sc.player('p0').hand).toHaveLength(hand.length);
    expect(sc.eventsOfType('COST_CARDS_PAID', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', kind: 'DISCARD', cardIds: [pick] }),
    ]);
    expect(sc.eventsOfType('OPTIONAL_EFFECT_DECIDED', r.events)).toEqual([
      expect.objectContaining({ accepted: true }),
    ]);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    sc.verify();
  });

  it('rejects a missing, wrong, duplicate or surplus choice and leaves the state untouched', () => {
    // Tests Rule 357.1.a: an illegal payment is refused before anything is paid
    const { sc, unit } = playAndResolve(cards);
    const hand = sc.player('p0').hand;
    expect(sc.reject(decideWith(sc, undefined)).code).toBe('MISSING_TARGET');
    expect(sc.reject(decideWith(sc, [])).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject(decideWith(sc, [hand[0] as string, hand[1] as string])).code).toBe(
      'ILLEGAL_TARGET',
    );
    expect(sc.reject(decideWith(sc, [unit])).code).toBe('ILLEGAL_TARGET'); // on the board, not in hand
    expect(sc.reject(decideWith(sc, ['o99999'])).code).toBe('ILLEGAL_TARGET');
    const theirs = sc.player('p1').hand[0] as string;
    expect(sc.reject(decideWith(sc, [theirs])).code).toBe('ILLEGAL_TARGET'); // the opponent's hand
    expect(sc.state.flow.pendingChoice?.kind).toBe('OPTIONAL_EFFECT');
    // decline never needs (and ignores nothing) a choice
    sc.do(decideWith(sc, undefined, false));
    expect(sc.player('p0').hand).toHaveLength(hand.length);
    sc.verify();
  });

  it('decline discards nothing and is the first legal action (timeouts and fallbacks decline)', () => {
    // Tests Rule 340.1: the item resolves with no effect when its controller declines
    const { sc } = playAndResolve(cards);
    const hand = [...sc.player('p0').hand];
    const trash = sc.player('p0').trash.length;
    const first = getLegalActions(sc.state, sc.cards, 'p0')[0] as Intent;
    sc.do(first);
    expect(sc.player('p0').hand).toEqual(hand);
    expect(sc.player('p0').trash).toHaveLength(trash);
    expect(sc.events.filter((e) => e.type === 'COST_CARDS_PAID')).toHaveLength(0);
  });

  it('with an empty hand the ability is declined without a prompt', () => {
    // Tests Rule 357.1.a: a cost that cannot be paid cannot be chosen
    const { sc } = playAndResolve(cards, (x) => x.emptyHand('p0'));
    expect(sc.state.flow.pendingChoice).toBeUndefined();
    expect(sc.events.filter((e) => e.type === 'OPTIONAL_EFFECT_DECIDED')).toEqual([
      expect.objectContaining({ accepted: false }),
    ]);
  });

  it('the opponent learns nothing about the hand: only the discarded card, now public in the Trash', () => {
    // Tests Rule 106: hidden information stays hidden; a discarded card is public in the Trash
    const { sc } = playAndResolve(cards);
    const hand = [...sc.player('p0').hand];
    const pick = hand[0] as string;
    const before = JSON.stringify(sanitizeFor(sc.state, 'p1'));
    for (const id of hand) expect(before).not.toContain(`"${id}"`);
    const r = sc.do(decideWith(sc, [pick]));
    const view = sanitizeFor(sc.state, 'p1');
    const after = JSON.stringify(view);
    for (const id of hand.filter((x) => x !== pick)) expect(after).not.toContain(`"${id}"`);
    expect(view.objects[pick]).toMatchObject({ zone: { kind: 'trash' } });
    const seen = sanitizeEvents(r.events, 'p1');
    expect(seen.some((e) => e.type === 'COST_CARDS_PAID')).toBe(true);
    // the drawn card's id is redacted for the opponent as always
    expect(JSON.stringify(seen)).not.toContain(sc.player('p0').hand[hand.length - 1] as string);
  });

  it('survives persistence and replay: a JSON round trip gives the same hash', () => {
    // Tests Rule 340.1: the pending choice lives in the state
    const { sc } = playAndResolve(cards);
    const saved = JSON.parse(JSON.stringify(sc.state)) as typeof sc.state;
    const intent = decideWith(sc, [sc.player('p0').hand[0] as string]);
    const a = reduce(sc.state, sc.cards, intent);
    const b = reduce(saved, sc.cards, intent);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(stateHash(a.state)).toBe(stateHash(b.state));
  });

  it('the bot answers with a legal intent', () => {
    // Tests Rule 340.1: the bot never gets stuck on an optional ability
    const { sc } = playAndResolve(cards);
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const pick = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(pick).not.toBeNull();
    expect((pick as Intent).type).toBe('DECIDE_OPTIONAL');
    expect(sc.tryDo(pick as Intent).ok).toBe(true);
    expect(sc.state.flow.pendingChoice).toBeUndefined();
  });

  it('combines with an Energy cost: both are paid on accept', () => {
    // Tests Rule 357.1.a: Energy through the Rune Pool, the card choice next to it
    const both = withGrunt({
      triggers: [payTrigger({ kind: 'DISCARD' }, { energy: 1 })],
    });
    const { sc } = playAndResolve(both);
    const ready = sc.runes('p0').filter((r) => r.ready).length;
    const a = accepts(sc)[0] as Decide;
    expect(a.payment).toHaveLength(1);
    sc.do(a);
    expect(sc.runes('p0').filter((r) => r.ready).length).toBe(ready - 1);
    expect(sc.player('p0').trash).toContain((a.costCards as string[])[0]);
    // A bad payment plan leaves the chosen card in hand too.
    const again = playAndResolve(both);
    const used = again.sc.runes('p0').find((r) => !r.ready)!;
    const handBefore = [...again.sc.player('p0').hand];
    const bad = again.sc.reject({
      ...decideWith(again.sc, [handBefore[0] as string]),
      payment: [{ runeId: used.id, mode: 'EXHAUST' }],
    });
    expect(bad.code).toBe('INVALID_PAYMENT');
    expect(again.sc.player('p0').hand).toEqual(handBefore);
  });
});

describe('scenario: optional ability with a board cost (kill, exhaust, return) (R46)', () => {
  it('KILL: another friendly unit dies as the cost, the enemy and the source cannot pay', () => {
    // Tests Rule 323: a killed unit goes to the Trash in the Cleanup
    const cards = withGrunt({
      triggers: [payTrigger({ kind: 'KILL', what: 'unit', another: true })],
    });
    const { sc, unit } = playAndResolve(cards, (x) => {
      x.putUnit('p0', 'fx-ash-tank', 'base');
      x.putUnit('p0', 'fx-archer', 'base');
      x.putUnit('p1', 'fx-tide-grunt', 'base');
    });
    const mine = Object.values(sc.state.objects)
      .filter((o) => o.controller === 'p0' && o.zone.kind === 'base' && o.id !== unit)
      .filter((o) => !sc.cards[o.cardId]?.type.startsWith('RUNE') && o.cardId !== 'fx-rune-fury')
      .map((o) => o.id);
    const enemy = Object.values(sc.state.objects).find((o) => o.cardId === 'fx-tide-grunt')!;
    expect(accepts(sc).map((a) => a.costCards?.[0])).toEqual(mine);
    expect(sc.reject(decideWith(sc, [unit])).code).toBe('ILLEGAL_TARGET'); // "another"
    expect(sc.reject(decideWith(sc, [enemy.id])).code).toBe('ILLEGAL_TARGET'); // friendly only
    const victim = mine[0] as string;
    const hand = sc.player('p0').hand.length;
    const r = sc.do(decideWith(sc, [victim]));
    expect(sc.obj(victim).zone.kind).toBe('trash');
    expect(sc.player('p0').trash).toContain(victim);
    expect(sc.player('p0').hand).toHaveLength(hand + 1); // the effect ran
    expect(sc.eventsOfType('COST_CARDS_PAID', r.events)[0]).toMatchObject({ kind: 'KILL' });
    sc.verify();
  });

  it('EXHAUST: only ready units qualify and the chosen one becomes exhausted', () => {
    // Tests Rule 140: exhausting a unit as a cost needs it ready
    const cards = withGrunt({ triggers: [payTrigger({ kind: 'EXHAUST', another: true })] });
    let tired = '';
    let fresh = '';
    const { sc } = playAndResolve(cards, (x) => {
      tired = x.putUnit('p0', 'fx-ash-tank', 'base', { ready: false });
      fresh = x.putUnit('p0', 'fx-archer', 'base');
    });
    expect(accepts(sc).map((a) => a.costCards)).toEqual([[fresh]]);
    expect(sc.reject(decideWith(sc, [tired])).code).toBe('ILLEGAL_TARGET');
    sc.do(decideWith(sc, [fresh]));
    expect(sc.obj(fresh).ready).toBe(false);
    sc.verify();
  });

  it('RETURN: a friendly unit goes back to its owner hand, a token ceases to exist', () => {
    // Tests Rule 186.1: a token that would leave the board ceases to exist
    const cards = withGrunt({
      triggers: [payTrigger({ kind: 'RETURN', what: 'unit', another: true })],
    });
    const { sc } = playAndResolve(cards, (x) => {
      x.putUnit('p0', 'fx-ash-tank', 'base');
    });
    const tank = Object.values(sc.state.objects).find(
      (o) => o.cardId === 'fx-ash-tank' && o.zone.kind === 'base',
    )!;
    const hand = sc.player('p0').hand.length;
    sc.do(decideWith(sc, [tank.id]));
    expect(sc.obj(tank.id).zone).toEqual({ kind: 'hand', player: 'p0' });
    expect(sc.player('p0').hand).toContain(tank.id);
    expect(sc.player('p0').hand).toHaveLength(hand + 2); // returned card + the drawn one
    sc.verify();
  });

  it('"here" limits the choice to the source battlefield; no candidate means no prompt', () => {
    // Tests Rule 355.10: "here" is the battlefield of the source
    const cards = withGrunt({
      triggers: [payTrigger({ kind: 'KILL', what: 'unit', here: true, another: true })],
    });
    const sc = Scenario.start({}, cards);
    const src = sc.putUnit('p0', 'fx-grunt', 'bf1', { control: true });
    const near = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const far = sc.putUnit('p0', 'fx-archer', 'base');
    const cc: CostCardChoice = { kind: 'KILL', what: 'unit', here: true, another: true };
    expect(costCardCandidates(sc.state, sc.cards, 'p0', src, cc)).toEqual([near]);
    expect(costCardCandidates(sc.state, sc.cards, 'p0', far, cc)).toEqual([]); // the base is not a battlefield
    // a gear never matches a unit cost; unitOrGear takes both kinds
    expect(costCardCandidates(sc.state, sc.cards, 'p0', src, { ...cc, what: 'gear' })).toEqual([]);
    expect(
      costCardCandidates(sc.state, sc.cards, 'p0', src, { ...cc, what: 'unitOrGear' }),
    ).toEqual([near]);
  });
});

describe('scenario: activated abilities with a card cost (R46)', () => {
  const ability = (card: CostCardChoice): ActivatedAbility[] => [
    { cost: { exhaust: true, card }, effects: [{ op: 'BUFF_SELF', amount: 2 }] },
  ];

  it('DISCARD a gear: one activation per gear in hand, validated, paid, then on the Chain', () => {
    // Tests Rule 145.1: costs are paid as the ability is activated
    const cards = withGrunt({ abilities: ability({ kind: 'DISCARD', what: 'gear' }) });
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    const gearA = sc.putInHand('p0', 'fx-blade');
    sc.setMainPhase('p0');
    const acts = (): Activate[] =>
      getLegalActions(sc.state, sc.cards, 'p0').filter(
        (i): i is Activate => i.type === 'ACTIVATE_ABILITY',
      );
    expect(acts().map((a) => a.costCards)).toEqual([[gearA]]);
    const base: Activate = {
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId: unit,
      abilityIndex: 0,
      payment: [],
    };
    expect(sc.reject(base).code).toBe('MISSING_TARGET');
    const spell = sc.player('p0').hand.find((id) => sc.obj(id).cardId !== 'fx-blade') as string;
    expect(sc.reject({ ...base, costCards: [spell] }).code).toBe('ILLEGAL_TARGET'); // not a gear
    expect(sc.obj(unit).ready).toBe(true);
    sc.do({ ...base, costCards: [gearA] });
    expect(sc.obj(unit).ready).toBe(false);
    expect(sc.player('p0').trash).toContain(gearA);
    expect(sc.state.flow.chain).toHaveLength(1);
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(sc.obj(unit).mightBonus).toBe(2);
    sc.verify();
  });

  it('is not offered without a card to pay, and rejects stray costCards on a plain ability', () => {
    // Tests Rule 145.1: an ability whose cost cannot be paid cannot be activated
    const cards = withGrunt({ abilities: ability({ kind: 'DISCARD', what: 'gear' }) });
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setMainPhase('p0');
    expect(
      getLegalActions(sc.state, sc.cards, 'p0').filter((i) => i.type === 'ACTIVATE_ABILITY'),
    ).toEqual([]);
    const plain = withGrunt({
      abilities: [{ cost: { exhaust: true }, effects: [{ op: 'BUFF_SELF', amount: 1 }] }],
    });
    const p = Scenario.start({}, plain);
    const u = p.putUnit('p0', 'fx-grunt', 'base');
    p.setMainPhase('p0');
    const spare = p.player('p0').hand[0] as string;
    expect(
      p.reject({
        type: 'ACTIVATE_ABILITY',
        playerId: 'p0',
        sourceId: u,
        abilityIndex: 0,
        payment: [],
        costCards: [spare],
      }).code,
    ).toBe('ILLEGAL_TARGET');
    expect(unit).toBeDefined();
  });

  it('RECYCLE from the Trash puts the cards at the bottom of the Main Deck', () => {
    // Tests Rule 145.1: "Recycle N from your trash" is a cost
    const cards = withGrunt({
      abilities: [
        {
          cost: { card: { kind: 'RECYCLE', count: 2 } },
          effects: [{ op: 'BUFF_SELF', amount: 1 }],
        },
      ],
    });
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setDeckSize('p0', 30, 'trash'); // fills the Trash
    sc.setMainPhase('p0');
    const trash = sc.player('p0').trash.length;
    const acts = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'ACTIVATE_ABILITY',
    ) as Activate[];
    expect(acts.length).toBeGreaterThan(1);
    expect(acts.length).toBeLessThanOrEqual(48); // capped like MAX_TARGET_COMBOS
    const pick = acts[0]!.costCards as string[];
    expect(pick).toHaveLength(2);
    const deck = sc.player('p0').mainDeck.length;
    sc.do(acts[0]!);
    expect(sc.player('p0').trash).toHaveLength(trash - 2);
    expect(sc.player('p0').mainDeck).toHaveLength(deck + 2);
    expect(sc.player('p0').mainDeck.slice(-2)).toEqual(pick);
    expect(sc.obj(pick[0] as string).zone.kind).toBe('mainDeck');
    expect(sc.obj(unit)).toBeDefined();
    sc.verify();
  });

  it('[C] in an ability cost is paid with Power of the source Domain', () => {
    // Tests Rule 357.1.a: [C] is Power of the Domain of the card
    const cards = withGrunt({
      abilities: [
        {
          cost: { exhaust: true, power: 1, card: { kind: 'DISCARD' } },
          effects: [{ op: 'BUFF_SELF', amount: 1 }],
        },
      ],
    });
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setMainPhase('p0');
    const acts = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'ACTIVATE_ABILITY',
    ) as Activate[];
    expect(acts[0]?.payment[0]?.mode).toBe('RECYCLE');
    sc.do(acts[0] as Activate);
    sc.verify();
    const none = Scenario.start({}, cards);
    none.setRunes('p0', []);
    none.putUnit('p0', 'fx-grunt', 'base');
    none.setMainPhase('p0');
    expect(
      getLegalActions(none.state, none.cards, 'p0').filter((i) => i.type === 'ACTIVATE_ABILITY'),
    ).toEqual([]);
  });
});

describe('scenario: "kill a unit or gear" (R46)', () => {
  it('a KILL_TARGET with orGear may choose either kind and kills a gear to the Trash', () => {
    // Tests Rule 355.10: the legal targets of the effect decide what can be chosen
    const spell: CardDef = {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      effects: [{ op: 'KILL_TARGET', orGear: true }],
      supportLevel: 'full',
    };
    const cards: CardDatabase = { ...SCENARIO_CARDS, 'fx-flare': spell };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const unit = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const gear = sc.putUnit('p1', 'fx-tide-totem', 'base');
    const card = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const plays = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === card,
    ) as Extract<Intent, { type: 'PLAY_CARD' }>[];
    const ids = plays.map((p) => (p.targets?.[0] as { id: string }).id);
    expect(ids).toContain(unit);
    expect(ids).toContain(gear);
    const play = plays.find((p) => (p.targets?.[0] as { id: string }).id === gear)!;
    sc.do(play);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(gear).zone).toEqual({ kind: 'trash', player: 'p1' });
    sc.verify();
  });
});

describe('costCardText', () => {
  it('words each shape for the UI', () => {
    // Tests Rule 357.1.a: players see what the cost is before they pay it
    expect(costCardText({ kind: 'DISCARD' })).toBe('Discard 1 card');
    expect(costCardText({ kind: 'DISCARD', what: 'gear' })).toBe('Discard 1 gear');
    expect(costCardText({ kind: 'DISCARD', count: 2 })).toBe('Discard 2 cards');
    expect(costCardText({ kind: 'KILL', what: 'unit', another: true })).toBe(
      'Kill another friendly unit',
    );
    expect(costCardText({ kind: 'KILL', what: 'unitOrGear', count: 3, another: true })).toBe(
      'Kill 3 other friendly units or gear',
    );
    expect(costCardText({ kind: 'EXHAUST' })).toBe('Exhaust a friendly unit');
    expect(costCardText({ kind: 'RETURN', what: 'unit', here: true })).toBe(
      'Return a friendly unit here to hand',
    );
    expect(costCardText({ kind: 'RECYCLE', what: 'unit' })).toBe('Recycle 1 unit from your Trash');
  });
});

describe('scenario: Battlefield card with Energy + a returned unit (Emperor Dais shape) (R46)', () => {
  it('the unit you control here goes back to hand and the token appears at the battlefield', () => {
    // Tests Rule 473.2: a Conquer trigger of a Battlefield card; the cost mixes Energy and a card choice
    const cards: CardDatabase = { ...SCENARIO_CARDS };
    for (const id of ['fx-bf-1', 'fx-bf-2', 'fx-bf-3', 'fx-bf-4', 'fx-bf-5', 'fx-bf-6']) {
      cards[id] = {
        ...(SCENARIO_CARDS[id] as CardDef),
        supportLevel: 'full',
        triggers: [
          {
            on: 'CONQUER',
            optional: { energy: 1, card: { kind: 'RETURN', what: 'unit', here: true } },
            effects: [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 1, here: true }],
          },
        ],
      };
    }
    const sc = Scenario.start({}, { ...cards, ...TOKEN_CARDS });
    sc.giveRunes('p0', 3);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    const elsewhere = sc.putUnit('p0', 'fx-archer', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1'); // conquer
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.flow.pendingChoice).toMatchObject({ kind: 'OPTIONAL_EFFECT', player: 'p0' });
    // only the unit at that battlefield can pay; the unit in the base cannot
    expect(accepts(sc).map((a) => a.costCards)).toEqual([[unit]]);
    expect(sc.reject(decideWith(sc, [elsewhere])).code).toBe('ILLEGAL_TARGET');
    const ready = sc.runes('p0').filter((r) => r.ready).length;
    sc.do(accepts(sc)[0] as Decide);
    expect(sc.runes('p0').filter((r) => r.ready).length).toBe(ready - 1);
    expect(sc.obj(unit).zone.kind).toBe('hand');
    expect(sc.unitsAt('bf1', 'p0').map((o) => o.cardId)).toEqual(['tok-recruit']);
    sc.verify();
  });
});

describe('wire shape of costCards (R46)', () => {
  it('a malformed costCards is an unknown intent, not a crash', () => {
    // Tests Rule 340.1: the reducer validates the shape of every intent
    const { sc } = playAndResolve(withGrunt({ triggers: [payTrigger({ kind: 'DISCARD' })] }));
    const bad = decideWith(sc, undefined) as unknown as Record<string, unknown>;
    expect(sc.reject({ ...bad, costCards: 'o1' } as unknown as Intent).code).toBe('UNKNOWN_INTENT');
    expect(sc.reject({ ...bad, costCards: [1, 2] } as unknown as Intent).code).toBe(
      'UNKNOWN_INTENT',
    );
  });
});
