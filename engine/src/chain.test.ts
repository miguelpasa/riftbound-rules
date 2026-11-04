import { describe, expect, it } from 'vitest';
import {
  RUNE_ABILITY_OPTS,
  canPlayNow,
  defaultResolver,
  deriveTurnState,
  finalizeAndSettle,
  finalizeItem,
  getPriorityOrder,
  getTurnStateKind,
  nextPlayerInTurnOrder,
  passPriority,
  pushPendingItem,
  syncTurnState,
} from './chain.js';
import { RULE_ERROR_MESSAGES } from './types/index.js';
import type {
  CardDatabase,
  CardDef,
  ChainItem,
  GameState,
  PlayerId,
  PlayerState,
  ReduceResult,
} from './types/index.js';

function def(cardId: string, type: CardDef['type'], keywords: CardDef['keywords'] = []): CardDef {
  return {
    cardId,
    name: cardId,
    type,
    subtypes: [],
    cost: { energy: 1 },
    domains: [],
    stats: {},
    keywords,
    text: '',
    supportLevel: 'full',
  };
}

const CARDS: CardDatabase = {
  spell: def('spell', 'SPELL'),
  action: def('action', 'SPELL', [{ name: 'Action' }]),
  react: def('react', 'SPELL', [{ name: 'Reaction' }]),
  unit: def('unit', 'UNIT'),
  gear: def('gear', 'GEAR'),
};

function player(id: PlayerId): PlayerState {
  return {
    id,
    hand: [],
    mainDeck: [],
    runeDeck: [],
    trash: [],
    banishment: [],
    base: [],
    legend: null,
    championZone: [],
    runePool: { energy: 0, power: {} },
    points: 0,
  };
}

function makeState(): GameState {
  return {
    engineVersion: '0.1.0',
    mode: 'DUEL',
    victoryScore: 8,
    players: [player('p0'), player('p1')],
    objects: {},
    battlefields: [],
    seed: { seed: 't' },
    rng: { s: [1, 2, 3, 4] },
    turn: { number: 1, activePlayer: 'p0', phase: 'MAIN', step: 'NONE' },
    turnState: { kind: 'NEUTRAL', open: true },
    flow: {
      priority: 'p0',
      focus: null,
      chain: [],
      stagedShowdowns: [],
      stagedCombats: [],
      cleanupIterations: 0,
    },
    mulligan: null,
    gameStatus: 'IN_PROGRESS',
    nextObjectId: 1,
    nextEventSeq: 1,
  };
}

let counter = 0;
/** Adds a card object (in hand) and returns [state, objectId]. */
function addCard(state: GameState, cardId: string, owner: PlayerId): [GameState, string] {
  const s = structuredClone(state);
  const id = `o${++counter}`;
  s.objects[id] = {
    id,
    cardId,
    owner,
    controller: owner,
    zone: { kind: 'hand', player: owner },
    ready: true,
    damage: 0,
    mightBonus: 0,
  };
  s.players[owner === 'p0' ? 0 : 1].hand.push(id);
  return [s, id];
}

function item(
  id: string,
  sourceObjectId: string,
  controller: PlayerId,
  extra?: Partial<ChainItem>,
): ChainItem {
  return {
    id,
    kind: 'CARD',
    sourceObjectId,
    controller,
    status: 'PENDING',
    targets: [],
    choices: {},
    ...extra,
  };
}

function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(r.message);
  return r;
}

/** Play card `cardId` for `controller` onto the chain and finalize it. */
function play(
  state: GameState,
  cardId: string,
  controller: PlayerId,
  extra?: Partial<ChainItem>,
): { state: GameState; objId: string; itemId: string } {
  const [s1, objId] = addCard(state, cardId, controller);
  const itemId = `c${objId}`;
  const s2 = pushPendingItem(s1, item(itemId, objId, controller, extra));
  const r = ok(finalizeAndSettle(s2, CARDS, itemId));
  return { state: r.state, objId, itemId };
}

const pass = (p: PlayerId) => ({ type: 'PASS_PRIORITY' as const, playerId: p });

