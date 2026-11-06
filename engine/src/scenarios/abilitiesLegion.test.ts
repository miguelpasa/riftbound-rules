/** R38: activated abilities (Gold, Seals, chain abilities), Legion effects, "I enter ready". */
import { describe, expect, it } from 'vitest';
import { parseCardAbilities, parseSpellText } from '../cardText.js';
import { getAbilityActivations, getLegalActions } from '../legalActions.js';
import { runEffects } from '../effects.js';
import { TOKEN_CARDS } from '../tokens.js';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import type {
  CardDatabase,
  CardDef,
  CardEffect,
  CardInstance,
  Intent,
  PaymentPlan,
  PlayerId,
  Target,
} from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
const obj = (id: string): Target => ({ kind: 'object', id });

/** A gear-like card: fx-grunt turned into Gear with the given abilities. */
const gearDb = (abilities: NonNullable<CardDef['abilities']>): CardDatabase => ({
  ...SCENARIO_CARDS,
  ...TOKEN_CARDS,
  'fx-grunt': {
    ...base('fx-grunt'),
    type: 'GEAR',
    stats: {},
    abilities,
  },
});

/** Give `player` a Gold token the way a card effect would (exhausted unless `ready`). */
function giveGold(sc: Scenario, player: PlayerId, ready: boolean): string {
  const s = structuredClone(sc.state);
  const before = new Set(Object.keys(s.objects));
  runEffects(s, player, [{ op: 'PLAY_TOKEN', token: 'tok-gold', count: 1, ready }], sc.cards);
  sc.state = s;
  return Object.keys(s.objects).find((id) => !before.has(id)) as string;
}

/** Hand an object to `player` (control only; the ability tests need a p1 permanent). */
function giveControl(sc: Scenario, id: string, player: PlayerId): void {
  const s = structuredClone(sc.state);
  const o = s.objects[id] as CardInstance;
  const from = s.players[o.controller === 'p0' ? 0 : 1];
  from.base = from.base.filter((x) => x !== id);
  s.players[player === 'p0' ? 0 : 1].base.push(id);
  o.controller = player;
  o.zone = { kind: 'base', player };
  o.ready = true;
  sc.state = s;
}

const activate = (
  player: PlayerId,
  sourceId: string,
  payment: PaymentPlan = [],
  abilityIndex = 0,
): Intent => ({ type: 'ACTIVATE_ABILITY', playerId: player, sourceId, abilityIndex, payment });

