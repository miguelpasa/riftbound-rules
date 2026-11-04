import { describe, it, expect } from 'vitest';
import {
  ENGINE_VERSION,
  VICTORY_SCORE,
  DOMAINS,
  type CardDatabase,
  type CardDef,
  type CardInstance,
  type Domain,
  type GameState,
  type PaymentPlan,
  type PlayerId,
  type PlayerState,
} from './types/index.js';
import {
  activateRune,
  autoPlan,
  canAfford,
  computeTotalCost,
  emptyAllRunePools,
  emptyRunePool,
  getPlayerRunes,
  payCost,
  type TotalCost,
} from './resources.js';

// ---- local helpers -------------------------------------------------------------------

function def(over: Partial<CardDef> & { cardId: string }): CardDef {
  return {
    name: over.cardId,
    type: 'UNIT',
    subtypes: [],
    cost: { energy: 0 },
    domains: [],
    stats: {},
    keywords: [],
    text: '',
    supportLevel: 'full',
    ...over,
  };
}

const CARDS: CardDatabase = {};
for (const d of DOMAINS) {
  CARDS[`rune-${d}`] = def({ cardId: `rune-${d}`, type: 'RUNE', domains: [d] });
}
CARDS['rune-none'] = def({ cardId: 'rune-none', type: 'RUNE' });
CARDS['unit'] = def({ cardId: 'unit', type: 'UNIT' });

interface RuneSpec {
  id: string;
  domain: Domain | 'none';
  ready?: boolean;
}

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

function makeState(
  runes: RuneSpec[],
  pool?: { energy?: number; power?: Partial<Record<Domain, number>> },
  owner: PlayerId = 'p0',
): GameState {
  const state: GameState = {
    engineVersion: ENGINE_VERSION,
    mode: 'DUEL',
    victoryScore: VICTORY_SCORE,
    players: [player('p0'), player('p1')],
    objects: {},
    battlefields: [],
    seed: { seed: 't' },
    rng: { s: [1, 2, 3, 4] },
    turn: { number: 1, activePlayer: 'p0', phase: 'MAIN', step: 'NONE' },
    turnState: { kind: 'NEUTRAL', open: true },
    flow: {
      priority: null,
      focus: null,
      chain: [],
      stagedShowdowns: [],
      stagedCombats: [],
      cleanupIterations: 0,
    },
    mulligan: null,
    gameStatus: 'IN_PROGRESS',
    nextObjectId: 100,
    nextEventSeq: 1,
  };
  const p = state.players[owner === 'p0' ? 0 : 1];
  for (const r of runes) {
    const inst: CardInstance = {
      id: r.id,
      cardId: r.domain === 'none' ? 'rune-none' : `rune-${r.domain}`,
      owner,
      controller: owner,
      zone: { kind: 'base', player: owner },
      ready: r.ready ?? true,
      damage: 0,
      mightBonus: 0,
    };
    state.objects[r.id] = inst;
    p.base.push(r.id);
  }
  // an existing rune deck so "bottom" is observable
  for (const id of ['d1', 'd2']) {
    state.objects[id] = {
      id,
      cardId: 'rune-Fury',
      owner,
      controller: owner,
      zone: { kind: 'runeDeck', player: owner },
      ready: true,
      damage: 0,
      mightBonus: 0,
    };
    p.runeDeck.push(id);
  }
  if (pool) p.runePool = { energy: pool.energy ?? 0, power: { ...(pool.power ?? {}) } };
  return state;
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok).toBe(true);
  return r as Extract<T, { ok: true }>;
}

const cost = (energy: number, ...power: TotalCost['power']): TotalCost => ({ energy, power });

// ---- computeTotalCost ----------------------------------------------------------------

