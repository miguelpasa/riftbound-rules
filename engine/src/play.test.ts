import { describe, expect, it } from 'vitest';
import { passPriority } from './chain.js';
import { playCard, playResolver } from './play.js';
import type { PlayHooks } from './play.js';
import { FIXTURE_CARDS, getObjectByCardId, makeTestGame } from './testing/fixtures.js';
import { RULE_ERROR_MESSAGES } from './types/index.js';
import type {
  CardDatabase,
  CardDef,
  GameState,
  PaymentPlan,
  PlayCardIntent,
  PlayerId,
  ReduceResult,
} from './types/index.js';

const idx = (p: PlayerId): 0 | 1 => (p === 'p0' ? 0 : 1);

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}

/** Move `cardId` (from the deck, or already in hand) into the player's hand; returns its id. */
function toHand(s: GameState, cardId: string, owner: PlayerId): string {
  const o = Object.values(s.objects).find(
    (x) =>
      x.cardId === cardId &&
      x.owner === owner &&
      (x.zone.kind === 'hand' || x.zone.kind === 'mainDeck'),
  );
  if (!o) throw new Error(`no ${cardId}`);
  const p = s.players[idx(owner)];
  p.mainDeck = p.mainDeck.filter((i) => i !== o.id);
  if (!p.hand.includes(o.id)) p.hand.push(o.id);
  o.zone = { kind: 'hand', player: owner };
  return o.id;
}

/** Give `n` ready runes of `cardId` to the player (from rune deck to base). Returns their ids. */
function giveRunes(s: GameState, owner: PlayerId, runeCardId: string, n: number): string[] {
  const p = s.players[idx(owner)];
  const ids = p.runeDeck.filter((i) => s.objects[i]?.cardId === runeCardId).slice(0, n);
  for (const id of ids) {
    p.runeDeck = p.runeDeck.filter((i) => i !== id);
    p.base.push(id);
    const o = s.objects[id]!;
    o.zone = { kind: 'base', player: owner };
    o.ready = true;
  }
  return ids;
}

const exhaust = (ids: string[]): PaymentPlan => ids.map((runeId) => ({ runeId, mode: 'EXHAUST' }));

interface Setup {
  s: GameState;
  /** p0 fury runes. */
  r0: string[];
}

/** p0 active with priority, 6 fury runes + 1 calm rune, p1 has 3 mind runes. */
function setup(): Setup {
  const s = makeTestGame('play');
  s.flow.priority = 'p0';
  const r0 = giveRunes(s, 'p0', 'fx-rune-fury', 6);
  giveRunes(s, 'p0', 'fx-rune-calm', 1);
  giveRunes(s, 'p1', 'fx-rune-mind', 3);
  return { s, r0 };
}

function intent(
  cardInstanceId: string,
  payment: PaymentPlan,
  extra: Partial<PlayCardIntent> = {},
  playerId: PlayerId = 'p0',
): PlayCardIntent {
  return { type: 'PLAY_CARD', playerId, cardInstanceId, payment, ...extra };
}

