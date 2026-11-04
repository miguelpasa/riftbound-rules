import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  actorToAct,
  createGameWithEvents,
  getLegalActions,
  reduce,
  replayGame,
  sanitizeFor,
  stateHash,
  type GameState,
  type Intent,
} from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import {
  ReplayFormatError,
  ReplayPlayer,
  ReplayRecorder,
  downloadReplay,
  exportReplay,
  importReplay,
  parseReplay,
  type RecordedReplay,
} from './replayLog.js';

const SEED = 'replay-test-seed';
const DECKS = [FIXTURE_DECK_A, FIXTURE_DECK_B] as const;

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

/** Play pseudo-random legal moves from the same setup replayGame uses. Returns the accepted intents. */
function playRandomly(
  steps: number,
  rand = mulberry32(7),
): { intents: Intent[]; state: GameState } {
  let state = createGameWithEvents(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], SEED).state;
  const intents: Intent[] = [];
  for (let i = 0; i < steps; i++) {
    const legal = getLegalActions(state, FIXTURE_CARDS, actorToAct(state));
    if (legal.length === 0) break;
    const intent = legal[Math.floor(rand() * legal.length)];
    if (!intent) break;
    const r = reduce(state, FIXTURE_CARDS, intent);
    if (!r.ok) continue;
    state = r.state;
    intents.push(intent);
  }
  return { intents, state };
}

/** A finished game: some random play, then p1 concedes so p0 wins. */
function finishedGame(steps = 40) {
  const { intents, state } = playRandomly(steps);
  const concede: Intent = { type: 'CONCEDE', playerId: 'p1' };
  const end = reduce(state, FIXTURE_CARDS, concede);
  if (!end.ok) throw new Error('concede must be accepted');
  const all = [...intents, concede];
  const rec = new ReplayRecorder({
    seed: SEED,
    decks: [FIXTURE_DECK_A, FIXTURE_DECK_B],
    hostSeat: 'p0',
  });
  for (const i of all) rec.record(i);
  rec.finish('p0');
  return { rec, all, final: end.state };
}

describe('ReplayRecorder', () => {
  it('records intents and finishes with a winner', () => {
    const { rec, all } = finishedGame(10);
    const log = rec.toLog();
    expect(log.finished).toBe(true);
    expect(log.winner).toBe('p0');
    expect(log.hostSeat).toBe('p0');
    expect(log.engineVersion).toBe(ENGINE_VERSION);
    expect(log.intents).toEqual(all);
    expect(rec.intentCount).toBe(all.length);
  });

  it('refuses to record after finish and to finish twice', () => {
    const rec = new ReplayRecorder({
      seed: SEED,
      decks: [FIXTURE_DECK_A, FIXTURE_DECK_B],
      hostSeat: 'p0',
    });
    rec.finish(null);
    expect(() => rec.record({ type: 'PASS_PRIORITY', playerId: 'p0' })).toThrow(/finish/);
    expect(() => rec.finish('p1')).toThrow(/already/);
  });

  it('rejects malformed intents and empty seeds', () => {
    const rec = new ReplayRecorder({
      seed: SEED,
      decks: [FIXTURE_DECK_A, FIXTURE_DECK_B],
      hostSeat: 'p0',
    });
    expect(() => rec.record({ type: 'NOPE', playerId: 'p0' } as unknown as Intent)).toThrow(
      TypeError,
    );
    expect(() => rec.record({ type: 'END_TURN', playerId: 'p9' } as unknown as Intent)).toThrow(
      TypeError,
    );
    expect(
      () =>
        new ReplayRecorder({ seed: '', decks: [FIXTURE_DECK_A, FIXTURE_DECK_B], hostSeat: 'p0' }),
    ).toThrow(TypeError);
  });

  it('round trips through export/import and fromJSON', () => {
    const { rec } = finishedGame();
    const text = rec.toJSON();
    expect(text).toBe(exportReplay(rec.toLog()));
    expect(text).toContain('\n  "');

    const imported = importReplay(text);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.log).toEqual(rec.toLog());

    const restored = ReplayRecorder.fromJSON(text);
    expect(restored.toLog()).toEqual(rec.toLog());
    expect(restored.isFinished).toBe(true);
  });

  it('exports an unfinished recording that imports as unfinished', () => {
    const rec = new ReplayRecorder({
      seed: SEED,
      decks: [FIXTURE_DECK_A, FIXTURE_DECK_B],
      hostSeat: 'p1',
    });
    rec.record({ type: 'PASS_PRIORITY', playerId: 'p0' });
    const imported = importReplay(rec.toJSON());
    expect(imported.ok && imported.log.finished).toBe(false);
  });
});