describe('computeTotalCost', () => {
  it('reads energy and domain power from the card', () => {
    // Tests Rule 356.1: total cost starts from the base cost
    const c = def({
      cardId: 'x',
      cost: { energy: 3, domain: [{ element: 'Fury', amount: 2 }] },
      domains: ['Fury'],
    });
    expect(computeTotalCost(c)).toEqual({ energy: 3, power: [{ domain: 'Fury', amount: 2 }] });
  });

  it('colorless card with a generic Power cost can be paid with any domain', () => {
    // Tests Rule 135.2.e.5: Power cost with no Domain is paid with any domain
    const c = def({ cardId: 'x', cost: { energy: 1, power: 1 }, domains: [] });
    expect(computeTotalCost(c).power).toEqual([{ domain: 'ANY', amount: 1 }]);
  });

  it('multi-domain generic Power may be paid with any of the card domains', () => {
    // Tests Rule 135.2.e.6: [C] on a multi-domain card uses any of its domains
    const c = def({ cardId: 'x', cost: { energy: 0, power: 2 }, domains: ['Fury', 'Calm'] });
    expect(computeTotalCost(c).power).toEqual([{ domain: 'ANY', amount: 2, of: ['Fury', 'Calm'] }]);
  });

  it('Accelerate adds 1 Energy and 1 Power of one of the unit domains', () => {
    // Tests Rule 356.2.b: Accelerate additional cost
    const c = def({ cardId: 'x', cost: { energy: 2 }, domains: ['Mind', 'Body'] });
    const t = computeTotalCost(c, { accelerate: true });
    expect(t.energy).toBe(3);
    expect(t.power).toEqual([{ domain: 'ANY', amount: 1, of: ['Mind', 'Body'] }]);
  });

  it('applies increases before discounts and clamps at zero', () => {
    // Tests Rule 356.6: costs never go below 0, increases then discounts
    const c = def({ cardId: 'x', cost: { energy: 2, power: 1 }, domains: ['Order'] });
    const t = computeTotalCost(c, {
      increases: [{ energy: 1 }],
      discounts: [{ energy: 10, power: 5 }],
    });
    expect(t).toEqual({ energy: 0, power: [] });
    const u = computeTotalCost(c, {
      increases: [{ energy: 2, power: 1 }],
      discounts: [{ energy: 1 }],
    });
    expect(u).toEqual({ energy: 3, power: [{ domain: 'Order', amount: 2 }] });
  });

  it('does not mutate the card definition', () => {
    // Tests Rule 356: determination is a pure computation
    const c = def({ cardId: 'x', cost: { energy: 2, domain: [{ element: 'Fury', amount: 1 }] } });
    const snap = structuredClone(c);
    computeTotalCost(c, { accelerate: true, discounts: [{ power: 1 }] });
    expect(c).toEqual(snap);
  });
});

// ---- activateRune --------------------------------------------------------------------

