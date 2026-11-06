import { describe, it, expect } from 'vitest';
import { AIController } from '../ai/bot.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, Scenario } from '../testing/scenario.js';
import { getLegalActions } from '../legalActions.js';
import { sanitizeEvents, sanitizeFor } from '../sanitize.js';
import { stateHash } from '../replay.js';
import { costCardText, costCardCandidates } from '../costCards.js';
import type {
  CardDatabase,
  CardDef,
  CostCardChoice,
  Intent,
  PlayLocation,
} from '../types/index.js';

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;

const DRAW = { op: 'DRAW', amount: 1 } as const;

/** p0's fx-grunt (2 Energy unit), fx-flare (1 Energy Action spell) and fx-blade (2 Energy gear) get an additional cost. */
const withCost = (
  card: CostCardChoice,
  patch: { grunt?: boolean; flare?: boolean; totem?: boolean } = { flare: true },
): CardDatabase => {
  const out: CardDatabase = { ...SCENARIO_CARDS };
  const set = (id: string, extra: Partial<CardDef>): void => {
    out[id] = { ...(SCENARIO_CARDS[id] as CardDef), ...extra };
  };
  if (patch.grunt) set('fx-grunt', { additionalCost: { card } });
  if (patch.flare) set('fx-flare', { additionalCost: { card }, effects: [DRAW] });
  if (patch.totem) set('fx-blade', { additionalCost: { card } });
  return out;
};

const plays = (sc: Scenario, id: string): Play[] =>
  getLegalActions(sc.state, sc.cards, 'p0').filter(
    (i): i is Play => i.type === 'PLAY_CARD' && i.cardInstanceId === id,
  );

describe('scenario: additional cost to play a spell (R47)', () => {
  const cards = withCost({ kind: 'EXHAUST' });

  it('lists one play per ready friendly unit and pays by exhausting it, with the Energy', () => {
    // Tests Rule 357.1.a: additional costs are paid as part of playing the card
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const b = sc.putUnit('p0', 'fx-archer', 'base');
    sc.putUnit('p0', 'fx-ash-tank', 'base', { ready: false }); // exhausted: cannot pay
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    expect(plays(sc, flare).map((p) => p.costCards)).toEqual([[a], [b]]);
    const hand = sc.player('p0').hand.length;
    const r = sc.do({ ...(plays(sc, flare)[1] as Play), payment: sc.exhaustPlan('p0', 1) });
    expect(sc.obj(b).ready).toBe(false);
    expect(sc.obj(a).ready).toBe(true);
    const types = r.events.map((e) => e.type);
    expect(types.indexOf('COST_CARDS_PAID')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('COST_CARDS_PAID')).toBeLessThan(types.indexOf('CARD_PLAYED'));
    expect(sc.eventsOfType('COST_CARDS_PAID', r.events)).toEqual([
      expect.objectContaining({ player: 'p0', kind: 'EXHAUST', cardIds: [b] }),
    ]);
    // the spell resolves after both pass
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.player('p0').hand.length).toBe(hand); // -1 played, +1 drawn
    expect(sc.player('p0').trash).toContain(flare);
    sc.verify();
  });

  it('a bad or missing choice is rejected before anything is paid (state untouched)', () => {
    // Tests Rule 358.5: an illegal play is undone, nothing is paid
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const gone = sc.putUnit('p0', 'fx-archer', 'base', { ready: false });
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const before = stateHash(sc.state);
    const base: Play = {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: flare,
      payment: sc.exhaustPlan('p0', 1),
    };
    expect(sc.reject(base).code).toBe('MISSING_TARGET');
    expect(sc.reject({ ...base, costCards: [] }).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject({ ...base, costCards: [a, a] }).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject({ ...base, costCards: [gone] }).code).toBe('ILLEGAL_TARGET'); // exhausted
    expect(sc.reject({ ...base, costCards: [theirs] }).code).toBe('ILLEGAL_TARGET'); // not friendly
    expect(sc.reject({ ...base, costCards: [flare] }).code).toBe('ILLEGAL_TARGET'); // the card itself
    // a good choice with a bad payment plan pays nothing either
    expect(sc.reject({ ...base, costCards: [a], payment: [] }).ok).toBe(false);
    expect(stateHash(sc.state)).toBe(before);
    expect(sc.obj(a).ready).toBe(true);
    sc.verify();
  });

  it('is not playable (not offered) when nothing can pay the additional cost', () => {
    // Tests Rule 357.1.a: a card whose cost cannot be paid cannot be played
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    sc.putUnit('p0', 'fx-grunt', 'base', { ready: false });
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    expect(plays(sc, flare)).toEqual([]);
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: flare,
        payment: sc.exhaustPlan('p0', 1),
      }).code,
    ).toBe('MISSING_TARGET');
  });

  it('a card without an additional cost refuses stray costCards', () => {
    // Tests Rule 357.1.a: no cost to pay with those cards
    const sc = Scenario.start({}, SCENARIO_CARDS);
    sc.giveRunes('p0', 2);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: flare,
        costCards: [a],
        payment: sc.exhaustPlan('p0', 1),
      }).code,
    ).toBe('ILLEGAL_TARGET');
  });
});