describe('importReplay validation', () => {
  it('rejects a tampered intent through the checksum', () => {
    const { rec } = finishedGame(12);
    const doc = JSON.parse(rec.toJSON()) as { intents: Intent[] };
    const first = doc.intents[0];
    if (!first) throw new Error('expected at least one intent');
    doc.intents[0] = { ...first, playerId: first.playerId === 'p0' ? 'p1' : 'p0' };
    const res = importReplay(JSON.stringify(doc));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/checksum/);
  });

  it('rejects a tampered outcome', () => {
    const { rec } = finishedGame(5);
    const doc = JSON.parse(rec.toJSON()) as { winner: string };
    doc.winner = 'p1';
    const res = importReplay(JSON.stringify(doc));
    expect(res.ok).toBe(false);
  });

  it('rejects invalid JSON, foreign files, other engine and format versions', () => {
    const { rec } = finishedGame(3);
    const doc = JSON.parse(rec.toJSON()) as Record<string, unknown>;
    expect(importReplay('{not json').ok).toBe(false);
    expect(importReplay(JSON.stringify({ hello: 1 })).ok).toBe(false);
    expect(importReplay(JSON.stringify({ ...doc, engineVersion: '0.0.0' })).ok).toBe(false);
    expect(importReplay(JSON.stringify({ ...doc, formatVersion: 99 })).ok).toBe(false);
    expect(importReplay('[]').ok).toBe(false);
  });

  it('rejects oversized input without parsing it', () => {
    const huge = 'x'.repeat(4 * 1024 * 1024 + 1);
    const res = importReplay(huge);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exceeds/);
  });

  it('parseReplay throws ReplayFormatError', () => {
    expect(() => parseReplay('{}')).toThrow(ReplayFormatError);
  });
});

describe('ReplayPlayer', () => {
  it('reaches the same final state hash as the live game and as replayGame', () => {
    const { rec, final } = finishedGame();
    const player = new ReplayPlayer(FIXTURE_CARDS, rec.toLog());
    expect(player.totalSteps).toBe(rec.intentCount);

    const end = player.stepTo(player.totalSteps);
    expect(end.hash).toBe(stateHash(final));
    expect(end.hash).toBe(
      stateHash(replayGame(FIXTURE_CARDS, [...DECKS], SEED, rec.toLog().intents).state),
    );
    expect(end.state.gameStatus).toBe('FINISHED');
  });

  it('steps forward and backward consistently', () => {
    const { rec } = finishedGame(20);
    const log: RecordedReplay = rec.toLog();
    const player = new ReplayPlayer(FIXTURE_CARDS, log);
    const mid = Math.floor(player.totalSteps / 2);

    const atMid = player.stepTo(mid);
    expect(atMid.step).toBe(mid);
    expect(atMid.hash).toBe(
      stateHash(replayGame(FIXTURE_CARDS, [...DECKS], SEED, log.intents.slice(0, mid)).state),
    );

    const atStart = player.stepTo(0);
    expect(atStart.hash).toBe(stateHash(replayGame(FIXTURE_CARDS, [...DECKS], SEED, []).state));

    expect(player.current().step).toBe(0);
    expect(player.stepTo(player.totalSteps).hash).toBe(
      stateHash(replayGame(FIXTURE_CARDS, [...DECKS], SEED, log.intents).state),
    );
  });

  it('rejects out-of-range steps', () => {
    const { rec } = finishedGame(4);
    const player = new ReplayPlayer(FIXTURE_CARDS, rec.toLog());
    expect(() => player.stepTo(-1)).toThrow(RangeError);
    expect(() => player.stepTo(player.totalSteps + 1)).toThrow(RangeError);
    expect(() => player.stepTo(1.5)).toThrow(RangeError);
  });

  it('serves seat-specific views through sanitizeFor', () => {
    const { rec } = finishedGame(10);
    const player = new ReplayPlayer(FIXTURE_CARDS, rec.toLog());
    const frame = player.stepTo(5);
    expect(player.viewFor('p1')).toEqual(sanitizeFor(frame.state, 'p1'));
  });

  it('refuses to play an unfinished game', () => {
    const rec = new ReplayRecorder({
      seed: SEED,
      decks: [FIXTURE_DECK_A, FIXTURE_DECK_B],
      hostSeat: 'p0',
    });
    rec.record({ type: 'PASS_PRIORITY', playerId: 'p0' });
    expect(() => new ReplayPlayer(FIXTURE_CARDS, rec.toLog())).toThrow(/in progress/);
  });

  it('refuses a log flagged finished whose replay is still running', () => {
    const { rec } = finishedGame(6);
    const log = rec.toLog();
    const lying = { ...log, intents: log.intents.slice(0, -1) };
    expect(() => new ReplayPlayer(FIXTURE_CARDS, lying)).toThrow(/still in progress/);
  });
});

describe('downloadReplay', () => {
  it('is a no-op without a DOM (node test environment)', () => {
    const { rec } = finishedGame(2);
    expect(downloadReplay(rec.toLog())).toBe(false);
  });
});