describe('activateRune', () => {
  it('exhausting a ready rune adds 1 Energy', () => {
    // Tests Rule 164.2.a: [E]: Add [1]
    const s = makeState([{ id: 'r1', domain: 'Fury' }]);
    const r = ok(
      activateRune(s, CARDS, {
        type: 'ACTIVATE_RUNE',
        playerId: 'p0',
        runeId: 'r1',
        mode: 'EXHAUST',
      }),
    );
    expect(r.state.players[0].runePool.energy).toBe(1);
    expect(r.state.objects['r1']?.ready).toBe(false);
    expect(r.state.players[0].base).toContain('r1');
  });

  it('an exhausted rune cannot be exhausted again', () => {
    // Tests Rule 164.2.a: exhaust requires a ready rune
    const s = makeState([{ id: 'r1', domain: 'Fury', ready: false }]);
    const r = activateRune(s, CARDS, {
      type: 'ACTIVATE_RUNE',
      playerId: 'p0',
      runeId: 'r1',
      mode: 'EXHAUST',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNIT_EXHAUSTED');
  });

  it('recycling adds 1 Power of the domain, removes from base, appends to the rune deck bottom', () => {
    // Tests Rule 164.2.b: recycle for Power; Rule 417.1.a-b bottom of the Rune Deck
    const s = makeState([
      { id: 'r1', domain: 'Calm' },
      { id: 'r2', domain: 'Fury' },
    ]);
    const r = ok(
      activateRune(s, CARDS, {
        type: 'ACTIVATE_RUNE',
        playerId: 'p0',
        runeId: 'r1',
        mode: 'RECYCLE',
      }),
    );
    const p = r.state.players[0];
    expect(p.runePool.power).toEqual({ Calm: 1 });
    expect(p.base).toEqual(['r2']);
    expect(p.runeDeck).toEqual(['d1', 'd2', 'r1']);
    expect(r.state.objects['r1']?.zone).toEqual({ kind: 'runeDeck', player: 'p0' });
    expect(r.events).toEqual([]);
  });

  it('an exhausted rune can still be recycled', () => {
    // Tests Rule 164.2.b: the cost is Recycle, so readiness does not matter
    const s = makeState([{ id: 'r1', domain: 'Body', ready: false }]);
    const r = ok(
      activateRune(s, CARDS, {
        type: 'ACTIVATE_RUNE',
        playerId: 'p0',
        runeId: 'r1',
        mode: 'RECYCLE',
      }),
    );
    expect(r.state.players[0].runePool.power).toEqual({ Body: 1 });
  });

  it('rejects unknown, foreign, non-rune, off-base and domainless runes', () => {
    // Tests Rule 164.2: only your own runes on your base can be activated
    const s = makeState([
      { id: 'r1', domain: 'Fury' },
      { id: 'rn', domain: 'none' },
    ]);
    s.objects['u1'] = { ...(s.objects['r1'] as CardInstance), id: 'u1', cardId: 'unit' };
    const act = (playerId: PlayerId, runeId: string, mode: 'EXHAUST' | 'RECYCLE' = 'EXHAUST') =>
      activateRune(s, CARDS, { type: 'ACTIVATE_RUNE', playerId, runeId, mode });
    const code = (r: ReturnType<typeof act>) => (r.ok ? 'OK' : r.code);
    expect(code(act('p0', 'nope'))).toBe('NOT_FOUND');
    expect(code(act('p1', 'r1'))).toBe('NOT_OWNED');
    expect(code(act('p0', 'u1'))).toBe('WRONG_CARD_TYPE');
    expect(code(act('p0', 'd1'))).toBe('ABILITY_NOT_AVAILABLE');
    expect(code(act('p0', 'rn', 'RECYCLE'))).toBe('ABILITY_NOT_AVAILABLE');
    expect(code(act('p0', 'rn', 'EXHAUST'))).toBe('OK');
  });

  it('does not mutate the input state and is deterministic', () => {
    // Tests Rule 164.2: pure reducer step
    const s = makeState([{ id: 'r1', domain: 'Fury' }]);
    const snap = structuredClone(s);
    const i = { type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: 'r1', mode: 'RECYCLE' } as const;
    const a = ok(activateRune(s, CARDS, i));
    const b = ok(activateRune(s, CARDS, i));
    expect(s).toEqual(snap);
    expect(a).toEqual(b);
  });
});

// ---- payCost -------------------------------------------------------------------------

describe('payCost', () => {
  it('applies the plan into the pool then pays Energy and domain Power', () => {
    // Tests Rule 357.1.a: costs paid using Reaction rune abilities first
    const s = makeState([
      { id: 'e1', domain: 'Fury' },
      { id: 'e2', domain: 'Fury' },
      { id: 'p1', domain: 'Calm' },
    ]);
    const plan: PaymentPlan = [
      { runeId: 'e1', mode: 'EXHAUST' },
      { runeId: 'e2', mode: 'EXHAUST' },
      { runeId: 'p1', mode: 'RECYCLE' },
    ];
    const r = ok(payCost(s, CARDS, 'p0', cost(2, { domain: 'Calm', amount: 1 }), plan));
    expect(r.state.players[0].runePool).toEqual({ energy: 0, power: {} });
    expect(r.state.players[0].base).toEqual(['e1', 'e2']);
  });

  it('colorless/ANY power is paid with any domain', () => {
    // Tests Rule 135.2.e.5: Power cost without a Domain accepts any domain
    const s = makeState([], { power: { Mind: 1 } });
    const r = ok(payCost(s, CARDS, 'p0', cost(0, { domain: 'ANY', amount: 1 }), []));
    expect(r.state.players[0].runePool.power).toEqual({});
  });

  it('a two-domain card can pay [C] with either domain', () => {
    // Tests Rule 135.2.e.6: [C] payable with any of the card domains
    const t = computeTotalCost(
      def({ cardId: 'x', cost: { energy: 0, power: 1 }, domains: ['Fury', 'Calm'] }),
    );
    for (const d of ['Fury', 'Calm'] as const) {
      const s = makeState([], { power: { [d]: 1 } });
      expect(payCost(s, CARDS, 'p0', t, []).ok).toBe(true);
    }
    const bad = makeState([], { power: { Body: 1 } });
    expect(payCost(bad, CARDS, 'p0', t, []).ok).toBe(false);
  });

  it('assigns restricted ANY power optimally across overlapping requirements', () => {
    // Tests Rule 135.2.e.6: matching must not fail due to a greedy choice
    const s = makeState([], { power: { Fury: 1, Calm: 1 } });
    const c = cost(
      0,
      { domain: 'ANY', amount: 1, of: ['Fury', 'Calm'] },
      { domain: 'Fury', amount: 1 },
    );
    const r = ok(payCost(s, CARDS, 'p0', c, []));
    expect(r.state.players[0].runePool.power).toEqual({});
  });

  it('Accelerate cost is payable with a Power of a unit domain', () => {
    // Tests Rule 356.2.b: Accelerate costs +1 Energy and +1 Power of a unit domain
    const unit = def({ cardId: 'u', cost: { energy: 1 }, domains: ['Mind', 'Body'] });
    const t = computeTotalCost(unit, { accelerate: true });
    const s = makeState([
      { id: 'e1', domain: 'Fury' },
      { id: 'e2', domain: 'Fury' },
      { id: 'b1', domain: 'Body' },
    ]);
    const plan = autoPlan(s, CARDS, 'p0', t);
    expect(plan).toEqual([
      { runeId: 'e1', mode: 'EXHAUST' },
      { runeId: 'e2', mode: 'EXHAUST' },
      { runeId: 'b1', mode: 'RECYCLE' },
    ]);
    ok(payCost(s, CARDS, 'p0', t, plan as PaymentPlan));
  });

  it('insufficient resources fails and leaves state unchanged', () => {
    // Tests Rule 357.1.a: unaffordable cost is rejected, state untouched
    const s = makeState([{ id: 'e1', domain: 'Fury' }]);
    const snap = structuredClone(s);
    const r = payCost(s, CARDS, 'p0', cost(2), [{ runeId: 'e1', mode: 'EXHAUST' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INSUFFICIENT_RESOURCES');
    const r2 = payCost(s, CARDS, 'p0', cost(0, { domain: 'Calm', amount: 1 }), [
      { runeId: 'e1', mode: 'RECYCLE' },
    ]);
    expect(r2.ok).toBe(false);
    expect(s).toEqual(snap);
  });

  it('rejects duplicate, foreign, exhausted-exhaust and missing runes as INVALID_PAYMENT', () => {
    // Tests Rule 164.2: only distinct, usable own runes can pay
    const s = makeState([
      { id: 'r1', domain: 'Fury' },
      { id: 'r2', domain: 'Fury', ready: false },
    ]);
    const bad = (plan: PaymentPlan, who: PlayerId = 'p0') => {
      const r = payCost(s, CARDS, who, cost(0), plan);
      return r.ok ? 'OK' : r.code;
    };
    expect(
      bad([
        { runeId: 'r1', mode: 'EXHAUST' },
        { runeId: 'r1', mode: 'RECYCLE' },
      ]),
    ).toBe('INVALID_PAYMENT');
    expect(bad([{ runeId: 'r2', mode: 'EXHAUST' }])).toBe('INVALID_PAYMENT');
    expect(bad([{ runeId: 'r1', mode: 'EXHAUST' }], 'p1')).toBe('INVALID_PAYMENT');
    expect(bad([{ runeId: 'zz', mode: 'EXHAUST' }])).toBe('INVALID_PAYMENT');
    expect(bad([{ runeId: 'r2', mode: 'RECYCLE' }])).toBe('OK');
  });

  it('overpayment leaves the surplus in the pool', () => {
    // Tests Rule 166.2: unspent resources stay in the pool until it empties
    const s = makeState([
      { id: 'e1', domain: 'Fury' },
      { id: 'e2', domain: 'Fury' },
    ]);
    const plan: PaymentPlan = [
      { runeId: 'e1', mode: 'EXHAUST' },
      { runeId: 'e2', mode: 'EXHAUST' },
    ];
    const r = ok(payCost(s, CARDS, 'p0', cost(1), plan));
    expect(r.state.players[0].runePool.energy).toBe(1);
  });

  it('is deterministic and does not mutate inputs', () => {
    // Tests Rule 357.1.a: pure payment
    const s = makeState([{ id: 'e1', domain: 'Fury' }]);
    const snap = structuredClone(s);
    const c = cost(1);
    const plan: PaymentPlan = [{ runeId: 'e1', mode: 'EXHAUST' }];
    const planSnap = structuredClone(plan);
    expect(payCost(s, CARDS, 'p0', c, plan)).toEqual(payCost(s, CARDS, 'p0', c, plan));
    expect(s).toEqual(snap);
    expect(plan).toEqual(planSnap);
    expect(c).toEqual(cost(1));
  });
});

// ---- autoPlan / canAfford ------------------------------------------------------------

describe('autoPlan and canAfford', () => {
  it('uses the existing pool first and returns an empty plan when it suffices', () => {
    // Tests Rule 166.2: resources already in the pool are spent first
    const s = makeState([{ id: 'e1', domain: 'Fury' }], { energy: 2, power: { Calm: 1 } });
    expect(autoPlan(s, CARDS, 'p0', cost(2, { domain: 'Calm', amount: 1 }))).toEqual([]);
  });

  it('exhausts for Energy and recycles only what is needed for Power', () => {
    // Tests Rule 164.2: prefer exhaust for Energy, recycle only for Power
    const s = makeState([
      { id: 'a', domain: 'Fury' },
      { id: 'b', domain: 'Calm' },
      { id: 'c', domain: 'Calm' },
    ]);
    const plan = autoPlan(s, CARDS, 'p0', cost(1, { domain: 'Calm', amount: 1 })) as PaymentPlan;
    expect(plan.filter((x) => x.mode === 'RECYCLE')).toHaveLength(1);
    expect(plan.filter((x) => x.mode === 'EXHAUST')).toHaveLength(1);
    ok(payCost(s, CARDS, 'p0', cost(1, { domain: 'Calm', amount: 1 }), plan));
  });

  it('prefers recycling exhausted runes and keeps ready ones for Energy', () => {
    // Tests Rule 164.2.b: exhausted runes can be recycled, leaving ready runes for Energy
    const s = makeState([
      { id: 'a', domain: 'Fury' },
      { id: 'b', domain: 'Fury', ready: false },
    ]);
    const plan = autoPlan(s, CARDS, 'p0', cost(1, { domain: 'Fury', amount: 1 }));
    expect(plan).toEqual([
      { runeId: 'a', mode: 'EXHAUST' },
      { runeId: 'b', mode: 'RECYCLE' },
    ]);
  });

  it('returns null when unaffordable and canAfford agrees', () => {
    // Tests Rule 357.1.a: cannot pay => cannot play
    const s = makeState([{ id: 'a', domain: 'Fury' }]);
    const c = cost(0, { domain: 'Calm', amount: 1 });
    expect(autoPlan(s, CARDS, 'p0', c)).toBeNull();
    expect(canAfford(s, CARDS, 'p0', c)).toBe(false);
    expect(canAfford(s, CARDS, 'p0', cost(1))).toBe(true);
    expect(canAfford(s, CARDS, 'p0', cost(2))).toBe(false);
  });

  it('does not count a rune twice for Energy and Power', () => {
    // Tests Rule 164.2: a rune is either exhausted or recycled
    const s = makeState([{ id: 'a', domain: 'Fury' }]);
    expect(canAfford(s, CARDS, 'p0', cost(1, { domain: 'Fury', amount: 1 }))).toBe(false);
  });

  it('property: autoPlan never yields a plan payCost rejects, and matches brute force', () => {
    // Tests Rule 357.1.a: autoPlan is sound, complete and minimal in recycles
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const dom = (): Domain => DOMAINS[rnd(3)] as Domain; // few domains => more collisions
    for (let iter = 0; iter < 400; iter++) {
      const runes: RuneSpec[] = [];
      const n = rnd(6);
      for (let i = 0; i < n; i++) runes.push({ id: `q${i}`, domain: dom(), ready: rnd(3) > 0 });
      const power: Partial<Record<Domain, number>> = {};
      if (rnd(3) === 0) power[dom()] = 1 + rnd(2);
      const s = makeState(runes, { energy: rnd(3) === 0 ? rnd(3) : 0, power });
      const reqs: TotalCost['power'] = [];
      for (let k = rnd(3); k > 0; k--) {
        const kind = rnd(3);
        if (kind === 0) reqs.push({ domain: dom(), amount: 1 + rnd(2) });
        else if (kind === 1) reqs.push({ domain: 'ANY', amount: 1 + rnd(2) });
        else reqs.push({ domain: 'ANY', amount: 1, of: [dom(), dom()] });
      }
      const c: TotalCost = { energy: rnd(4), power: reqs };

      // brute force over each rune: skip / exhaust / recycle
      let best = Infinity;
      const total = 3 ** runes.length;
      for (let m = 0; m < total; m++) {
        const plan: PaymentPlan = [];
        let x = m;
        for (const r of runes) {
          const o = x % 3;
          x = Math.floor(x / 3);
          if (o === 1) plan.push({ runeId: r.id, mode: 'EXHAUST' });
          if (o === 2) plan.push({ runeId: r.id, mode: 'RECYCLE' });
        }
        if (payCost(s, CARDS, 'p0', c, plan).ok) {
          best = Math.min(best, plan.filter((p) => p.mode === 'RECYCLE').length);
        }
      }

      const plan = autoPlan(s, CARDS, 'p0', c);
      expect(canAfford(s, CARDS, 'p0', c)).toBe(plan !== null);
      if (best === Infinity) {
        expect(plan).toBeNull();
      } else {
        expect(plan).not.toBeNull();
        expect(payCost(s, CARDS, 'p0', c, plan as PaymentPlan).ok).toBe(true);
        expect((plan as PaymentPlan).filter((p) => p.mode === 'RECYCLE').length).toBe(best);
      }
    }
  });
});

// ---- helpers & pool emptying ---------------------------------------------------------

describe('getPlayerRunes', () => {
  it('lists only controlled RUNE objects in the base and filters by readiness', () => {
    // Tests Rule 107.1.c: channeled runes live in the base alongside units
    const s = makeState([
      { id: 'a', domain: 'Fury' },
      { id: 'b', domain: 'Calm', ready: false },
    ]);
    s.objects['u1'] = { ...(s.objects['a'] as CardInstance), id: 'u1', cardId: 'unit' };
    s.players[0].base.push('u1');
    expect(getPlayerRunes(s, CARDS, 'p0').map((r) => r.id)).toEqual(['a', 'b']);
    expect(getPlayerRunes(s, CARDS, 'p0', { ready: true }).map((r) => r.id)).toEqual(['a']);
    expect(getPlayerRunes(s, CARDS, 'p0', { ready: false }).map((r) => r.id)).toEqual(['b']);
    expect(getPlayerRunes(s, CARDS, 'p1')).toEqual([]);
  });
});

describe('rune pool emptying', () => {
  it('empties one pool or both without mutating the input', () => {
    // Tests Rule 167: the Rune Pool empties and unspent resources are lost
    const s = makeState([], { energy: 3, power: { Fury: 2 } });
    s.players[1].runePool = { energy: 1, power: { Calm: 1 } };
    const snap = structuredClone(s);
    const one = emptyRunePool(s, 'p0');
    expect(one.players[0].runePool).toEqual({ energy: 0, power: {} });
    expect(one.players[1].runePool).toEqual({ energy: 1, power: { Calm: 1 } });
    const all = emptyAllRunePools(s);
    expect(all.players[0].runePool).toEqual({ energy: 0, power: {} });
    expect(all.players[1].runePool).toEqual({ energy: 0, power: {} });
    expect(s).toEqual(snap);
  });
});