describe('scenario: Gold token and [Add] abilities', () => {
  const cards: CardDatabase = { ...SCENARIO_CARDS, ...TOKEN_CARDS };

  it('a Gold token enters exhausted and cannot be used until it readies', () => {
    // Tests Rule 135.2.e.2: [E] is the cost of exhausting a permanent, which needs it ready
    const sc = Scenario.start({}, cards);
    const gold = giveGold(sc, 'p0', false);
    expect(sc.obj(gold).ready).toBe(false);
    expect(sc.reject(activate('p0', gold)).code).toBe('UNIT_EXHAUSTED');
    sc.verify();
  });

  it('Kill this + [E]: Add [A] puts Universal Power in the pool, without using the Chain', () => {
    // Tests Rule 168: an ability that Adds puts Energy or Power in the Rune Pool
    const sc = Scenario.start({}, cards);
    const gold = giveGold(sc, 'p0', true);
    const r = sc.do(activate('p0', gold));
    expect(sc.player('p0').runePool.universal).toBe(1);
    expect(sc.state.flow.chain).toHaveLength(0);
    expect(sc.state.objects[gold]).toBeUndefined(); // a token ceases to exist (186.1)
    expect(sc.player('p0').base).not.toContain(gold);
    expect(r.events.map((e) => e.type)).toEqual([
      'ABILITY_ACTIVATED',
      'GEAR_KILLED',
      'RESOURCES_ADDED',
    ]);
    sc.verify();
  });

  it('the added Power pays a Power cost', () => {
    // Tests Rule 166.1: Power added by a card goes to the Rune Pool and can pay a cost
    const sc = Scenario.start({}, cards);
    const gold = giveGold(sc, 'p0', true);
    sc.setPool('p0', 5);
    const titan = sc.putInHand('p0', 'fx-titan'); // 5 Energy + 1 Calm Power
    sc.reject({
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: titan,
      payment: [],
      location: { kind: 'base' },
    });
    sc.do(activate('p0', gold));
    sc.play('p0', titan, { payment: [], location: { kind: 'base' } });
    expect(sc.obj(titan).zone.kind).toBe('base');
    expect(sc.player('p0').runePool.universal).toBeUndefined();
    sc.verify();
  });

  it("cannot use the opponent's Gold", () => {
    // Tests Rule 145.1: you activate abilities of permanents you control
    const sc = Scenario.start({}, cards);
    const gold = giveGold(sc, 'p0', true);
    expect(sc.reject(activate('p1', gold)).code).toBe('NOT_OWNED');
  });

  it('an object without that ability gives ABILITY_NOT_AVAILABLE', () => {
    // Tests Rule 145.1: only written abilities can be activated
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(sc.reject(activate('p0', unit)).code).toBe('ABILITY_NOT_AVAILABLE');
    expect(sc.reject(activate('p0', 'o99999')).code).toBe('ABILITY_NOT_AVAILABLE');
  });

  it('is offered as an ability activation (like a rune), not as a legal action', () => {
    // Tests Rule 168: [Add] abilities do not use the Chain, so they are rune-like hints
    const sc = Scenario.start({}, cards);
    const gold = giveGold(sc, 'p0', true);
    expect(getAbilityActivations(sc.state, cards, 'p0')).toEqual([activate('p0', gold)]);
    expect(getLegalActions(sc.state, cards, 'p0').some((a) => a.type === 'ACTIVATE_ABILITY')).toBe(
      false,
    );
  });

  it('a Seal ([E]: Add [C]) adds Power of its Domain and stays on the board exhausted', () => {
    // Tests Rule 168: [Add] [C] adds Power of the card's Domain
    const seal = parseAbilities('[E]: [Reaction] — [Add] [C].');
    const sc = Scenario.start({}, gearDb(seal));
    const g = sc.putUnit('p0', 'fx-grunt', 'base'); // Fury
    sc.do(activate('p0', g));
    expect(sc.player('p0').runePool.power).toEqual({ Fury: 1 });
    expect(sc.obj(g).ready).toBe(false);
    expect(sc.reject(activate('p0', g)).code).toBe('UNIT_EXHAUSTED');
    sc.verify();
  });

  it('[Add] [N] adds Energy', () => {
    // Tests Rule 168: [Add] [N] adds N Energy to the Rune Pool
    const sc = Scenario.start({}, gearDb(parseAbilities('[E]: [Reaction] — [Add] [2].')));
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setPool('p0', 0);
    sc.do(activate('p0', g));
    expect(sc.player('p0').runePool.energy).toBe(2);
  });
});

function parseAbilities(text: string): NonNullable<CardDef['abilities']> {
  const r = parseCardAbilities(text, { gearLike: true });
  if (!r) throw new Error(`unparsed: ${text}`);
  return r.abilities;
}

