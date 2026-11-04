import { describe, it, expect } from 'vitest';
import { checkInvariants } from './invariants.js';
import { getLegalActions } from './legalActions.js';
import { actorToAct, reduce } from './reducer.js';
import { sanitizeEvents, sanitizeFor } from './sanitize.js';
import { createGame } from './setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import { findLeaks } from './testing/leakCheck.js';
import type {
  CardDatabase,
  CardDef,
  DeckList,
  GameState,
  Intent,
  PlayerId,
} from './types/index.js';

/** Fixture database plus units exercising Hidden, Temporary and Accelerate (the fixtures have none). */
const extra = (
  cardId: string,
  name: string,
  domain: 'Fury' | 'Calm' | 'Mind' | 'Order',
  kw: CardDef['keywords'],
): CardDef => ({
  cardId,
  name,
  type: 'UNIT',
  subtypes: [],
  cost: { energy: 2 },
  domains: [domain],
  stats: { might: 2 },
  keywords: kw,
  text: '',
  supportLevel: 'full',
});
const CARDS: CardDatabase = {
  ...FIXTURE_CARDS,
  'fz-hidden-a': extra('fz-hidden-a', 'Lurker A', 'Fury', [{ name: 'Hidden' }]),
  'fz-temp-a': extra('fz-temp-a', 'Fleeting A', 'Calm', [{ name: 'Temporary' }]),
  'fz-accel-a': extra('fz-accel-a', 'Rusher A', 'Fury', [{ name: 'Accelerate' }]),
  'fz-hidden-b': extra('fz-hidden-b', 'Lurker B', 'Mind', [{ name: 'Hidden' }]),
  'fz-temp-b': extra('fz-temp-b', 'Fleeting B', 'Order', [{ name: 'Temporary' }]),
  'fz-accel-b': extra('fz-accel-b', 'Rusher B', 'Mind', [{ name: 'Accelerate' }]),
};
const swap = (deck: DeckList, from: string, to: string): DeckList => ({
  ...deck,
  mainDeck: deck.mainDeck.map((c) => (c === from ? to : c)),
});
const DECK_A = swap(
  swap(swap(FIXTURE_DECK_A, 'fx-wisp', 'fz-hidden-a'), 'fx-plain-spell', 'fz-temp-a'),
  'fx-raider',
  'fz-accel-a',
);
const DECK_B = swap(
  swap(swap(FIXTURE_DECK_B, 'fx-wisp', 'fz-hidden-b'), 'fx-plain-spell', 'fz-temp-b'),
  'fx-tide-archer',
  'fz-accel-b',
);

const CARD_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(CARDS).map((c) => [c.cardId, c.name]),
);

