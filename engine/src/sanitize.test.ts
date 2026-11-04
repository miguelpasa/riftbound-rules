import { describe, expect, it } from 'vitest';
import { canViewerSeeObject, sanitizeEvents, sanitizeFor } from './sanitize.js';
import { assertNoLeaks, findLeaks } from './testing/leakCheck.js';
import type { GameEvent } from './types/event.js';
import type { CardInstance, GameState, PlayerId, ZoneRef } from './types/state.js';
import { isHiddenCard } from './types/view.js';

// ---- local fixture builder (seeded, no external deps) ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARD_POOL = Array.from({ length: 30 }, (_, i) => `ogn-${String(i + 1).padStart(3, '0')}-298`);

function makeState(seed: number): GameState {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  const objects: Record<string, CardInstance> = {};
  let next = 1;
  const mk = (owner: PlayerId, zone: ZoneRef, controller: PlayerId = owner): string => {
    const id = `obj-${next++}-${int(1000)}`;
    objects[id] = {
      id,
      cardId: CARD_POOL[int(CARD_POOL.length)] as string,
      owner,
      controller,
      zone,
      ready: rnd() < 0.5,
      damage: int(3),
      mightBonus: 0,
    };
    return id;
  };
  const ids: PlayerId[] = ['p0', 'p1'];
  const fill = (player: PlayerId, kind: ZoneRef['kind'], n: number): string[] =>
    Array.from({ length: n }, () => mk(player, { kind, player } as ZoneRef));
  const players = ids.map((p) => ({
    id: p,
    hand: fill(p, 'hand', int(8)),
    mainDeck: fill(p, 'mainDeck', int(30)),
    runeDeck: fill(p, 'runeDeck', int(12)),
    trash: fill(p, 'trash', int(5)),
    banishment: fill(p, 'banishment', int(3)),
    base: fill(p, 'base', int(6)),
    legend: rnd() < 0.8 ? mk(p, { kind: 'legend', player: p }) : null,
    championZone: fill(p, 'champion', int(2)),
    runePool: { energy: int(5), power: { Fury: int(3) } },
    points: int(8),
  })) as unknown as GameState['players'];

  const battlefields = [0, 1].map((i) => {
    const owner = ids[int(2)] as PlayerId;
    const bfId = `bf${i}`;
    let facedownSlotId: string | null = null;
    if (rnd() < 0.7) {
      const controller = ids[int(2)] as PlayerId;
      facedownSlotId = mk(
        controller,
        { kind: 'facedown', player: controller, battlefieldId: bfId },
        controller,
      );
    }
    mk(owner, { kind: 'battlefield', player: owner, battlefieldId: bfId });
    return {
      id: bfId,
      cardId: `bf-card-${i}-${int(100)}`,
      owner,
      controller: null,
      contestedBy: null,
      facedownSlotId,
      scoredThisTurnBy: [],
    };
  });

  const chainSource = mk('p0', { kind: 'chain', player: 'p0' });
  return {
    engineVersion: '0.1.0',
    mode: 'DUEL',
    victoryScore: 8,
    players,
    objects,
    battlefields,
    seed: { seed: `secret-seed-${seed}-xyz` },
    rng: {
      s: [
        int(2 ** 31) + 1000003,
        int(2 ** 31) + 1000003,
        int(2 ** 31) + 1000003,
        int(2 ** 31) + 1000003,
      ],
    },
    turn: {
      number: 1 + int(10),
      activePlayer: ids[int(2)] as PlayerId,
      phase: 'MAIN',
      step: 'NONE',
    },
    turnState: { kind: 'NEUTRAL', open: true },
    flow: {
      priority: 'p0',
      focus: null,
      chain: [
        {
          id: 'ci1',
          kind: 'CARD',
          sourceObjectId: chainSource,
          controller: 'p0',
          status: 'FINALIZED',
          targets: [
            { kind: 'object', id: chainSource },
            { kind: 'player', playerId: 'p1' },
          ],
          choices: {},
        },
      ],
      stagedShowdowns: [],
      stagedCombats: [],
      cleanupIterations: 0,
    },
    mulligan: null,
    gameStatus: 'IN_PROGRESS',
    nextObjectId: next,
    nextEventSeq: 77,
  };
}