describe('turn state derivation', () => {
  it('derives Neutral Open / Closed / Showdown from flow', () => {
    // Tests Rule 309.1: Closed iff a Chain exists; Rule 308.1: Showdown if a Showdown is in progress
    const s = makeState();
    expect(deriveTurnState(s)).toEqual({ kind: 'NEUTRAL', open: true });
    const withChain = pushPendingItem(addCard(s, 'spell', 'p0')[0], item('i1', 'o', 'p0'));
    expect(withChain.turnState).toEqual({ kind: 'NEUTRAL', open: false });
    const sd = structuredClone(s);
    sd.flow.showdown = { battlefieldId: 'b1', isCombat: false, passesInRow: 0 };
    expect(getTurnStateKind(sd)).toBe('SHOWDOWN');
    expect(syncTurnState(sd).turnState).toEqual({ kind: 'SHOWDOWN', open: true });
  });

  it('syncTurnState does not mutate its input', () => {
    // Tests Rule 307: turn state is derived, not stored authoritatively
    const s = makeState();
    s.flow.showdown = { battlefieldId: 'b1', isCombat: true, passesInRow: 0 };
    const snap = structuredClone(s);
    syncTurnState(s);
    expect(s).toEqual(snap);
  });
});

describe('canPlayNow', () => {
  it('allows a plain spell in Neutral Open on own turn in Main with priority', () => {
    // Tests Rule 155: spells only on your own turn in the Main Phase in an Open state
    expect(canPlayNow(makeState(), CARDS, 'p0', CARDS.spell!)).toEqual({ ok: true });
  });

  it('rejects non-Reaction cards in a Closed State with the exact message', () => {
    // Tests Rule 309.1.a: Closed State permits only Reactions
    const { state } = play(makeState(), 'spell', 'p0');
    // p1 holds priority after p0's spell finalizes
    const r = canPlayNow(state, CARDS, 'p1', CARDS.action!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('CLOSED_STATE_REACTION_ONLY');
      expect(r.message).toBe(RULE_ERROR_MESSAGES.CLOSED_STATE_REACTION_ONLY);
      expect(r.message).toContain(
        '[Rule Error] Action illegal during an active Chain (Closed State). Only Reactions permitted.',
      );
    }
  });

  it('allows Reaction cards in a Closed State', () => {
    // Tests Rule 309.1.a: Reactions are legal during a Chain
    const { state } = play(makeState(), 'spell', 'p0');
    expect(canPlayNow(state, CARDS, 'p1', CARDS.react!)).toEqual({ ok: true });
  });

  it('requires priority (NOT_YOUR_PRIORITY)', () => {
    // Tests Rule 312.1: discretionary actions need Priority
    const r = canPlayNow(makeState(), CARDS, 'p1', CARDS.react!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_PRIORITY');
  });

  it('rejects plain spells outside the Main Phase (WRONG_PHASE)', () => {
    // Tests Rule 155: spells only in the Main Phase
    const s = makeState();
    s.turn.phase = 'DRAW';
    const r = canPlayNow(s, CARDS, 'p0', CARDS.spell!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });

  it('rejects a plain spell for the non-turn player holding priority (NOT_YOUR_TURN)', () => {
    // Tests Rule 155: only on your own turn
    const s = makeState();
    s.flow.priority = 'p1';
    const r = canPlayNow(s, CARDS, 'p1', CARDS.spell!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_TURN');
  });

  it('Showdown Open allows Action and Reaction but not plain spells/units', () => {
    // Tests Rule 308.1.a: Showdown State permits only Action or Reaction cards
    const s = makeState();
    s.flow.showdown = { battlefieldId: 'b1', isCombat: false, passesInRow: 0 };
    s.flow.focus = 'p0';
    expect(canPlayNow(s, CARDS, 'p0', CARDS.action!)).toEqual({ ok: true });
    expect(canPlayNow(s, CARDS, 'p0', CARDS.react!)).toEqual({ ok: true });
    for (const c of [CARDS.spell!, CARDS.unit!, CARDS.gear!]) {
      const r = canPlayNow(s, CARDS, 'p0', c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
    }
  });

  it('activated abilities are not usable during a Showdown, but Reaction abilities are', () => {
    // Tests Rule 145: activated abilities only in own Main Phase Open state, not during a Showdown
    const s = makeState();
    expect(canPlayNow(s, CARDS, 'p0', CARDS.unit!, { isAbility: true })).toEqual({ ok: true });
    s.flow.showdown = { battlefieldId: 'b1', isCombat: false, passesInRow: 0 };
    const r = canPlayNow(s, CARDS, 'p0', CARDS.unit!, { isAbility: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ABILITY_NOT_AVAILABLE');
    expect(
      canPlayNow(s, CARDS, 'p0', CARDS.unit!, { isAbility: true, isReactionAbility: true }),
    ).toEqual({ ok: true });
  });

  it('rune abilities bypass the priority check', () => {
    // Tests Rule 312.1: Reaction rune abilities are handled separately and do not require Priority here
    const s = makeState();
    s.flow.priority = 'p1';
    expect(canPlayNow(s, CARDS, 'p0', CARDS.react!, RUNE_ABILITY_OPTS)).toEqual({ ok: true });
  });
});

describe('priority helpers', () => {
  it('orders players from the turn player and finds the next player', () => {
    // Tests Rule 312.2.d: next player in turn order receives Priority
    const s = makeState();
    expect(getPriorityOrder(s)).toEqual(['p0', 'p1']);
    expect(getPriorityOrder(s, 'p1')).toEqual(['p1', 'p0']);
    expect(nextPlayerInTurnOrder('p0')).toBe('p1');
    expect(nextPlayerInTurnOrder('p1')).toBe('p0');
  });

  it('finalizing an item gives Priority to the next player in turn order', () => {
    // Tests Rule 312.2.c: finalized Closed-State item hands Priority to the next player
    const [s1, id] = addCard(makeState(), 'spell', 'p0');
    const s2 = pushPendingItem(s1, item('i1', id, 'p0'));
    expect(s2.flow.chain[0]!.status).toBe('PENDING');
    const s3 = finalizeItem(s2, 'i1');
    expect(s3.flow.chain[0]!.status).toBe('FINALIZED');
    expect(s3.flow.priority).toBe('p1');
    expect(s3.turnState.open).toBe(false);
  });
});

describe('passPriority and resolution', () => {
  it('both players passing in sequence resolves the spell to trash and returns priority to the turn player', () => {
    // Tests Rule 339.1: everyone passing in sequence resolves; Rule 335: Priority back to turn player
    const { state, objId } = play(makeState(), 'spell', 'p0');
    const r1 = ok(passPriority(state, CARDS, pass('p1')));
    expect(r1.state.flow.chain).toHaveLength(1);
    expect(r1.state.flow.priority).toBe('p0');
    const r2 = ok(passPriority(r1.state, CARDS, pass('p0')));
    expect(r2.state.flow.chain).toHaveLength(0);
    expect(r2.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(r2.state.flow.priority).toBe('p0');
    expect(r2.state.objects[objId]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(r2.state.players[0].trash).toContain(objId);
    expect(r2.state.players[0].hand).not.toContain(objId);
    expect(r2.events.some((e) => e.type === 'CHAIN_ITEM_RESOLVED')).toBe(true);
  });

  it('rejects a pass from the player without priority', () => {
    // Tests Rule 312.1: only the Priority holder may act
    const { state } = play(makeState(), 'spell', 'p0');
    const r = passPriority(state, CARDS, pass('p0'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_PRIORITY');
  });

  it('a Reaction on top of a spell resolves first (LIFO), then the spell goes to trash', () => {
    // Tests Rule 340.1: the newest finalized item resolves first (see also 159.2.b.3)
    const a = play(makeState(), 'spell', 'p0');
    const b = play(a.state, 'react', 'p1');
    expect(b.state.flow.chain.map((i) => i.id)).toEqual([a.itemId, b.itemId]);
    expect(b.state.flow.priority).toBe('p0');
    const p1 = ok(passPriority(b.state, CARDS, pass('p0')));
    const p2 = ok(passPriority(p1.state, CARDS, pass('p1')));
    // Reaction resolved; spell still on chain
    expect(p2.state.flow.chain.map((i) => i.id)).toEqual([a.itemId]);
    expect(p2.state.objects[b.objId]!.zone).toEqual({ kind: 'trash', player: 'p1' });
    expect(p2.state.objects[a.objId]!.zone).toEqual({ kind: 'hand', player: 'p0' });
    expect(p2.state.turnState.open).toBe(false);
    // Priority re-seeded to next after the spell's controller, then both pass again
    expect(p2.state.flow.priority).toBe('p1');
    const p3 = ok(passPriority(p2.state, CARDS, pass('p1')));
    const p4 = ok(passPriority(p3.state, CARDS, pass('p0')));
    expect(p4.state.flow.chain).toHaveLength(0);
    expect(p4.state.objects[a.objId]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    const resolvedOrder = [...p2.events, ...p4.events]
      .filter((e) => e.type === 'CHAIN_ITEM_RESOLVED')
      .map((e) => (e as { chainItemId: string }).chainItemId);
    expect(resolvedOrder).toEqual([b.itemId, a.itemId]);
    expect(p4.state.flow.priority).toBe('p0');
  });

  it('one pass followed by a Reaction from the other player resets the pass count', () => {
    // Tests Rule 339.2: a new play means all players must pass again before Resolve
    const a = play(makeState(), 'spell', 'p0');
    // p1 passes (1 pass), p0 now holds priority and plays a Reaction on top of own spell
    const afterPass = ok(passPriority(a.state, CARDS, pass('p1')));
    expect(afterPass.state.flow.priority).toBe('p0');
    const b = play(afterPass.state, 'react', 'p0');
    expect(b.state.flow.priority).toBe('p1');
    // p1 passing now must NOT resolve anything: p0 still has to pass
    const r = ok(passPriority(b.state, CARDS, pass('p1')));
    expect(r.state.flow.chain).toHaveLength(2);
    expect(r.state.flow.priority).toBe('p0');
    const r2 = ok(passPriority(r.state, CARDS, pass('p0')));
    expect(r2.state.flow.chain.map((i) => i.id)).toEqual([a.itemId]);
  });

  it('PASS_PRIORITY in Neutral Open with an empty chain is an error', () => {
    // Tests Rule 312.2.a: turn player holds Priority in Neutral Open; nothing to pass to (END_TURN)
    const r = passPriority(makeState(), CARDS, pass('p0'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('WRONG_PHASE');
      expect(r.message).toContain('END_TURN');
    }
  });

  it('unimplemented spell resolves cleanly to trash with EFFECT_UNIMPLEMENTED; priority returns to the turn player', () => {
    // Tests Rule 340.2: chain empties -> Open again; Rule 335: Priority returns to the turn player
    const a = play(makeState(), 'spell', 'p0', { unimplementedEffect: true });
    const r1 = ok(passPriority(a.state, CARDS, pass('p1')));
    const r2 = ok(passPriority(r1.state, CARDS, pass('p0')));
    expect(r2.state.flow.chain).toHaveLength(0);
    expect(r2.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(r2.state.flow.priority).toBe('p0');
    expect(r2.state.objects[a.objId]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    const types = r2.events.map((e) => e.type);
    expect(types).toContain('EFFECT_UNIMPLEMENTED');
    expect(types).toContain('CHAIN_ITEM_RESOLVED');
    const unimpl = r2.events.find((e) => e.type === 'EFFECT_UNIMPLEMENTED');
    expect(unimpl).toMatchObject({ cardId: 'spell' });
  });

  it('a Reaction stacked on an unimplemented spell: both resolve, both trashed, priority returns to the turn player', () => {
    // Tests Rule 340.2: after the last item resolves the state is Open and Priority returns (335)
    const a = play(makeState(), 'spell', 'p0', { unimplementedEffect: true });
    const b = play(a.state, 'react', 'p1');
    const s1 = ok(passPriority(b.state, CARDS, pass('p0')));
    const s2 = ok(passPriority(s1.state, CARDS, pass('p1')));
    const s3 = ok(passPriority(s2.state, CARDS, pass('p1')));
    const s4 = ok(passPriority(s3.state, CARDS, pass('p0')));
    expect(s4.state.flow.chain).toHaveLength(0);
    expect(s4.state.turnState).toEqual({ kind: 'NEUTRAL', open: true });
    expect(s4.state.flow.priority).toBe('p0');
    expect(s4.state.objects[a.objId]!.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(s4.state.objects[b.objId]!.zone).toEqual({ kind: 'trash', player: 'p1' });
    const all = [...s1.events, ...s2.events, ...s3.events, ...s4.events];
    expect(all.filter((e) => e.type === 'EFFECT_UNIMPLEMENTED')).toHaveLength(1);
    expect(all.filter((e) => e.type === 'CHAIN_ITEM_RESOLVED')).toHaveLength(2);
  });

  it('units and gear resolve immediately on finalize and are left alone by the default resolver', () => {
    // Tests Rule 337.2: Units/Gear resolve immediately instead of waiting for passes
    const u = play(makeState(), 'unit', 'p0');
    expect(u.state.flow.chain).toHaveLength(0);
    expect(u.state.flow.priority).toBe('p0');
    expect(u.state.objects[u.objId]!.zone).toEqual({ kind: 'hand', player: 'p0' });
    const g = play(makeState(), 'gear', 'p0');
    expect(g.state.flow.chain).toHaveLength(0);
    expect(g.state.turnState.open).toBe(true);
  });

  it('Focus passes to the next player after the chain resolves in a Showdown', () => {
    // Tests Rule 340.2.a: in a Showdown, Focus passes to the next player after the last item resolves
    const s = makeState();
    s.flow.showdown = { battlefieldId: 'b1', isCombat: false, passesInRow: 0 };
    s.flow.focus = 'p0';
    s.flow.priority = 'p0';
    const a = play(s, 'action', 'p0');
    expect(a.state.turnState).toEqual({ kind: 'SHOWDOWN', open: false });
    expect(a.state.flow.focus).toBe('p0');
    const r1 = ok(passPriority(a.state, CARDS, pass('p1')));
    const r2 = ok(passPriority(r1.state, CARDS, pass('p0')));
    expect(r2.state.flow.chain).toHaveLength(0);
    expect(r2.state.flow.focus).toBe('p1');
    expect(r2.state.flow.priority).toBe('p1');
    expect(r2.state.turnState).toEqual({ kind: 'SHOWDOWN', open: true });
    expect(r2.state.flow.showdown!.passesInRow).toBe(0);
  });

  it('passing in a Showdown Open state keeps Focus cycling and counts passes', () => {
    // Tests Rule 313.3: passing keeps Focus; passes are counted in sequence
    const s = makeState();
    s.flow.showdown = { battlefieldId: 'b1', isCombat: false, passesInRow: 0 };
    s.flow.focus = 'p0';
    const r1 = ok(passPriority(s, CARDS, pass('p0')));
    expect(r1.state.flow.showdown!.passesInRow).toBe(1);
    expect(r1.state.flow.priority).toBe('p1');
    expect(r1.state.flow.focus).toBe('p1');
    const r2 = ok(passPriority(r1.state, CARDS, pass('p1')));
    expect(r2.state.flow.showdown!.passesInRow).toBe(2);
  });

  it('does not mutate its inputs', () => {
    // Tests Rule 330.1: pure functions; the input state is never mutated
    const a = play(makeState(), 'spell', 'p0');
    const snap = structuredClone(a.state);
    passPriority(a.state, CARDS, pass('p1'));
    expect(a.state).toEqual(snap);
    const r1 = ok(passPriority(a.state, CARDS, pass('p1')));
    const snap2 = structuredClone(r1.state);
    passPriority(r1.state, CARDS, pass('p0'));
    expect(r1.state).toEqual(snap2);
    const [s1, id] = addCard(makeState(), 'spell', 'p0');
    const frozen = structuredClone(s1);
    const pushed = pushPendingItem(s1, item('i9', id, 'p0'));
    finalizeItem(pushed, 'i9');
    expect(s1).toEqual(frozen);
  });

  it('uses an injected resolver instead of the default', () => {
    // Tests Rule 340.1: the injected resolver performs the newest item's effect
    const a = play(makeState(), 'spell', 'p0');
    const r1 = ok(passPriority(a.state, CARDS, pass('p1')));
    const custom = (s: GameState) => {
      const c = structuredClone(s);
      c.players[0].points += 1;
      return { state: c, events: [] };
    };
    const r2 = ok(passPriority(r1.state, CARDS, pass('p0'), custom));
    expect(r2.state.players[0].points).toBe(1);
    // custom resolver did not trash the card: leaves that to E5
    expect(defaultResolver).toBeTypeOf('function');
  });
});