/** mulberry32: tiny seeded PRNG, independent of the engine's own RNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP_CAP = 3000;
const MAX_ACTIONS_PER_TURN = 14;

interface GameStats {
  finished: boolean;
  aborted: boolean;
  steps: number;
  turns: number;
  actions: Record<string, number>;
  winner?: PlayerId;
}

const WEIGHT: Record<string, number> = {
  PLAY_CARD: 6,
  STANDARD_MOVE: 6,
  HIDE_CARD: 3,
  EQUIP: 3,
  ASSIGN_COMBAT_DAMAGE: 1,
  PASS_PRIORITY: 3,
  END_TURN: 1,
  MULLIGAN: 1,
};

function pick(rand: () => number, actions: Intent[], actionsThisTurn: number): Intent {
  const end = actions.find((a) => a.type === 'END_TURN');
  if (end && actionsThisTurn >= MAX_ACTIONS_PER_TURN) return end;
  const total = actions.reduce((n, a) => n + (WEIGHT[a.type] ?? 1), 0);
  let r = rand() * total;
  for (const a of actions) {
    r -= WEIGHT[a.type] ?? 1;
    if (r <= 0) return a;
  }
  return actions[actions.length - 1] as Intent;
}

function playGame(seedNum: number, checkEvery = 25): { stats: GameStats; final: GameState } {
  const rand = prng(seedNum * 7919 + 13);
  let state = createGame(CARDS, [DECK_A, DECK_B], `fuzz-${seedNum}`);
  const objectCount = Object.keys(state.objects).length;
  const stats: GameStats = {
    finished: false,
    aborted: false,
    steps: 0,
    turns: 0,
    actions: {},
  };
  let lastSeq = 0;
  let turnSeen = -1;
  let actionsThisTurn = 0;

  for (let step = 0; step < STEP_CAP && state.gameStatus === 'IN_PROGRESS'; step++) {
    if (state.turn.number !== turnSeen) {
      turnSeen = state.turn.number;
      actionsThisTurn = 0;
    }
    let actor = actorToAct(state);
    let actions = getLegalActions(state, CARDS, actor);
    if (actions.length === 0) {
      actor = actor === 'p0' ? 'p1' : 'p0';
      actions = getLegalActions(state, CARDS, actor);
    }
    expect(actions.length, `seed ${seedNum} step ${step}: nobody can act`).toBeGreaterThan(0);

    if (step % 8 === 0) {
      // every listed action must also pass the FULL reduce (including Cleanup)
      for (const a of actions) expect(reduce(state, CARDS, a).ok, JSON.stringify(a)).toBe(true);
    }
    const chosen = pick(rand, actions, actionsThisTurn);
    const fromFacedown =
      chosen.type === 'PLAY_CARD' && state.objects[chosen.cardInstanceId]?.zone.kind === 'facedown';
    const res = reduce(state, CARDS, chosen);
    expect(
      res.ok,
      `seed ${seedNum} step ${step}: ${JSON.stringify(chosen)} -> ${JSON.stringify(res)}`,
    ).toBe(true);
    if (!res.ok) break;

    // event seq strictly increasing and consistent with nextEventSeq
    for (const e of res.events) {
      expect(e.seq).toBeGreaterThan(lastSeq);
      lastSeq = e.seq;
    }
    if (res.events.length > 0) expect(lastSeq).toBe(res.state.nextEventSeq - 1);
    state = res.state;
    // events are judged against the state they produced (ids may legitimately become hidden later)
    for (const viewer of ['p0', 'p1'] as const) {
      const evs = sanitizeEvents(res.events, viewer);
      expect(
        findLeaks(evs, state, viewer, { cardNames: CARD_NAMES }),
        `seed ${seedNum} step ${step} events`,
      ).toEqual([]);
    }
    stats.steps++;
    stats.actions[chosen.type] = (stats.actions[chosen.type] ?? 0) + 1;
    if (fromFacedown) stats.actions.PLAY_FACEDOWN = (stats.actions.PLAY_FACEDOWN ?? 0) + 1;
    actionsThisTurn++;

    const bad = checkInvariants(state, CARDS);
    expect(bad, `seed ${seedNum} step ${step} after ${JSON.stringify(chosen)}`).toEqual([]);
    expect(Object.keys(state.objects).length).toBe(objectCount);

    if (step % checkEvery === 0) {
      for (const viewer of ['p0', 'p1'] as const) {
        const view = sanitizeFor(state, viewer);
        expect(findLeaks(view, state, viewer, { cardNames: CARD_NAMES })).toEqual([]);
      }
    }
  }
  stats.finished = state.gameStatus === 'FINISHED';
  stats.aborted = state.gameStatus === 'ABORTED';
  stats.turns = state.turn.number;
  if (state.winner) stats.winner = state.winner;
  return { stats, final: state };
}

describe('fuzz: seeded random play through reduce()', () => {
  it('plays 40 seeded games without exceptions, aborts or invariant violations', () => {
    // Tests Rule 322: the cleanup loop always stabilises; invariants hold after every action
    const all: GameStats[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const { stats } = playGame(seed);
      expect(stats.aborted, `seed ${seed} aborted`).toBe(false);
      all.push(stats);
    }
    const finished = all.filter((s) => s.finished).length;
    const capped = all.filter((s) => !s.finished).length;
    const totals: Record<string, number> = {};
    for (const s of all)
      for (const [k, n] of Object.entries(s.actions)) totals[k] = (totals[k] ?? 0) + n;
    const turns = all.map((s) => s.turns);
    (globalThis as { console?: { log(s: string): void } }).console?.log(
      `FUZZ finished=${finished} capped=${capped} turns(min/avg/max)=${Math.min(...turns)}/${Math.round(
        turns.reduce((a, b) => a + b, 0) / turns.length,
      )}/${Math.max(...turns)} steps(avg)=${Math.round(
        all.reduce((a, s) => a + s.steps, 0) / all.length,
      )} actions=${JSON.stringify(totals)}`,
    );
    expect(finished).toBeGreaterThan(0);
    expect(totals.PLAY_CARD).toBeGreaterThan(0);
    expect(totals.STANDARD_MOVE).toBeGreaterThan(0);
    expect(totals.END_TURN).toBeGreaterThan(0);
  }, 120_000);

  it('is deterministic: the same seed yields an identical final state', () => {
    // Tests Rule 115: setup and play are reproducible from the seed alone
    for (const seed of [3, 11, 27]) {
      const a = playGame(seed, 1000).final;
      const b = playGame(seed, 1000).final;
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  }, 60_000);
});