const VIEWERS: PlayerId[] = ['p0', 'p1'];
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('sanitizeFor', () => {
  it('never leaks hidden info for any random state and viewer', () => {
    // Tests Rule 128: Secret/Private information never reaches a viewer who may not see it
    for (const seed of SEEDS) {
      const state = makeState(seed);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        expect(findLeaks(view, state, v)).toEqual([]);
        expect(() => assertNoLeaks(view, state, v)).not.toThrow();
      }
    }
  });

  it('leak check detects an unsanitized state (checker is not vacuous)', () => {
    // Tests Rule 128: the leak detector flags raw hidden ids, rng and seed
    const state = makeState(7);
    const leaks = findLeaks(state, state, 'p0');
    expect(leaks.some((l) => l.includes('rng'))).toBe(true);
    expect(leaks.some((l) => l.includes('seed'))).toBe(true);
    expect(leaks.some((l) => l.includes('hidden object id'))).toBe(true);
    expect(() => assertNoLeaks(state, state, 'p0')).toThrow(/Information leak/);
  });

  it('shows the viewer their own hand with real ids and hides the opponent hand', () => {
    // Tests Rule 128: Hand is Private to its owner, count is public
    for (const seed of SEEDS) {
      const state = makeState(seed);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        const me = state.players[v === 'p0' ? 0 : 1];
        const opp = state.players[v === 'p0' ? 1 : 0];
        const vme = view.players[v === 'p0' ? 0 : 1];
        const vopp = view.players[v === 'p0' ? 1 : 0];
        expect(vme.hand).toEqual(me.hand);
        for (const id of me.hand) {
          expect(view.objects[id]).toEqual(state.objects[id]);
        }
        expect(vopp.hand).toHaveLength(opp.hand.length);
        for (const token of vopp.hand) {
          const o = view.objects[token];
          expect(o && isHiddenCard(o)).toBe(true);
          expect(o).toEqual({ hidden: true, owner: opp.id });
        }
        for (const id of opp.hand) expect(view.objects[id]).toBeUndefined();
      }
    }
  });

  it('hides both decks from both players but exposes counts', () => {
    // Tests Rule 128: Main Deck and Rune Deck are Secret (even to the owner), count is public
    for (const seed of SEEDS.slice(0, 100)) {
      const state = makeState(seed);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        state.players.forEach((p, i) => {
          const vp = view.players[i]!;
          expect(vp.handCount).toBe(p.hand.length);
          expect(vp.mainDeckCount).toBe(p.mainDeck.length);
          expect(vp.runeDeckCount).toBe(p.runeDeck.length);
          expect(vp.mainDeck).toHaveLength(p.mainDeck.length);
          expect(vp.runeDeck).toHaveLength(p.runeDeck.length);
          for (const id of [...p.mainDeck, ...p.runeDeck]) expect(view.objects[id]).toBeUndefined();
          for (const t of [...vp.mainDeck, ...vp.runeDeck]) {
            expect(isHiddenCard(view.objects[t]!)).toBe(true);
          }
        });
      }
    }
  });

  it('keeps public zones fully visible', () => {
    // Tests Rule 128: Trash, Banishment, Base, Legend, Champion zone and Chain are Public
    for (const seed of SEEDS.slice(0, 100)) {
      const state = makeState(seed);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        state.players.forEach((p, i) => {
          const vp = view.players[i]!;
          expect(vp.trash).toEqual(p.trash);
          expect(vp.banishment).toEqual(p.banishment);
          expect(vp.base).toEqual(p.base);
          expect(vp.legend).toEqual(p.legend);
          expect(vp.championZone).toEqual(p.championZone);
          expect(vp.points).toBe(p.points);
          expect(vp.runePool).toEqual(p.runePool);
          for (const id of [...p.trash, ...p.banishment, ...p.base, ...p.championZone]) {
            expect(view.objects[id]).toEqual(state.objects[id]);
          }
          if (p.legend) expect(view.objects[p.legend]).toEqual(state.objects[p.legend]);
        });
        expect(view.flow.chain).toEqual(state.flow.chain);
      }
    }
  });

  it('shows a facedown card only to its controller; the zone itself stays public', () => {
    // Tests Rule 128: Facedown zone is public, its cards are Private to the controller
    let seen = 0;
    for (const seed of SEEDS) {
      const state = makeState(seed);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        state.battlefields.forEach((bf, i) => {
          const vbf = view.battlefields[i]!;
          if (bf.facedownSlotId === null) {
            expect(vbf.facedownSlotId).toBeNull();
            return;
          }
          seen++;
          const obj = state.objects[bf.facedownSlotId]!;
          expect(vbf.facedownSlotId).not.toBeNull();
          if (obj.controller === v) {
            expect(vbf.facedownSlotId).toBe(bf.facedownSlotId);
            expect(view.objects[bf.facedownSlotId]).toEqual(obj);
          } else {
            expect(vbf.facedownSlotId).not.toBe(bf.facedownSlotId);
            expect(view.objects[vbf.facedownSlotId!]).toEqual({ hidden: true, owner: obj.owner });
            expect(view.objects[bf.facedownSlotId]).toBeUndefined();
          }
        });
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('strips rng, seed and counters and adds viewer; passes through public fields', () => {
    // Tests Rule 128: engine internals are never sent; public game info passes through
    const state = makeState(3);
    state.winner = 'p1';
    state.gameStatus = 'FINISHED';
    const view = sanitizeFor(state, 'p1') as unknown as Record<string, unknown>;
    for (const k of ['rng', 'seed', 'nextObjectId', 'nextEventSeq']) expect(k in view).toBe(false);
    expect(view.viewer).toBe('p1');
    expect(view.winner).toBe('p1');
    expect(view.gameStatus).toBe('FINISHED');
    expect(view.turn).toEqual(state.turn);
    expect(view.turnState).toEqual(state.turnState);
    expect(view.victoryScore).toBe(state.victoryScore);
  });

  it('renumbers hidden tokens from position only, independent of card identity', () => {
    // Tests Rule 128: deck order is Secret, so tokens depend only on position, not on the card
    const a = makeState(11);
    const b = structuredClone(a);
    const deck = b.players[0].mainDeck;
    // Reverse the order of the real deck: the view must be unchanged.
    deck.reverse();
    const va = sanitizeFor(a, 'p1').players[0].mainDeck;
    const vb = sanitizeFor(b, 'p1').players[0].mainDeck;
    expect(vb).toEqual(va);
    expect(va[0]).toBe('hidden:p0:mainDeck:0');
  });

  it('does not mutate its input and shares no references with it', () => {
    // Tests Rule 128: the returned view is an independent copy
    for (const seed of SEEDS.slice(0, 50)) {
      const state = makeState(seed);
      const snapshot = structuredClone(state);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        expect(state).toEqual(snapshot);
        // Scribble all over the view.
        for (const o of Object.values(view.objects)) {
          if (!isHiddenCard(o)) {
            o.damage = 999;
            o.zone = { kind: 'trash', player: 'p0' };
          }
        }
        view.players.forEach((p) => {
          p.hand.push('x');
          p.base.push('x');
          p.trash.length = 0;
          p.runePool.energy = 123;
        });
        view.battlefields.forEach((bf) => bf.scoredThisTurnBy.push('p0'));
        view.flow.chain.forEach((c) => {
          c.targets.length = 0;
          c.choices.x = 1;
        });
        view.turn.number = 999;
        expect(state).toEqual(snapshot);
      }
    }
  });

  it('is JSON-serializable and round-trips', () => {
    // Tests Rule 128: views are plain data
    for (const seed of SEEDS.slice(0, 50)) {
      const state = makeState(seed);
      for (const v of VIEWERS) {
        const view = sanitizeFor(state, v);
        expect(JSON.parse(JSON.stringify(view))).toEqual(view);
      }
    }
  });

  it('does not flag a hidden cardId that is legitimately visible elsewhere', () => {
    // Tests Rule 128: only identities the viewer cannot see anywhere count as leaks
    const state = makeState(5);
    const opp = state.players[1];
    const hiddenId = opp.hand[0] ?? opp.mainDeck[0]!;
    const cardId = state.objects[hiddenId]!.cardId;
    const publicId = state.players[1].base[0];
    if (publicId) state.objects[publicId]!.cardId = cardId;
    else {
      const id = 'extra-public';
      state.objects[id] = { ...state.objects[hiddenId]!, id, zone: { kind: 'base', player: 'p1' } };
      state.players[1].base.push(id);
    }
    const view = sanitizeFor(state, 'p0');
    expect(findLeaks(view, state, 'p0')).toEqual([]);
  });

  it('detects hidden card names via the optional name map', () => {
    // Tests Rule 128: hidden card names must not appear either
    const state = makeState(9);
    const hid = state.players[1].mainDeck[0]!;
    const cardId = state.objects[hid]!.cardId;
    const leaks = findLeaks({ log: 'Opponent has Sneaky Name' }, state, 'p0', {
      cardNames: { [cardId]: 'Sneaky Name' },
    });
    // Only a leak if the cardId is not visible elsewhere; ensure by construction.
    const visibleElsewhere = Object.values(state.objects).some(
      (o) => o.cardId === cardId && canViewerSeeObject(o, 'p0'),
    );
    expect(leaks.some((l) => l.includes('Sneaky Name'))).toBe(!visibleElsewhere);
  });
});