describe('scenario: activated abilities that use the Chain', () => {
  const draw: CardEffect[] = [{ op: 'DRAW', amount: 1 }];
  const cards = gearDb([{ cost: { exhaust: true, energy: 1 }, effects: draw }]);

  it('pays its cost, goes on the Chain and resolves after both players pass', () => {
    // Tests Rule 151.1: an activated ability is a cost, a colon, then an effect that resolves from the Chain
    const sc = Scenario.start({}, cards);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    const hand = sc.player('p0').hand.length;
    const r = sc.do(activate('p0', g, sc.exhaustPlan('p0', 1)));
    expect(sc.obj(g).ready).toBe(false);
    expect(sc.state.flow.chain).toHaveLength(1);
    expect(sc.state.flow.chain[0]).toMatchObject({ kind: 'ABILITY', activatedIndex: 0 });
    expect(r.events.map((e) => e.type)).toContain('CHAIN_ITEM_ADDED');
    expect(sc.player('p0').hand.length).toBe(hand);
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.player('p0').hand.length).toBe(hand + 1);
    sc.verify();
  });

  it('is rejected without the Energy cost, and while the chain is Closed (not a Reaction)', () => {
    // Tests Rule 309.1.a: in a Closed state only Reaction-speed plays are allowed
    const sc = Scenario.start({}, cards);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(sc.reject(activate('p0', g)).code).toBe('INSUFFICIENT_RESOURCES');
    const g2 = sc.putUnit('p0', 'fx-grunt', 'base');
    giveControl(sc, g2, 'p1');
    sc.do(activate('p0', g, sc.exhaustPlan('p0', 1)));
    // p1 now holds Priority in a Closed state: a non-Reaction ability is refused.
    sc.setPool('p1', 1);
    expect(sc.reject(activate('p1', g2)).code).toBe('CLOSED_STATE_REACTION_ONLY');
  });

  it('a Reaction ability can be used while the chain is Closed', () => {
    // Tests Rule 309.1.a: Reaction speed is allowed in a Closed state
    const react = gearDb([{ cost: { exhaust: true }, reaction: true, effects: draw }]);
    const sc = Scenario.start({}, react);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    // p1 holds Priority with p0's spell on the chain
    giveControl(sc, g, 'p1');
    sc.do(activate('p1', g));
    expect(sc.state.flow.chain).toHaveLength(2);
  });

  it('is enumerated by getLegalActions with a working payment, and only when affordable', () => {
    // Tests Rule 151.1: legal actions only offer activations the engine accepts
    const sc = Scenario.start({}, cards);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    const acts = getLegalActions(sc.state, cards, 'p0').filter(
      (a) => a.type === 'ACTIVATE_ABILITY',
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ sourceId: g, abilityIndex: 0 });
    sc.setReady(g, false);
    expect(
      getLegalActions(sc.state, cards, 'p0').filter((a) => a.type === 'ACTIVATE_ABILITY'),
    ).toHaveLength(0);
  });
});

describe('scenario: Gold from cards', () => {
  const gold = (text: string): CardEffect[] => {
    const e = parseSpellText(text);
    if (!e) throw new Error(`unparsed ${text}`);
    return e;
  };
  const withFlare = (effects: CardEffect[]): CardDatabase => ({
    ...SCENARIO_CARDS,
    ...TOKEN_CARDS,
    'fx-flare': { ...base('fx-flare'), supportLevel: 'partial', effects },
  });

  it('"Kill a gear. Its controller plays a Gold gear token exhausted."', () => {
    // Tests Rule 186.1: the killed Gold ceases to exist; its controller plays a new Gold token
    const cards = withFlare(gold('Kill a gear. Its controller plays a Gold gear token exhausted.'));
    const sc = Scenario.start({}, cards);
    const g = giveGold(sc, 'p1', true);
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [obj(g)] });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.state.objects[g]).toBeUndefined();
    const golds = Object.values(sc.state.objects).filter((o) => o.cardId === 'tok-gold');
    expect(golds).toHaveLength(1);
    expect(golds[0]).toMatchObject({ controller: 'p1', ready: false });
    sc.verify();
  });

  it('"Play two Gold gear tokens exhausted" puts both in the Base', () => {
    // Tests Rule 186.1: tokens are created on the Board
    const cards = withFlare(gold('Play two Gold gear tokens exhausted.'));
    const sc = Scenario.start({}, cards);
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1) });
    sc.pass('p1');
    sc.pass('p0');
    const golds = Object.values(sc.state.objects).filter((o) => o.cardId === 'tok-gold');
    expect(golds.map((o) => [o.zone.kind, o.ready])).toEqual([
      ['base', false],
      ['base', false],
    ]);
    sc.verify();
  });
});

