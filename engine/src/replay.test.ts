import { describe, it, expect } from 'vitest';
import { getLegalActions } from './legalActions.js';
import { actorToAct, reduce } from './reducer.js';
import {
  ReplayError,
  canonicalJson,
  makeReplayLog,
  playLog,
  replayGame,
  resumeGame,
  stateHash,
} from './replay.js';
import type { ReplayLog } from './replay.js';
import { createGame } from './setup.js';
import { SCENARIO_CARDS, SCENARIO_DECK_A, SCENARIO_DECK_B } from './testing/scenario.js';
import type { DeckList, GameEvent, GameState, Intent } from './types/index.js';

const CARDS = SCENARIO_CARDS;
const DECKS: [DeckList, DeckList] = [SCENARIO_DECK_A, SCENARIO_DECK_B];

/** mulberry32, independent of the engine RNG. */
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

interface Recording {
  seed: string;
  intents: Intent[];
  events: GameEvent[];
  /** State after each applied intent (index i = after intent i + 1). */
  states: GameState[];
  final: GameState;
}

/** Play a seeded random game through reduce, recording the accepted intents. */
function record(seedNum: number, maxSteps = 400): Recording {
  const rand = prng(seedNum * 104729 + 7);
  const seed = `replay-${seedNum}`;
  let state = createGame(CARDS, DECKS, seed);
  const rec: Recording = { seed, intents: [], events: [], states: [], final: state };
  let actionsThisTurn = 0;
  let turnSeen = -1;
  for (let step = 0; step < maxSteps && state.gameStatus === 'IN_PROGRESS'; step++) {
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
    const end = actions.find((a) => a.type === 'END_TURN');
    const chosen =
      end && actionsThisTurn >= 8 ? end : (actions[Math.floor(rand() * actions.length)] as Intent);
    const r = reduce(state, CARDS, chosen);
    if (!r.ok) throw new Error(`recording step ${step}: ${r.message}`);
    state = r.state;
    rec.intents.push(chosen);
    rec.events.push(...r.events);
    rec.states.push(state);
    actionsThisTurn++;
  }
  rec.final = state;
  return rec;
}

/** Setup events of a fresh game (replayGame prepends them to the stream). */
function setupEvents(seed: string): GameEvent[] {
  const probe = replayGame(CARDS, DECKS, seed, []);
  return probe.events;
}

describe('stateHash', () => {
  it('ignores key order and undefined members but sees real changes', () => {
    // Tests Rule 115: a game state is fully determined by its content, not by object key order
    const a = { x: 1, y: { p: [1, 2], q: 'z' }, u: undefined };
    const b = { y: { q: 'z', p: [1, 2] }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const s = createGame(CARDS, DECKS, 'hash');
    const h = stateHash(s);
    expect(h).toMatch(/^[0-9a-f]{14}$/);
    expect(stateHash(structuredClone(s))).toBe(h);
    const t = structuredClone(s);
    (t.players[0] as { points: number }).points = 1;
    expect(stateHash(t)).not.toBe(h);
  });
});

describe('replay', () => {
  it('replays a recorded random game to an identical state hash and event stream', () => {
    // Tests Rule 115: setup and play are reproducible from the seed and the intent list alone
    for (const n of [1, 2, 3]) {
      const rec = record(n);
      expect(rec.intents.length).toBeGreaterThan(50);
      const replayed = replayGame(CARDS, DECKS, rec.seed, rec.intents);
      expect(stateHash(replayed.state)).toBe(stateHash(rec.final));
      expect(replayed.state).toEqual(rec.final);
      expect(replayed.events).toEqual([...setupEvents(rec.seed), ...rec.events]);
    }
  }, 60_000);

  it('records the same checkpoint hashes on every replay and matches the live game', () => {
    // Tests Rule 115: replay is deterministic at every step, not only at the end
    const rec = record(4);
    const a = replayGame(CARDS, DECKS, rec.seed, rec.intents, { checkpointEvery: 10 });
    const b = replayGame(CARDS, DECKS, rec.seed, rec.intents, { checkpointEvery: 10 });
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes?.length).toBe(Math.floor(rec.intents.length / 10));
    for (const h of a.hashes ?? []) {
      expect(h.hash).toBe(stateHash(rec.states[h.step - 1] as GameState));
    }
    expect(replayGame(CARDS, DECKS, rec.seed, rec.intents).hashes).toBeUndefined();
    expect(() => replayGame(CARDS, DECKS, rec.seed, [], { checkpointEvery: 0 })).toThrow(
      /checkpointEvery/,
    );
  });

  it('every state of a real game survives a JSON round trip unchanged', () => {
    // Tests Rule 107: the whole game state is plain data (no Map/Set/undefined pitfalls)
    const rec = record(5);
    rec.states.forEach((s, i) => {
      const round = JSON.parse(JSON.stringify(s)) as GameState;
      // toStrictEqual also distinguishes `{a: undefined}` from `{}`
      expect(round, `state after intent ${i + 1}`).toStrictEqual(s);
    });
    const start = createGame(CARDS, DECKS, rec.seed);
    expect(JSON.parse(JSON.stringify(start))).toStrictEqual(start);
  });

  it('resumes from a mid-game JSON checkpoint to the same final state and events', () => {
    // Tests Rule 115: event sourcing plus checkpoint persistence gives the same game
    const rec = record(6);
    for (const k of [1, 17, Math.floor(rec.intents.length / 2), rec.intents.length - 1]) {
      const checkpoint = JSON.parse(JSON.stringify(rec.states[k - 1])) as GameState;
      const rest = rec.intents.slice(k);
      const resumed = resumeGame(CARDS, checkpoint, rest);
      expect(stateHash(resumed.state), `from step ${k}`).toBe(stateHash(rec.final));
      expect(resumed.state).toStrictEqual(rec.final);
      const liveEvents = rec.events.filter(
        (e) => e.seq >= (rec.states[k - 1] as GameState).nextEventSeq,
      );
      expect(resumed.events).toEqual(liveEvents);
    }
  });

  it('throws a descriptive ReplayError when a recorded intent is rejected', () => {
    // Tests Rule 117: a mulligan out of turn order is rejected, so a corrupted log is detected
    const rec = record(7);
    const bad: Intent[] = [
      { type: 'MULLIGAN', playerId: 'p1', cardIds: [] },
      ...rec.intents.slice(1),
    ];
    let caught: unknown;
    try {
      replayGame(CARDS, DECKS, rec.seed, bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReplayError);
    const err = caught as ReplayError;
    expect(err.step).toBe(1);
    expect(err.code).toBe('MULLIGAN_ORDER');
    expect(err.message).toContain('intent #1');
    expect(err.message).toContain('MULLIGAN by p1');
    expect(err.message).toContain('MULLIGAN_ORDER');
  });

  it('plays a persisted ReplayLog and refuses a log from another engine version', () => {
    // Tests Rule 100: the log carries the engine version so peers never replay across versions
    const rec = record(8, 120);
    const log = makeReplayLog(rec.seed, DECKS, rec.intents);
    const wire = JSON.parse(JSON.stringify(log)) as ReplayLog;
    expect(playLog(CARDS, wire).state).toStrictEqual(rec.final);
    expect(() => playLog(CARDS, { ...wire, engineVersion: '0.0.0-old' })).toThrow(/engine/);
    // the log is a deep copy
    (log.intents[0] as { cardIds: string[] }).cardIds.push('x');
    expect((rec.intents[0] as { cardIds: string[] }).cardIds).not.toContain('x');
  });
});
