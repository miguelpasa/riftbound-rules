/**
 * Replay recording, export/import and playback for finished games (N4).
 *
 * - {@link ReplayRecorder} collects the accepted intents of one game (the caller only records intents
 *   the engine accepted) and, once the game ends, produces a {@link RecordedReplay}.
 * - {@link exportReplay} serialises a record to pretty JSON with an integrity checksum. The checksum
 *   (cyrb53 over canonical JSON of the record body) detects accidental corruption and casual edits; it
 *   is NOT a signature, so anyone who can edit a file can also recompute it.
 * - {@link importReplay} parses and validates such a file (format, format version, engine version,
 *   size limits, shape of every intent and deck, checksum) and never throws.
 * - {@link ReplayPlayer} plays a FINISHED record back step by step. Replays reveal hidden information,
 *   which is why unfinished games are refused: nobody may watch a game that is still being played.
 *   `viewFor(seat)` still goes through `sanitizeFor`, so the player sees the seat-specific view.
 * - {@link downloadReplay} saves the export through a Blob and an anchor; it is a no-op (returns false)
 *   outside a browser.
 *
 * Isomorphic apart from the optional download helper, which guards for a missing DOM.
 */
import {
  ENGINE_VERSION,
  canonicalJson,
  createGameWithEvents,
  hashString,
  reduce,
  replayGame,
  resumeGame,
  sanitizeFor,
  stateHash,
  type CardDatabase,
  type ClientGameState,
  type DeckList,
  type GameEvent,
  type GameState,
  type Intent,
  type PlayerId,
  type ReplayLog,
} from '@riftbound/engine';

export const REPLAY_FORMAT = 'riftbound-replay';
export const REPLAY_FORMAT_VERSION = 1;
/** Upper bounds that keep an imported file from exhausting memory or the UI. */
export const MAX_REPLAY_CHARS = 4 * 1024 * 1024;
export const MAX_REPLAY_INTENTS = 10_000;
const MAX_DECK_ENTRIES = 500;
const MAX_SEED_LENGTH = 256;

const INTENT_TYPES: ReadonlySet<string> = new Set([
  'MULLIGAN',
  'PASS_PRIORITY',
  'END_TURN',
  'PLAY_CARD',
  'ACTIVATE_RUNE',
  'STANDARD_MOVE',
  'ASSIGN_COMBAT_DAMAGE',
  'HIDE_CARD',
  'ACTIVATE_ABILITY',
  'EQUIP',
  'CHOOSE_STAGED',
  'CHOOSE_TRIGGER_TARGET',
  'DECIDE_OPTIONAL',
  'CONCEDE',
]);

/** A replay log plus the outcome metadata the recorder adds. */
export interface ReplayMeta {
  finished: boolean;
  /** Null for a draw or an unfinished game. */
  winner: PlayerId | null;
  /** The seat the recording host played (used for UI only; playback never depends on it). */
  hostSeat: PlayerId;
}

export interface RecordedReplay extends ReplayLog, ReplayMeta {}

export class ReplayFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayFormatError';
  }
}

export interface ReplayRecorderInit {
  seed: string;
  decks: [DeckList, DeckList];
  hostSeat: PlayerId;
  /** Defaults to the engine version in use. */
  engineVersion?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSeat(v: unknown): v is PlayerId {
  return v === 'p0' || v === 'p1';
}

function assertIntentShape(intent: unknown): asserts intent is Intent {
  if (!isObject(intent)) throw new TypeError('intent must be an object');
  if (typeof intent.type !== 'string' || !INTENT_TYPES.has(intent.type)) {
    throw new TypeError(`unknown intent type ${String(intent.type)}`);
  }
  if (!isSeat(intent.playerId)) throw new TypeError('intent.playerId must be p0 or p1');
}

function cloneDecks(decks: [DeckList, DeckList]): [DeckList, DeckList] {
  return structuredClone(decks);
}

/** Field-by-field copy: the body that is hashed and serialised, nothing else. */
function bodyOf(r: RecordedReplay): RecordedReplay {
  return {
    engineVersion: r.engineVersion,
    seed: r.seed,
    decks: r.decks,
    intents: r.intents,
    finished: r.finished,
    winner: r.winner,
    hostSeat: r.hostSeat,
  };
}

function checksumOf(r: RecordedReplay): string {
  return hashString(canonicalJson(bodyOf(r)));
}

export class ReplayRecorder {
  private readonly seed: string;
  private readonly decks: [DeckList, DeckList];
  private readonly hostSeat: PlayerId;
  private readonly engineVersion: string;
  private intents: Intent[] = [];
  private finished = false;
  private winner: PlayerId | null = null;

  constructor(init: ReplayRecorderInit) {
    if (
      typeof init.seed !== 'string' ||
      init.seed.length === 0 ||
      init.seed.length > MAX_SEED_LENGTH
    ) {
      throw new TypeError('seed must be a non-empty string');
    }
    if (!isSeat(init.hostSeat)) throw new TypeError('hostSeat must be p0 or p1');
    this.seed = init.seed;
    this.decks = cloneDecks(init.decks);
    this.hostSeat = init.hostSeat;
    this.engineVersion = init.engineVersion ?? ENGINE_VERSION;
  }

