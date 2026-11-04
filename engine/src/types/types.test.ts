import { describe, it, expect } from 'vitest';
import {
  ENGINE_VERSION,
  MVP_KEYWORDS,
  DEFERRED_KEYWORDS,
  RULE_ERROR_CODES,
  RULE_ERROR_MESSAGES,
  VICTORY_SCORE,
  opponentOf,
  ruleError,
  type GameState,
  type PlayerState,
} from '../index.js';

function player(id: 'p0' | 'p1'): PlayerState {
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

const minimal: GameState = {
  engineVersion: ENGINE_VERSION,
  mode: 'DUEL',
  victoryScore: VICTORY_SCORE,
  players: [player('p0'), player('p1')],
  objects: {},
  battlefields: [],
  seed: { seed: 'x' },
  rng: { s: [1, 2, 3, 4] },
  turn: { number: 1, activePlayer: 'p0', phase: 'MULLIGAN', step: 'NONE' },
  turnState: { kind: 'NEUTRAL', open: true },
  flow: {
    priority: null,
    focus: null,
    chain: [],
    stagedShowdowns: [],
    stagedCombats: [],
    cleanupIterations: 0,
  },
  mulligan: { order: ['p0', 'p1'], current: 0, done: [] },
  gameStatus: 'IN_PROGRESS',
  nextObjectId: 1,
  nextEventSeq: 1,
};

type StructuredCloneFn = <T>(v: T) => T;

describe('type contract', () => {
  it('has a prefixed message for every RuleErrorCode', () => {
    // Tests Rule 309: error messages cite rules and are prefixed
    expect(RULE_ERROR_CODES.length).toBeGreaterThanOrEqual(25);
    for (const code of RULE_ERROR_CODES) {
      expect(RULE_ERROR_MESSAGES[code].startsWith('[Rule Error] ')).toBe(true);
    }
    const err = ruleError('CLOSED_STATE_REACTION_ONLY');
    expect(err.ok).toBe(false);
    expect(err.message).toContain('Rule 309.1.a');
  });

  it('never cites the nonexistent Rule 607.1', () => {
    // Tests Rule 607: PRD rule 607.1 does not exist
    for (const code of RULE_ERROR_CODES) {
      expect(RULE_ERROR_MESSAGES[code]).not.toContain('607.1');
    }
  });

  it('opponentOf swaps players', () => {
    // Tests Rule 117: two-player duel, p0 is first player
    expect(opponentOf('p0')).toBe('p1');
    expect(opponentOf('p1')).toBe('p0');
  });

  it('keeps MVP and deferred keywords disjoint', () => {
    // Tests Rule 700: keyword classification
    for (const k of MVP_KEYWORDS) {
      expect((DEFERRED_KEYWORDS as readonly string[]).includes(k)).toBe(false);
    }
  });

  it('round-trips a minimal GameState through structuredClone and JSON', () => {
    // Tests Rule 473.1: victory score stored in plain-data state
    const sc = (globalThis as unknown as { structuredClone: StructuredCloneFn }).structuredClone;
    expect(sc(minimal)).toEqual(minimal);
    expect(JSON.parse(JSON.stringify(minimal))).toEqual(minimal);
    expect(minimal.victoryScore).toBe(8);
  });
});