describe('sanitizeEvents', () => {
  const events: GameEvent[] = [
    { seq: 1, type: 'CARD_DRAWN', player: 'p0', cardInstanceId: 'obj-secret-1', visibleTo: ['p0'] },
    { seq: 2, type: 'CARD_DRAWN', player: 'p0', cardInstanceId: 'obj-secret-2' },
    { seq: 3, type: 'PHASE_CHANGED', player: 'p1', turn: 2, phase: 'MAIN' },
    { seq: 4, type: 'CARD_PLAYED', player: 'p1', cardInstanceId: 'obj-9', cardId: 'ogn-001-298' },
  ];

  it('drops events not visible to the viewer', () => {
    // Tests Rule 128: owner-only events are not delivered to the opponent
    expect(sanitizeEvents(events, 'p1').map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(sanitizeEvents(events, 'p0').map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('redacts the drawn card id of a public CARD_DRAWN for the opponent only', () => {
    // Tests Rule 128: the opponent learns that a card was drawn, not which
    const forOpp = sanitizeEvents(events, 'p1');
    expect(JSON.stringify(forOpp)).not.toContain('obj-secret');
    const forOwner = sanitizeEvents(events, 'p0');
    expect(JSON.stringify(forOwner)).toContain('obj-secret-1');
    expect(JSON.stringify(forOwner)).toContain('obj-secret-2');
  });

  it('does not mutate the input events', () => {
    // Tests Rule 128: event sanitization is pure
    const snapshot = structuredClone(events);
    sanitizeEvents(events, 'p1');
    expect(events).toEqual(snapshot);
  });
});