  /** Append an intent the engine accepted. */
  record(intent: Intent): void {
    if (this.finished) throw new Error('cannot record after finish()');
    assertIntentShape(intent);
    if (this.intents.length >= MAX_REPLAY_INTENTS) {
      throw new RangeError(`replay exceeds ${MAX_REPLAY_INTENTS} intents`);
    }
    this.intents.push(structuredClone(intent));
  }

  /** Mark the game as over. `winner` is null for a draw. */
  finish(winner: PlayerId | null): void {
    if (this.finished) throw new Error('finish() already called');
    if (winner !== null && !isSeat(winner)) throw new TypeError('winner must be p0, p1 or null');
    this.finished = true;
    this.winner = winner;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get intentCount(): number {
    return this.intents.length;
  }

  toLog(): RecordedReplay {
    return {
      engineVersion: this.engineVersion,
      seed: this.seed,
      decks: cloneDecks(this.decks),
      intents: structuredClone(this.intents),
      finished: this.finished,
      winner: this.winner,
      hostSeat: this.hostSeat,
    };
  }

  /** The export format (pretty JSON with checksum). */
  toJSON(): string {
    return exportReplay(this.toLog());
  }

  /** Restore a recorder from an export. Throws ReplayFormatError if the text is not a valid export. */
  static fromJSON(text: string): ReplayRecorder {
    const log = parseReplay(text);
    const rec = new ReplayRecorder({
      seed: log.seed,
      decks: log.decks,
      hostSeat: log.hostSeat,
      engineVersion: log.engineVersion,
    });
    rec.intents = log.intents;
    rec.finished = log.finished;
    rec.winner = log.winner;
    return rec;
  }
}

/** Serialise a record to pretty JSON including its checksum. */
export function exportReplay(log: RecordedReplay): string {
  const body = bodyOf(log);
  return JSON.stringify(
    {
      format: REPLAY_FORMAT,
      formatVersion: REPLAY_FORMAT_VERSION,
      checksum: checksumOf(body),
      ...body,
    },
    null,
    2,
  );
}

function fail(message: string): never {
  throw new ReplayFormatError(message);
}

function validateDeck(v: unknown, label: string): DeckList {
  if (!isObject(v)) fail(`${label} must be an object`);
  const { legendId, championId, mainDeck, runeDeck, battlefields } = v;
  if (typeof legendId !== 'string' || typeof championId !== 'string') {
    fail(`${label}.legendId and championId must be strings`);
  }
  const lists = { mainDeck, runeDeck, battlefields };
  for (const [key, list] of Object.entries(lists)) {
    if (!Array.isArray(list) || list.length > MAX_DECK_ENTRIES) {
      fail(`${label}.${key} must be an array of at most ${MAX_DECK_ENTRIES} entries`);
    }
    if (!list.every((x) => typeof x === 'string')) fail(`${label}.${key} must contain strings`);
  }
  return {
    legendId,
    championId,
    mainDeck: [...(mainDeck as string[])],
    runeDeck: [...(runeDeck as string[])],
    battlefields: [...(battlefields as string[])],
  };
}

/** Parse and validate an export. Throws ReplayFormatError with a human-readable reason. */
export function parseReplay(text: string): RecordedReplay {
  if (typeof text !== 'string') fail('replay must be a string');
  if (text.length > MAX_REPLAY_CHARS) fail(`replay file exceeds ${MAX_REPLAY_CHARS} characters`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('replay is not valid JSON');
  }
  if (!isObject(raw)) fail('replay must be a JSON object');
  if (raw.format !== REPLAY_FORMAT) fail('not a Riftbound replay file');
  if (raw.formatVersion !== REPLAY_FORMAT_VERSION) {
    fail(`unsupported replay format version ${String(raw.formatVersion)}`);
  }
  if (raw.engineVersion !== ENGINE_VERSION) {
    fail(`replay was recorded with engine ${String(raw.engineVersion)}, this is ${ENGINE_VERSION}`);
  }
  if (typeof raw.seed !== 'string' || raw.seed.length === 0 || raw.seed.length > MAX_SEED_LENGTH) {
    fail('seed must be a non-empty string');
  }
  if (!Array.isArray(raw.decks) || raw.decks.length !== 2) fail('decks must hold two deck lists');
  const decks: [DeckList, DeckList] = [
    validateDeck(raw.decks[0], 'decks[0]'),
    validateDeck(raw.decks[1], 'decks[1]'),
  ];
  if (!Array.isArray(raw.intents) || raw.intents.length > MAX_REPLAY_INTENTS) {
    fail(`intents must be an array of at most ${MAX_REPLAY_INTENTS} entries`);
  }
  const intents: Intent[] = raw.intents.map((intent, i) => {
    try {
      assertIntentShape(intent);
    } catch (e) {
      fail(`intents[${i}]: ${(e as Error).message}`);
    }
    return intent;
  });
  if (typeof raw.finished !== 'boolean') fail('finished must be a boolean');
  if (raw.winner !== null && !isSeat(raw.winner)) fail('winner must be p0, p1 or null');
  if (!isSeat(raw.hostSeat)) fail('hostSeat must be p0 or p1');
  if (typeof raw.checksum !== 'string') fail('missing checksum');

  const log: RecordedReplay = {
    engineVersion: ENGINE_VERSION,
    seed: raw.seed,
    decks,
    intents,
    finished: raw.finished,
    winner: raw.winner as PlayerId | null,
    hostSeat: raw.hostSeat,
  };
  if (checksumOf(log) !== raw.checksum)
    fail('checksum mismatch: the replay file was modified or corrupted');
  return log;
}

export type ImportResult = { ok: true; log: RecordedReplay } | { ok: false; error: string };

/** Non-throwing wrapper around {@link parseReplay}. */
export function importReplay(text: string): ImportResult {
  try {
    return { ok: true, log: parseReplay(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ReplayFrame {
  /** Number of intents applied (0 = the initial position). */
  step: number;
  /** Total number of intents in the game. */
  total: number;
  hash: string;
  state: GameState;
}

/**
 * Step through a finished game. Forward moves resume from the cached state; backward moves (and
 * a jump to 0 from the end) replay from the seed.
 */
export class ReplayPlayer {
  private readonly cards: CardDatabase;
  private readonly log: RecordedReplay;
  /** `stepEvents[i]` = every event produced by intent i+1 (the step that leads to position i+1). */
  private readonly stepEvents: GameEvent[][];
  private step: number;
  private state: GameState;
  private hashCache: string | null = null;

  constructor(cards: CardDatabase, log: RecordedReplay) {
    if (!log.finished) {
      throw new Error('ReplayPlayer only plays finished games; this game is still in progress');
    }
    if (log.engineVersion !== ENGINE_VERSION) {
      throw new Error(
        `Replay log was recorded with engine ${log.engineVersion}, this is engine ${ENGINE_VERSION}`,
      );
    }
    // One pass over the log, keeping the events of every step (the same loop replayGame runs).
    let state = createGameWithEvents(cards, log.decks, log.seed).state;
    const stepEvents: GameEvent[][] = [];
    log.intents.forEach((intent, i) => {
      const r = reduce(state, cards, intent);
      if (!r.ok) {
        throw new Error(`replay diverged at intent #${i + 1}: ${r.code} ${r.message}`);
      }
      state = r.state;
      stepEvents.push(r.events);
    });
    if (state.gameStatus === 'IN_PROGRESS') {
      throw new Error('replay is marked finished but the replayed game is still in progress');
    }
    this.cards = cards;
    this.log = log;
    this.stepEvents = stepEvents;
    this.step = log.intents.length;
    this.state = state;
  }

  get totalSteps(): number {
    return this.log.intents.length;
  }

  /**
   * All events of one step (1..totalSteps): the events the intent with that number produced, in
   * `seq` order, including Cleanup and triggered abilities. Empty for step 0 or an out-of-range step.
   * Independent of the cursor, so the viewer can list the full history.
   */
  eventsOf(step: number): GameEvent[] {
    if (!Number.isInteger(step) || step < 1 || step > this.totalSteps) return [];
    return this.stepEvents[step - 1] ?? [];
  }

  /** Move to the position after `n` intents (0..totalSteps). */
  stepTo(n: number): ReplayFrame {
    if (!Number.isInteger(n) || n < 0 || n > this.totalSteps) {
      throw new RangeError(`step must be an integer in 0..${this.totalSteps}, got ${String(n)}`);
    }
    if (n !== this.step) {
      if (n > this.step) {
        this.state = resumeGame(this.cards, this.state, this.log.intents.slice(this.step, n)).state;
      } else {
        this.state = replayGame(
          this.cards,
          this.log.decks,
          this.log.seed,
          this.log.intents.slice(0, n),
        ).state;
      }
      this.step = n;
      this.hashCache = null;
    }
    return this.current();
  }

  current(): ReplayFrame {
    this.hashCache ??= stateHash(this.state);
    return { step: this.step, total: this.totalSteps, hash: this.hashCache, state: this.state };
  }

  /** The seat-specific view of the current position (never the raw state). */
  viewFor(seat: PlayerId): ClientGameState {
    return sanitizeFor(this.state, seat);
  }
}

/** Trigger a browser download of the export. Returns false when no DOM/Blob is available. */
export function downloadReplay(log: RecordedReplay, fileName?: string): boolean {
  if (
    typeof Blob !== 'function' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof document === 'undefined' ||
    !document.body
  ) {
    return false;
  }
  const safeName = (fileName ?? `riftbound-${log.seed}`).replace(/[^A-Za-z0-9_-]/g, '_');
  const url = URL.createObjectURL(new Blob([exportReplay(log)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