describe('scenario: additional cost to play a unit or gear (R47)', () => {
  it('a unit that kills a friendly unit: the victim dies, the unit enters', () => {
    // Tests Rule 323: lethal damage kills a unit at the next Cleanup; the cost is paid when playing
    const cards = withCost({ kind: 'KILL', what: 'unit' }, { grunt: true });
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const victim = sc.putUnit('p0', 'fx-archer', 'base');
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.setMainPhase('p0');
    const loc: PlayLocation = { kind: 'base' };
    const mine = plays(sc, grunt).filter((p) => p.location?.kind === 'base');
    expect(mine.map((p) => p.costCards)).toEqual([[victim]]);
    sc.do({ ...(mine[0] as Play), location: loc, payment: sc.exhaustPlan('p0', 2) });
    expect(sc.obj(victim).zone.kind).toBe('trash');
    expect(sc.obj(grunt).zone.kind).toBe('base');
    sc.verify();
  });

  it('a unit with a return cost cannot return itself, and enemies never qualify', () => {
    // Tests Rule 357.1.a: only a friendly unit can be returned to pay
    const cards = withCost({ kind: 'RETURN', what: 'unit' }, { grunt: true });
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.setMainPhase('p0');
    expect(plays(sc, grunt)).toEqual([]);
    const mine = sc.putUnit('p0', 'fx-archer', 'base');
    const first = plays(sc, grunt).find((p) => p.location?.kind === 'base') as Play;
    expect(first.costCards).toEqual([mine]);
    sc.do({ ...first, payment: sc.exhaustPlan('p0', 2) });
    expect(sc.obj(mine).zone.kind).toBe('hand');
    sc.verify();
  });

  it('a gear that returns a friendly gear to hand', () => {
    // Tests Rule 359.2: gear enter the Base; the returned gear goes back to its owner's hand
    const cards = withCost({ kind: 'RETURN', what: 'gear' }, { totem: true });
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const old = sc.putUnit('p0', 'fx-blade', 'base');
    const totem = sc.putInHand('p0', 'fx-blade');
    sc.setMainPhase('p0');
    const p = plays(sc, totem)[0] as Play;
    expect(p.costCards).toEqual([old]);
    sc.do({ ...p, payment: sc.exhaustPlan('p0', 2) });
    expect(sc.player('p0').hand).toContain(old);
    expect(sc.obj(totem).zone.kind).toBe('base');
    sc.verify();
  });
});

