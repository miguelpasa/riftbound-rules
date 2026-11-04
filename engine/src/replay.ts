/**
 * Deterministic replay support (event sourcing) for persistence and replay logs.
 *
 * The engine is a pure function of (cards, decks, seed, intents): `createGame` is seeded, `reduce`
 * is deterministic, and all randomness lives in `state.rng`. A game is therefore fully described by
 * a ReplayLog, and a checkpoint is just a JSON-serialised GameState plus the remaining intents.
 *
 * - `stateHash` : stable 53-bit hash (cyrb53) of a canonical JSON serialisation (sorted keys,
 *   `undefined` properties dropped exactly like JSON.stringify does), as a 14-digit hex string.
 *   Equal hashes mean "same state" for all practical purposes; key insertion order is irrelevant.
 * - `replayGame`: setup via createGameWithEvents (the seating-aware creator: the RNG may swap the
 *   decklists), then every intent through `reduce`. An intent that was recorded as accepted but is
 *   now rejected throws a ReplayError naming the step, intent and rule error.
 * - `resumeGame`: the same loop starting from a checkpoint state (e.g. JSON.parse of a persisted
 *   snapshot).
 * - `makeReplayLog` / `playLog`: the persisted form; `playLog` refuses a log written by another
 *   engine version.
 *
 * Isomorphic: no Node or DOM APIs.
 */
import { reduce } from './reducer.js';
import { createGameWithEvents } from './setup.js';
import { ENGINE_VERSION } from './types/state.js';
import type { CardDatabase, DeckList, GameEvent, GameState, Intent } from './types/index.js';

// ---------------------------------------------------------------- hashing

/** Canonical JSON: object keys sorted, `undefined` object members skipped, `undefined` array items null. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return 'null';
  }
}

/** cyrb53 string hash (public domain, Bryc), returned as 14 hex digits. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/** Stable hash of a GameState (or any JSON-like value). */
export function stateHash(state: GameState): string {
  return hashString(canonicalJson(state));
}

// ---------------------------------------------------------------- replay

export interface ReplayOptions {
  /** Record `stateHash` after every N applied intents (N >= 1). */
  checkpointEvery?: number;
}

export interface ReplayCheckpoint {
  /** Number of intents applied so far (counted from the start of this replay call). */
  step: number;
  hash: string;
}

export interface ReplayResult {
  state: GameState;
  /** replayGame: setup events followed by every intent's events. resumeGame: the intents' events only. */
  events: GameEvent[];
  /** Present when `checkpointEvery` was given. */
  hashes?: ReplayCheckpoint[];
}

/** Thrown when a recorded intent is rejected during replay. */
export class ReplayError extends Error {
  readonly step: number;
  readonly intent: Intent;
  readonly code: string;
  constructor(step: number, intent: Intent, code: string, message: string) {
    super(
      `Replay diverged at intent #${step} (${intent.type} by ${intent.playerId}): ` +
        `recorded as accepted but rejected with ${code}: ${message}`,
    );
    this.name = 'ReplayError';
    this.step = step;
    this.intent = intent;
    this.code = code;
  }
}

function applyAll(
  start: GameState,
  cards: CardDatabase,
  intents: readonly Intent[],
  opts: ReplayOptions,
  events: GameEvent[],
): ReplayResult {
  const every = opts.checkpointEvery;
  if (every !== undefined && (!Number.isInteger(every) || every < 1)) {
    throw new Error(`checkpointEvery must be a positive integer, got ${String(every)}`);
  }
  const hashes: ReplayCheckpoint[] = [];
  let state = start;
  intents.forEach((intent, i) => {
    const r = reduce(state, cards, intent);
    if (!r.ok) throw new ReplayError(i + 1, intent, r.code, r.message);
    state = r.state;
    events.push(...r.events);
    if (every !== undefined && (i + 1) % every === 0) {
      hashes.push({ step: i + 1, hash: stateHash(state) });
    }
  });
  return every === undefined ? { state, events } : { state, events, hashes };
}

/** Rebuild a game from its seed and decks and apply `intents`. Throws ReplayError on divergence. */
export function replayGame(
  cards: CardDatabase,
  decks: [DeckList, DeckList],
  seed: string,
  intents: readonly Intent[],
  opts: ReplayOptions = {},
): ReplayResult {
  const setup = createGameWithEvents(cards, decks, seed);
  return applyAll(setup.state, cards, intents, opts, [...setup.events]);
}

/** Continue from a checkpoint (e.g. a JSON round-tripped state) with the remaining intents. */
export function resumeGame(
  cards: CardDatabase,
  checkpoint: GameState,
  intents: readonly Intent[],
  opts: ReplayOptions = {},
): ReplayResult {
  return applyAll(checkpoint, cards, intents, opts, []);
}

// ---------------------------------------------------------------- persisted log

export interface ReplayLog {
  engineVersion: string;
  seed: string;
  decks: [DeckList, DeckList];
  intents: Intent[];
}

/** Build a log (deep-copied, so later mutation of the arguments cannot corrupt it). */
export function makeReplayLog(
  seed: string,
  decks: [DeckList, DeckList],
  intents: readonly Intent[],
  engineVersion: string = ENGINE_VERSION,
): ReplayLog {
  return {
    engineVersion,
    seed,
    decks: structuredClone(decks),
    intents: structuredClone([...intents]),
  };
}

/** Replay a persisted log. Refuses logs from a different engine version. */
export function playLog(
  cards: CardDatabase,
  log: ReplayLog,
  opts: ReplayOptions = {},
): ReplayResult {
  if (log.engineVersion !== ENGINE_VERSION) {
    throw new Error(
      `Replay log was recorded with engine ${log.engineVersion}, this is engine ${ENGINE_VERSION}`,
    );
  }
  return replayGame(cards, log.decks, log.seed, log.intents, opts);
}