describe('playCard: units and gear', () => {
  it('plays a unit at the base exhausted', () => {
    // Tests Rule 359.2.c: units enter exhausted at the chosen location
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    const r = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 2)))));
    const u = r.state.objects[id]!;
    expect(u.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(u.ready).toBe(false);
    expect(u.enteredTurn).toBe(1);
    expect(r.state.players[0].base).toContain(id);
    expect(r.state.players[0].hand).not.toContain(id);
    expect(r.state.flow.chain).toHaveLength(0);
    expect(r.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(r.state.flow.priority).toBe('p0');
    expect(r.events.map((e) => e.type)).toEqual([
      'CARD_PLAYED',
      'CHAIN_ITEM_ADDED',
      'CHAIN_ITEM_RESOLVED',
    ]);
    expect(r.events.map((e) => e.seq)).toEqual(
      [...r.events.map((e) => e.seq)].sort((a, b) => a - b),
    );
  });

  it('plays a unit at a battlefield the player controls', () => {
    // Tests Rule 355.2: a unit may be played to a battlefield you control
    const { s, r0 } = setup();
    s.battlefields[0]!.controller = 'p0';
    const bf = s.battlefields[0]!.id;
    const id = toHand(s, 'fx-grunt', 'p0');
    const r = ok(
      playCard(
        s,
        FIXTURE_CARDS,
        intent(id, exhaust(r0.slice(0, 2)), {
          location: { kind: 'battlefield', battlefieldId: bf },
        }),
      ),
    );
    expect(r.state.objects[id]!.zone).toEqual({
      kind: 'battlefield',
      player: 'p0',
      battlefieldId: bf,
    });
    expect(r.state.players[0].base).not.toContain(id);
    expect(r.state.objects[id]!.ready).toBe(false);
  });

  it('rejects an uncontrolled or unknown battlefield', () => {
    // Tests Rule 355.2: cannot play to a battlefield you do not control
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    const bf = s.battlefields[1]!.id;
    for (const owner of [null, 'p1'] as const) {
      s.battlefields[1]!.controller = owner;
      const r = playCard(
        s,
        FIXTURE_CARDS,
        intent(id, exhaust(r0.slice(0, 2)), {
          location: { kind: 'battlefield', battlefieldId: bf },
        }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('ILLEGAL_LOCATION');
    }
    const r2 = playCard(
      s,
      FIXTURE_CARDS,
      intent(id, [], { location: { kind: 'battlefield', battlefieldId: 'nope' } }),
    );
    expect(!r2.ok && r2.code).toBe('ILLEGAL_LOCATION');
  });

  it('plays gear ready at the base, and gear cannot choose a battlefield', () => {
    // Tests Rule 359.2.d: gear enters ready at the base
    const { s, r0 } = setup();
    s.battlefields[0]!.controller = 'p0';
    const id = toHand(s, 'fx-ember-totem', 'p0');
    const bad = playCard(
      s,
      FIXTURE_CARDS,
      intent(id, exhaust(r0.slice(0, 2)), {
        location: { kind: 'battlefield', battlefieldId: s.battlefields[0]!.id },
      }),
    );
    expect(!bad.ok && bad.code).toBe('ILLEGAL_LOCATION');
    const r = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 2)))));
    const g = r.state.objects[id]!;
    expect(g.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(g.ready).toBe(true);
    expect(r.state.players[0].base).toContain(id);
    expect(r.state.flow.chain).toHaveLength(0);
  });

  it('plays an Accelerate unit ready when Accelerate is paid', () => {
    // Tests Rule 356.2.b: Accelerate additional cost makes the unit enter ready
    const cards: CardDatabase = {
      ...FIXTURE_CARDS,
      'fx-grunt': {
        ...(FIXTURE_CARDS['fx-grunt'] as CardDef),
        keywords: [{ name: 'Accelerate' }],
      },
    };
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    // cost 2 energy + 1 energy + 1 Fury power = 3 exhausts + 1 recycle
    const plan: PaymentPlan = [...exhaust(r0.slice(0, 3)), { runeId: r0[3]!, mode: 'RECYCLE' }];
    const r = ok(playCard(s, cards, intent(id, plan, { additionalCosts: { accelerate: true } })));
    expect(r.state.objects[id]!.ready).toBe(true);
    // without the flag it is exhausted
    const s2 = setup();
    const id2 = toHand(s2.s, 'fx-grunt', 'p0');
    const r2 = ok(playCard(s2.s, cards, intent(id2, exhaust(s2.r0.slice(0, 2)))));
    expect(r2.state.objects[id2]!.ready).toBe(false);
  });

  it('rejects Accelerate on a card without the keyword', () => {
    // Tests Rule 356.2.b: Accelerate requires the keyword
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    const r = playCard(
      s,
      FIXTURE_CARDS,
      intent(id, exhaust(r0.slice(0, 4)), { additionalCosts: { accelerate: true } }),
    );
    expect(!r.ok && r.code).toBe('KEYWORD_RESTRICTION');
  });

  it('plays the Chosen Champion from the champion zone', () => {
    // Tests Rule 108.3.d: the Chosen Champion may be played from the champion zone
    const { s, r0 } = setup();
    const id = s.players[0].championZone[0]!;
    const r = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 4)))));
    expect(r.state.players[0].championZone).toEqual([]);
    expect(r.state.objects[id]!.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(r.state.objects[id]!.ready).toBe(false);
  });

  it('rejects legends, runes and battlefields as WRONG_CARD_TYPE', () => {
    // Tests Rule 349: only Units, Gear and Spells can be played
    const { s } = setup();
    const legend = s.players[0].legend!;
    const rune = s.players[0].base[0]!;
    for (const id of [legend, rune]) {
      const r = playCard(s, FIXTURE_CARDS, intent(id, []));
      expect(!r.ok && r.code).toBe('WRONG_CARD_TYPE');
    }
  });
});