describe('scenario: Mighty, discard and Repeat additional costs (R47)', () => {
  it('"kill a friendly [Mighty] unit" needs a unit with Might 5 or more', () => {
    // Tests Rule 357.1.a: the unit chosen must satisfy the restriction
    const cc: CostCardChoice = { kind: 'KILL', what: 'unit', mighty: true };
    expect(costCardText(cc)).toBe('Kill a friendly Mighty unit');
    const sc = Scenario.start({}, withCost(cc));
    sc.giveRunes('p0', 2);
    const small = sc.putUnit('p0', 'fx-grunt', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const might = sc.cards['fx-grunt']?.stats.might ?? 0;
    expect(might).toBeLessThan(5);
    expect(costCardCandidates(sc.state, sc.cards, 'p0', flare, cc)).toEqual([]);
    expect(plays(sc, flare)).toEqual([]);
    sc.setMightBonus(small, 5 - might);
    expect(plays(sc, flare).map((p) => p.costCards)).toEqual([[small]]);
    sc.do({ ...(plays(sc, flare)[0] as Play), payment: sc.exhaustPlan('p0', 1) });
    expect(sc.obj(small).zone.kind).toBe('trash');
    sc.verify();
  });

  it('Repeat with "Discard 1": a plain play and a Repeat play per other hand card', () => {
    // Tests Rule 820: Repeat is an optional additional cost; here it is discarding a card
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        effects: [DRAW],
        repeatCost: { energy: 0, power: 0, card: { kind: 'DISCARD' } },
      },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const all = plays(sc, flare);
    const plain = all.filter((p) => !p.additionalCosts?.repeat);
    const rep = all.filter((p) => p.additionalCosts?.repeat);
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toHaveProperty('costCards');
    const others = sc.player('p0').hand.filter((id) => id !== flare);
    expect(rep.map((p) => (p.costCards as string[])[0]).sort()).toEqual([...others].sort());
    // Repeat without cards, or discarding the spell itself, is refused; plain with cards too
    const base = rep[0] as Play;
    expect(sc.reject({ ...base, costCards: undefined }).code).toBe('MISSING_TARGET');
    expect(sc.reject({ ...base, costCards: [flare] }).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject({ ...(plain[0] as Play), costCards: [others[0] as string] }).code).toBe(
      'ILLEGAL_TARGET',
    );
    const hand = sc.player('p0').hand.length;
    sc.do(base);
    sc.pass('p1');
    sc.pass('p0');
    // played (-1), discarded (-1), drew twice (+2)
    expect(sc.player('p0').hand.length).toBe(hand);
    expect(sc.player('p0').trash).toContain(base.costCards?.[0]);
    sc.verify();
  });

  it('an optional Repeat without enough cards to discard simply is not offered', () => {
    // Tests Rule 820: only the plain play remains
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        effects: [DRAW],
        repeatCost: { energy: 0, power: 0, card: { kind: 'DISCARD' } },
      },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    sc.emptyHand('p0');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    expect(plays(sc, flare).filter((p) => p.additionalCosts?.repeat)).toEqual([]);
    expect(plays(sc, flare)).toHaveLength(1);
  });
});

describe('scenario: legal actions, bot and hidden information (R47)', () => {
  it('caps the card choices at 48 and keeps the list in object order', () => {
    // Tests Rule 357.1.a: all choices are legal; the list handed to bots and UIs is capped
    const cc: CostCardChoice = { kind: 'EXHAUST', count: 2 };
    const sc = Scenario.start({}, withCost(cc));
    sc.giveRunes('p0', 2);
    for (const id of [
      'fx-grunt',
      'fx-archer',
      'fx-ash-tank',
      'fx-shielder',
      'fx-ganker',
      'fx-titan',
      'fx-wisp',
    ])
      for (let i = 0; i < 2; i++) sc.putUnit('p0', id, 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const list = plays(sc, flare);
    expect(list).toHaveLength(48);
    expect(list[0]?.costCards).toHaveLength(2);
  });

  it('the bot plays a spell with a card cost through a legal intent', () => {
    // Tests Rule 357.1.a: the bot picks among the listed card choices
    const sc = Scenario.start({}, withCost({ kind: 'EXHAUST' }));
    sc.giveRunes('p0', 2);
    sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const bot = new AIController('p0', { cards: sc.cards, deck: SCENARIO_DECK_A, budgetMs: 50 });
    const pick = bot.decide(sanitizeFor(sc.state, 'p0'));
    expect(pick).not.toBeNull();
    expect(sc.tryDo(pick as Intent).ok).toBe(true);
  });

  it('a discarded Repeat card is public in the Trash; the hand stays private', () => {
    // Tests Rule 357.1.a: the cost event is visible to the opponent, the rest of the hand is not
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': {
        ...(SCENARIO_CARDS['fx-flare'] as CardDef),
        effects: [DRAW],
        repeatCost: { energy: 0, power: 0, card: { kind: 'DISCARD' } },
      },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 2);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.setMainPhase('p0');
    const rep = plays(sc, flare).find((p) => p.additionalCosts?.repeat) as Play;
    const r = sc.do(rep);
    const seen = sanitizeEvents(r.events, 'p1').filter((e) => e.type === 'COST_CARDS_PAID');
    expect(seen).toHaveLength(1);
    const view = sanitizeFor(sc.state, 'p1');
    const kept = sc.player('p0').hand;
    for (const id of kept) expect(JSON.stringify(view.objects[id] ?? null)).not.toContain('fx-');
  });
});