describe('scenario: Legion effects (812)', () => {
  const legionDb = (extra: Partial<CardDef>): CardDatabase => ({
    ...SCENARIO_CARDS,
    ...TOKEN_CARDS,
    'fx-grunt': { ...base('fx-grunt'), supportLevel: 'partial', ...extra },
  });
  const trig = legionDb({
    triggers: [
      {
        on: 'PLAY',
        condition: 'LEGION',
        effects: [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 2, here: true }],
      },
    ],
  });

  it('a Legion trigger does not fire when the card is the only one played', () => {
    // Tests Rule 812: the Legion effect needs another card played this turn
    const sc = Scenario.start({}, trig);
    const u = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', u, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.state.flow.chain).toHaveLength(0);
    sc.verify();
  });

  it('fires after another card was played this turn', () => {
    // Tests Rule 812: with another card played this turn the Legion effect is gotten
    const sc = Scenario.start({}, trig);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setPool('p0', 3);
    sc.play('p0', flare, { payment: [] });
    sc.pass('p1');
    sc.pass('p0');
    const u = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', u, { payment: [], location: { kind: 'base' } });
    expect(sc.state.flow.chain[0]).toMatchObject({ kind: 'ABILITY', triggered: true });
    sc.pass('p1');
    sc.pass('p0');
    const recruits = Object.values(sc.state.objects).filter((o) => o.cardId === 'tok-recruit');
    expect(recruits).toHaveLength(2);
    sc.verify();
  });

  it('"I cost [N] less" applies only while Legion is active', () => {
    // Tests Rule 812: the cost reduction is a Legion effect
    const cards = legionDb({ legionCostReduction: 1 });
    const sc = Scenario.start({}, cards);
    const a = sc.putInHand('p0', 'fx-grunt');
    const b = sc.putInHand('p0', 'fx-grunt');
    const cheap = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      location: { kind: 'base' as const },
    };
    // Not active yet: one Energy is not enough for a 2-Energy unit.
    expect(sc.reject({ ...cheap, cardInstanceId: a, payment: sc.exhaustPlan('p0', 1) }).code).toBe(
      'INSUFFICIENT_RESOURCES',
    );
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setPool('p0', 2);
    sc.play('p0', flare, { payment: [] });
    sc.pass('p1');
    sc.pass('p0');
    sc.play('p0', b, { payment: [], location: { kind: 'base' } });
    expect(sc.obj(b).zone.kind).toBe('base');
    // The legal-actions payment plan uses the discounted cost too.
    const plays = getLegalActions(sc.state, cards, 'p0').filter(
      (x) => x.type === 'PLAY_CARD' && x.cardInstanceId === a,
    );
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((x) => x.type === 'PLAY_CARD' && x.payment.length <= 1)).toBe(true);
    sc.verify();
  });
});

describe('scenario: "I enter ready"', () => {
  it('a unit with entersReady enters ready, others enter exhausted', () => {
    // Tests Rule 359.2.c: Units enter exhausted unless an effect makes them enter ready
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': { ...base('fx-grunt'), entersReady: true },
    };
    const sc = Scenario.start({}, cards);
    const a = sc.putInHand('p0', 'fx-grunt');
    const b = sc.putInHand('p0', 'fx-archer');
    sc.setPool('p0', 10);
    sc.play('p0', a, { payment: [], location: { kind: 'base' } });
    sc.play('p0', b, { payment: [], location: { kind: 'base' } });
    expect(sc.obj(a).ready).toBe(true);
    expect(sc.obj(b).ready).toBe(false);
    sc.verify();
  });
});