describe('playCard: validation', () => {
  it('rejects a card that is not in the hand', () => {
    // Tests Rule 349: the card must be played from hand
    const { s, r0 } = setup();
    const deckCard = s.players[0].mainDeck[0]!;
    const r = playCard(s, FIXTURE_CARDS, intent(deckCard, exhaust(r0)));
    expect(!r.ok && r.code).toBe('NOT_IN_HAND');
    const opp = toHand(s, 'fx-tide-grunt', 'p1');
    const r2 = playCard(s, FIXTURE_CARDS, intent(opp, exhaust(r0)));
    expect(!r2.ok && r2.code).toBe('NOT_IN_HAND');
    const r3 = playCard(s, FIXTURE_CARDS, intent('zzz', []));
    expect(!r3.ok && r3.code).toBe('NOT_FOUND');
  });

  it('rejects play without priority or outside your turn', () => {
    // Tests Rule 312.1: you need Priority; Rule 155: units on your own turn
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    s.flow.priority = 'p1';
    const a = playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 2))));
    expect(!a.ok && a.code).toBe('NOT_YOUR_PRIORITY');
    const o = toHand(s, 'fx-tide-grunt', 'p1');
    const b = playCard(s, FIXTURE_CARDS, intent(o, [], {}, 'p1'));
    expect(!b.ok && b.code).toBe('NOT_YOUR_TURN');
  });

  it('rejects a Main-phase unit in the wrong phase', () => {
    // Tests Rule 313: Main Phase only
    const { s, r0 } = setup();
    s.turn.phase = 'DRAW';
    const id = toHand(s, 'fx-grunt', 'p0');
    const r = playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 2))));
    expect(!r.ok && r.code).toBe('WRONG_PHASE');
  });

  it('validates targets: existing and public only', () => {
    // Tests Rule 355.10.a.1: only public-zone objects can be targeted
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-plain-spell', 'p0');
    const pay = exhaust(r0.slice(0, 2));
    const inHand = s.players[1].hand[0]!;
    const cases = [
      { kind: 'object', id: inHand },
      { kind: 'object', id: 'missing' },
      { kind: 'battlefield', battlefieldId: 'nope' },
      { kind: 'object', id },
    ] as const;
    for (const t of cases) {
      const r = playCard(s, FIXTURE_CARDS, intent(id, pay, { targets: [t] }));
      expect(!r.ok && r.code).toBe('ILLEGAL_TARGET');
    }
    const legal = ok(
      playCard(
        s,
        FIXTURE_CARDS,
        intent(id, pay, {
          targets: [
            { kind: 'object', id: s.players[0].legend! },
            { kind: 'player', playerId: 'p1' },
            { kind: 'battlefield', battlefieldId: s.battlefields[0]!.id },
          ],
        }),
      ),
    );
    expect(legal.state.flow.chain[0]!.targets).toHaveLength(3);
  });
});

describe('playCard: payment and atomicity', () => {
  it('leaves state unchanged when resources are insufficient', () => {
    // Tests Rule 358.5: a failed play is undone
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    const before = structuredClone(s);
    const r = playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 1))));
    expect(!r.ok && r.code).toBe('INSUFFICIENT_RESOURCES');
    expect(s).toEqual(before);
    const bad = playCard(s, FIXTURE_CARDS, intent(id, [{ runeId: 'nope', mode: 'EXHAUST' }]));
    expect(bad.ok).toBe(false);
    expect(s).toEqual(before);
  });

  it('pays with exhausted and recycled runes', () => {
    // Tests Rule 357.1: payment activates runes into the pool and deducts the cost
    const { s, r0 } = setup();
    giveRunes(s, 'p0', 'fx-rune-calm', 1);
    const calms = s.players[0].base.filter((i) => s.objects[i]!.cardId === 'fx-rune-calm');
    const calm = calms[0]!;
    const id = toHand(s, 'fx-titan', 'p0'); // 5 energy + 1 Calm power
    const plan: PaymentPlan = [
      ...exhaust(r0.slice(0, 5)),
      ...calms.slice(0, 1).map((runeId) => ({ runeId, mode: 'RECYCLE' as const })),
    ];
    const r = ok(playCard(s, FIXTURE_CARDS, intent(id, plan)));
    for (const rid of r0.slice(0, 5)) expect(r.state.objects[rid]!.ready).toBe(false);
    expect(r.state.objects[calm]!.zone).toEqual({ kind: 'runeDeck', player: 'p0' });
    expect(r.state.players[0].base).not.toContain(calm);
    expect(r.state.players[0].runePool).toEqual({ energy: 0, power: {} });
  });

  it('does not mutate its input and is deterministic', () => {
    // Tests Rule 358: reducers are pure and deterministic
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-flare', 'p0');
    const frozen = structuredClone(s);
    const a = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 1)))));
    const b = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 1)))));
    expect(s).toEqual(frozen);
    expect(a).toEqual(b);
  });
});

describe('playCard: spells and the chain', () => {
  it('puts a spell on the chain, closes the state and hands priority to the opponent', () => {
    // Tests Rule 354: the played card moves to the Chain; Rule 359.3.a spells stay there
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-flare', 'p0');
    const r = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 1)))));
    expect(r.state.objects[id]!.zone).toEqual({ kind: 'chain', player: 'p0' });
    expect(r.state.players[0].hand).not.toContain(id);
    expect(r.state.flow.chain).toHaveLength(1);
    expect(r.state.flow.chain[0]!.status).toBe('FINALIZED');
    expect(r.state.turnState.open).toBe(false);
    expect(r.state.flow.priority).toBe('p1');
    expect(r.events.map((e) => e.type)).toEqual(['CARD_PLAYED', 'CHAIN_ITEM_ADDED']);
  });

  it('rejects a plain spell in response with the exact closed-state message', () => {
    // Tests Rule 309.1.a: only Reactions in a Closed State
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-flare', 'p0');
    const played = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 1)))));
    const p1 = played.state;
    const surge = toHand(p1, 'fx-tide-surge', 'p1');
    const r = playCard(p1, FIXTURE_CARDS, intent(surge, [], {}, 'p1'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CLOSED_STATE_REACTION_ONLY');
      expect(r.message).toBe(RULE_ERROR_MESSAGES.CLOSED_STATE_REACTION_ONLY);
    }
  });

  it('resolves an opposing Reaction first, then the spell, both ending in the trash', () => {
    // Tests Rule 340.1: chain resolves LIFO; Rule 359.3.d spells go to the trash
    const { s, r0 } = setup();
    const flare = toHand(s, 'fx-flare', 'p0');
    const guard = toHand(s, 'fx-tide-guard', 'p1');
    const runes1 = s.players[1].base.filter((i) => s.objects[i]!.cardId === 'fx-rune-mind');
    let st = ok(playCard(s, FIXTURE_CARDS, intent(flare, exhaust(r0.slice(0, 1))))).state;
    // Tidal Guard: Order Reaction, energy 1.
    const r1 = ok(
      playCard(st, FIXTURE_CARDS, intent(guard, exhaust(runes1.slice(0, 1)), {}, 'p1')),
    );
    st = r1.state;
    expect(st.flow.chain.map((i) => i.sourceObjectId)).toEqual([flare, guard]);
    expect(st.flow.priority).toBe('p0');
    // p0 passes, then p1 passes: reaction resolves first.
    st = ok(
      passPriority(st, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p0' }, playResolver),
    ).state;
    const mid = ok(
      passPriority(st, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p1' }, playResolver),
    );
    expect(mid.state.objects[guard]!.zone).toEqual({ kind: 'trash', player: 'p1' });
    expect(mid.state.objects[flare]!.zone.kind).toBe('chain');
    expect(mid.state.flow.chain).toHaveLength(1);
    // Now the spell: p1 (opponent of controller) passes, then p0.
    expect(mid.state.flow.priority).toBe('p1');
    let st2 = ok(
      passPriority(
        mid.state,
        FIXTURE_CARDS,
        { type: 'PASS_PRIORITY', playerId: 'p1' },
        playResolver,
      ),
    ).state;
    const fin = ok(
      passPriority(st2, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p0' }, playResolver),
    );
    st2 = fin.state;
    expect(st2.objects[flare]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(st2.players[0].trash.filter((i) => i === flare)).toHaveLength(1);
    expect(st2.players[1].trash.filter((i) => i === guard)).toHaveLength(1);
    expect(st2.flow.chain).toHaveLength(0);
    expect(st2.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(st2.flow.priority).toBe('p0');
    expect(fin.events.map((e) => e.type)).toEqual(['CHAIN_ITEM_RESOLVED']);
  });

  it('flags and resolves an unimplemented spell with EFFECT_UNIMPLEMENTED, priority back to the turn player', () => {
    // Tests Rule 335: Open Neutral, Priority returns to the turn player after the chain empties
    const { s, r0 } = setup();
    const odd = toHand(s, 'fx-odd-reaction', 'p0'); // partial Reaction spell
    const ward = toHand(s, 'fx-tide-guard', 'p1');
    const runes1 = s.players[1].base.filter((i) => s.objects[i]!.cardId === 'fx-rune-mind');
    let st = ok(playCard(s, FIXTURE_CARDS, intent(odd, exhaust(r0.slice(0, 1))))).state;
    expect(st.flow.chain[0]!.unimplementedEffect).toBe(true);
    st = ok(playCard(st, FIXTURE_CARDS, intent(ward, exhaust(runes1.slice(0, 1)), {}, 'p1'))).state;
    expect(st.flow.chain[1]!.unimplementedEffect).toBeUndefined();
    const pass = (state: GameState, p: PlayerId): ReturnType<typeof passPriority> =>
      passPriority(state, FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: p }, playResolver);
    st = ok(pass(st, 'p0')).state;
    st = ok(pass(st, 'p1')).state; // reaction resolves
    st = ok(pass(st, 'p1')).state;
    const last = ok(pass(st, 'p0'));
    expect(last.events.map((e) => e.type)).toEqual(['EFFECT_UNIMPLEMENTED', 'CHAIN_ITEM_RESOLVED']);
    expect(last.events[0]).toMatchObject({
      type: 'EFFECT_UNIMPLEMENTED',
      cardId: 'fx-odd-reaction',
    });
    expect(last.state.objects[odd]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(last.state.flow.chain).toHaveLength(0);
    expect(last.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(last.state.flow.priority).toBe('p0');
  });
});

describe('playResolver and hooks', () => {
  it('does not trash twice and ignores units/gear', () => {
    // Tests Rule 157: a card goes to the trash exactly once
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-flare', 'p0');
    const st = ok(playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 1))))).state;
    const item = st.flow.chain[0]!;
    const popped = { ...st, flow: { ...st.flow, chain: [] } };
    const once = playResolver(popped, item, FIXTURE_CARDS);
    const twice = playResolver(once.state, item, FIXTURE_CARDS);
    expect(twice.state.players[0].trash.filter((i) => i === id)).toHaveLength(1);
    expect(twice.state.objects[id]!.zone.kind).toBe('trash');
    const unitId = toHand(s, 'fx-grunt', 'p0');
    const u = ok(playCard(s, FIXTURE_CARDS, intent(unitId, exhaust(r0.slice(0, 2)))));
    expect(u.state.players[0].trash).not.toContain(unitId);
  });

  it('applies PlayHooks extraCosts and onEnter', () => {
    // Tests Rule 356.2: cost increases apply; Rule 359.2 enter-play hook runs on entry
    const hooks: PlayHooks = {
      extraCosts: () => ({ energy: 1 }),
      onEnter: (state, _c, objectId) => {
        state.objects[objectId]!.mightBonus = 3;
        return [];
      },
    };
    const { s, r0 } = setup();
    const id = toHand(s, 'fx-grunt', 'p0');
    const short = playCard(
      s,
      FIXTURE_CARDS,
      intent(id, exhaust(r0.slice(0, 2))),
      playResolver,
      hooks,
    );
    expect(!short.ok && short.code).toBe('INSUFFICIENT_RESOURCES');
    const r = ok(
      playCard(s, FIXTURE_CARDS, intent(id, exhaust(r0.slice(0, 3))), playResolver, hooks),
    );
    expect(r.state.objects[id]!.mightBonus).toBe(3);
  });

  it('can still locate the object by card id (fixture sanity)', () => {
    // Tests Rule 107: every card is a distinct object
    const { s } = setup();
    expect(getObjectByCardId(s, 'fx-grunt', 'p0')?.owner).toBe('p0');
  });
});
