/**
 * Event-sourced persistence of the HOST's authoritative game (N3).
 *
 * Design (explicit decision): we never write the full state per intent. The durable record of a game
 * is its header (seed + decks + engine version) and an append-only intent log; the engine is a pure
 * deterministic function of those. To keep restores fast we also write a full-state checkpoint at the
 * start of every turn and when the game ends. Restoring = latest checkpoint + replay of the intents
 * with `index >= checkpoint.intentCount` (or the whole log from the seed when there is no usable
 * checkpoint).
 *
 * - {@link GameStorage}: async storage contract. {@link IndexedDbGameStorage} (db 'riftbound') and
 *   {@link MemoryGameStorage} (tests / fallback). {@link openGameStorage} picks one.
 * - {@link GamePersister}: subscribes to `HostSession.onCommit`; batches intent appends (50 ms
 *   debounce, flushed immediately on pagehide / tab hidden / `flush()`), checkpoints on turn change
 *   and at game over. Persistence failures never break the game: they are retried a few times, then
 *   reported through `onError`.
 * - {@link startPersistedHost} / {@link restoreHostSession}: wire a HostSession to the persister.
 *
 * The seat token is stored in the header so a reloaded host still recognises its guest.
 */
import {
  ENGINE_VERSION,
  replayGame,
  resumeGame,
  type CardDatabase,
  type DeckList,
  type GameState,
  type Intent,
  type PlayerId,
} from '@riftbound/engine';
import {
  HostSession,
  type CommitEntry,
  type CreateHostOptions,
  type HostSessionOptions,
} from './hostSession.js';

// ---------------------------------------------------------------- types

export interface GameHeader {
  gameId: string;
  engineVersion: string;
  seed: string;
  /** Decklists exactly as given to game creation: [host's deck, guest's deck]. */
  decks: [DeckList, DeckList];
  hostSeat: PlayerId;
  mode: 'MULTIPLAYER' | 'SOLO';
  /** Solo only: the bot's difficulty. Optional so saves made before it existed still load. */
  difficulty?: 'easy' | 'normal' | 'hard';
  roomCode?: string;
  guestSeatToken?: string;
  createdAt: number;
  status: 'IN_PROGRESS' | 'FINISHED';
  /** Set by finishGame. */
  winner?: PlayerId | null;
}

/** One accepted intent. `index` is its position in the log (0-based, monotonically increasing). */
export interface StoredIntent {
  index: number;
  intent: Intent;
  seat: PlayerId;
  clientSeq?: number;
}

export interface StoredCheckpoint {
  /** Number of intents applied when the snapshot was taken (the next intent to replay has this index). */
  intentCount: number;
  turnNumber: number;
  /** JSON.stringify(GameState). */
  stateJson: string;
}

export interface LoadedGame {
  header: GameHeader;
  /** The latest checkpoint, if any. */
  checkpoint?: StoredCheckpoint;
  /** The whole intent log, ascending by index. */
  intents: StoredIntent[];
}

export interface GameSummary {
  gameId: string;
  mode: GameHeader['mode'];
  status: GameHeader['status'];
  createdAt: number;
  engineVersion: string;
  roomCode?: string;
  winner?: PlayerId | null;
  intentCount: number;
}

export type HeaderPatch = Partial<Pick<GameHeader, 'roomCode' | 'guestSeatToken'>>;

export interface GameStorage {
  createGame(header: GameHeader): Promise<void>;
  /** Update mutable header fields (room code, claimed guest seat token). */
  updateHeader(gameId: string, patch: HeaderPatch): Promise<void>;
  /** Idempotent: an entry with an existing index replaces it. */
  appendIntents(gameId: string, entries: StoredIntent[]): Promise<void>;
  /** Stores the checkpoint and keeps only the latest two for the game. */
  saveCheckpoint(gameId: string, checkpoint: StoredCheckpoint): Promise<void>;
  loadGame(gameId: string): Promise<LoadedGame | null>;
  /** Newest first. */
  listGames(): Promise<GameSummary[]>;
  finishGame(gameId: string, winner: PlayerId | null): Promise<void>;
  deleteGame(gameId: string): Promise<void>;
}

export const CHECKPOINTS_KEPT = 2;

const clone = <T>(v: T): T => structuredClone(v);

function summarize(h: GameHeader, intentCount: number): GameSummary {
  const s: GameSummary = {
    gameId: h.gameId,
    mode: h.mode,
    status: h.status,
    createdAt: h.createdAt,
    engineVersion: h.engineVersion,
    intentCount,
  };
  if (h.roomCode !== undefined) s.roomCode = h.roomCode;
  if (h.winner !== undefined) s.winner = h.winner;
  return s;
}

export function newGameId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `g-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------- memory storage

interface MemGame {
  header: GameHeader;
  intents: Map<number, StoredIntent>;
  checkpoints: StoredCheckpoint[];
}

/** In-memory GameStorage (tests, and the fallback when IndexedDB is unavailable). */
export class MemoryGameStorage implements GameStorage {
  private readonly games = new Map<string, MemGame>();

  private game(id: string): MemGame {
    const g = this.games.get(id);
    if (!g) throw new Error(`unknown game ${id}`);
    return g;
  }

  async createGame(header: GameHeader): Promise<void> {
    this.games.set(header.gameId, { header: clone(header), intents: new Map(), checkpoints: [] });
  }
  async updateHeader(gameId: string, patch: HeaderPatch): Promise<void> {
    Object.assign(this.game(gameId).header, clone(patch));
  }
  async appendIntents(gameId: string, entries: StoredIntent[]): Promise<void> {
    const g = this.game(gameId);
    for (const e of entries) g.intents.set(e.index, clone(e));
  }
  async saveCheckpoint(gameId: string, cp: StoredCheckpoint): Promise<void> {
    const g = this.game(gameId);
    g.checkpoints = g.checkpoints.filter((c) => c.intentCount !== cp.intentCount);
    g.checkpoints.push(clone(cp));
    g.checkpoints.sort((a, b) => a.intentCount - b.intentCount);
    g.checkpoints = g.checkpoints.slice(-CHECKPOINTS_KEPT);
  }
  async loadGame(gameId: string): Promise<LoadedGame | null> {
    const g = this.games.get(gameId);
    if (!g) return null;
    const out: LoadedGame = {
      header: clone(g.header),
      intents: [...g.intents.values()].sort((a, b) => a.index - b.index).map(clone),
    };
    const last = g.checkpoints[g.checkpoints.length - 1];
    if (last) out.checkpoint = clone(last);
    return out;
  }
  async listGames(): Promise<GameSummary[]> {
    return [...this.games.values()]
      .map((g) => summarize(g.header, g.intents.size))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async finishGame(gameId: string, winner: PlayerId | null): Promise<void> {
    const g = this.game(gameId);
    g.header.status = 'FINISHED';
    g.header.winner = winner;
  }
  async deleteGame(gameId: string): Promise<void> {
    this.games.delete(gameId);
  }
}

// ---------------------------------------------------------------- IndexedDB storage

export const DB_NAME = 'riftbound';
const DB_VERSION = 1;
const S_GAMES = 'games';
const S_INTENTS = 'intents';
const S_CHECKPOINTS = 'checkpoints';

type IntentRow = StoredIntent & { gameId: string };
type CheckpointRow = StoredCheckpoint & { gameId: string };

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export interface IndexedDbOptions {
  /** Defaults to the global `indexedDB`. */
  factory?: IDBFactory;
  /** Defaults to the global `IDBKeyRange`. */
  keyRange?: typeof IDBKeyRange;
  dbName?: string;
}

export class IndexedDbGameStorage implements GameStorage {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly range: typeof IDBKeyRange,
  ) {}

  /** Open (and upgrade) the database. Rejects if IndexedDB is unavailable or blocked. */
  static async open(o: IndexedDbOptions = {}): Promise<IndexedDbGameStorage> {
    const factory = o.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    const range = o.keyRange ?? (typeof IDBKeyRange === 'undefined' ? undefined : IDBKeyRange);
    if (!factory || !range) throw new Error('IndexedDB is not available');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(o.dbName ?? DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(S_GAMES))
          d.createObjectStore(S_GAMES, { keyPath: 'gameId' });
        if (!d.objectStoreNames.contains(S_INTENTS)) {
          d.createObjectStore(S_INTENTS, { keyPath: ['gameId', 'index'] });
        }
        if (!d.objectStoreNames.contains(S_CHECKPOINTS)) {
          d.createObjectStore(S_CHECKPOINTS, { keyPath: ['gameId', 'intentCount'] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    db.onversionchange = () => db.close();
    return new IndexedDbGameStorage(db, range);
  }

  close(): void {
    this.db.close();
  }

  private bounds(gameId: string): IDBKeyRange {
    return this.range.bound([gameId, -Infinity], [gameId, Infinity]);
  }

  async createGame(header: GameHeader): Promise<void> {
    const tx = this.db.transaction(S_GAMES, 'readwrite');
    tx.objectStore(S_GAMES).put(header);
    await txDone(tx);
  }

  async updateHeader(gameId: string, patch: HeaderPatch): Promise<void> {
    const tx = this.db.transaction(S_GAMES, 'readwrite');
    const store = tx.objectStore(S_GAMES);
    const done = txDone(tx);
    const cur = (await reqP(store.get(gameId))) as GameHeader | undefined;
    if (!cur) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(`unknown game ${gameId}`);
    }
    store.put({ ...cur, ...patch });
    await done;
  }

  async appendIntents(gameId: string, entries: StoredIntent[]): Promise<void> {
    const tx = this.db.transaction(S_INTENTS, 'readwrite');
    const store = tx.objectStore(S_INTENTS);
    for (const e of entries) store.put({ ...e, gameId } satisfies IntentRow);
    await txDone(tx);
  }

  async saveCheckpoint(gameId: string, cp: StoredCheckpoint): Promise<void> {
    const tx = this.db.transaction(S_CHECKPOINTS, 'readwrite');
    const store = tx.objectStore(S_CHECKPOINTS);
    const done = txDone(tx);
    store.put({ ...cp, gameId } satisfies CheckpointRow);
    const keys = (await reqP(store.getAllKeys(this.bounds(gameId)))) as IDBValidKey[];
    // Keys are [gameId, intentCount] sorted ascending: drop all but the newest CHECKPOINTS_KEPT.
    for (const k of keys.slice(0, Math.max(0, keys.length - CHECKPOINTS_KEPT))) store.delete(k);
    await done;
  }

  async loadGame(gameId: string): Promise<LoadedGame | null> {
    const tx = this.db.transaction([S_GAMES, S_INTENTS, S_CHECKPOINTS], 'readonly');
    const done = txDone(tx);
    const [header, intents, cps] = await Promise.all([
      reqP(tx.objectStore(S_GAMES).get(gameId)) as Promise<GameHeader | undefined>,
      reqP(tx.objectStore(S_INTENTS).getAll(this.bounds(gameId))) as Promise<IntentRow[]>,
      reqP(tx.objectStore(S_CHECKPOINTS).getAll(this.bounds(gameId))) as Promise<CheckpointRow[]>,
    ]);
    await done;
    if (!header) return null;
    const out: LoadedGame = {
      header,
      intents: intents.map(({ gameId: _g, ...rest }) => {
        void _g;
        return rest;
      }),
    };
    const last = cps[cps.length - 1];
    if (last) {
      out.checkpoint = {
        intentCount: last.intentCount,
        turnNumber: last.turnNumber,
        stateJson: last.stateJson,
      };
    }
    return out;
  }

  async listGames(): Promise<GameSummary[]> {
    const tx = this.db.transaction([S_GAMES, S_INTENTS], 'readonly');
    const done = txDone(tx);
    const headers = (await reqP(tx.objectStore(S_GAMES).getAll())) as GameHeader[];
    const counts = await Promise.all(
      headers.map((h) => reqP(tx.objectStore(S_INTENTS).count(this.bounds(h.gameId)))),
    );
    await done;
    return headers
      .map((h, i) => summarize(h, counts[i] ?? 0))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async finishGame(gameId: string, winner: PlayerId | null): Promise<void> {
    const tx = this.db.transaction(S_GAMES, 'readwrite');
    const store = tx.objectStore(S_GAMES);
    const done = txDone(tx);
    const cur = (await reqP(store.get(gameId))) as GameHeader | undefined;
    if (!cur) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(`unknown game ${gameId}`);
    }
    store.put({ ...cur, status: 'FINISHED', winner });
    await done;
  }

  async deleteGame(gameId: string): Promise<void> {
    const tx = this.db.transaction([S_GAMES, S_INTENTS, S_CHECKPOINTS], 'readwrite');
    tx.objectStore(S_GAMES).delete(gameId);
    tx.objectStore(S_INTENTS).delete(this.bounds(gameId));
    tx.objectStore(S_CHECKPOINTS).delete(this.bounds(gameId));
    await txDone(tx);
  }
}

/** IndexedDB when possible, otherwise memory (reported through `onError`; the game still works). */
export async function openGameStorage(
  onError?: (err: unknown, op: string) => void,
  o: IndexedDbOptions = {},
): Promise<{ storage: GameStorage; persistent: boolean }> {
  try {
    return { storage: await IndexedDbGameStorage.open(o), persistent: true };
  } catch (e) {
    onError?.(e, 'openGameStorage');
    return { storage: new MemoryGameStorage(), persistent: false };
  }
}

// ---------------------------------------------------------------- persister

export type PersistErrorHandler = (err: unknown, op: string) => void;

export interface PersisterOptions {
  storage: GameStorage;
  gameId: string;
  /** Index of the next intent to be logged (0 for a new game; the restored total on resume). */
  nextIndex?: number;
  /** Debounce for intent batches (default 50 ms). */
  debounceMs?: number;
  /** Failed writes are retried this many times before the batch is dropped and reported (default 3). */
  maxAttempts?: number;
  onError?: PersistErrorHandler;
  /** Where pagehide / visibilitychange are listened for (default: globalThis / its document). */
  pageEvents?: boolean;
}

type Pending =
  | { k: 'create'; header: GameHeader }
  | { k: 'header'; patch: HeaderPatch }
  | { k: 'intent'; v: StoredIntent }
  | { k: 'checkpoint'; v: StoredCheckpoint }
  | { k: 'finish'; winner: PlayerId | null };

export class GamePersister {
  readonly gameId: string;
  private readonly storage: GameStorage;
  private readonly debounceMs: number;
  private readonly maxAttempts: number;
  private readonly onError: PersistErrorHandler;

  private session: HostSession | null = null;
  private next: number;
  private lastTurn = -1;
  private finished = false;
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private attempts = 0;
  private disposed = false;
  private readonly offPage: Array<() => void> = [];

  constructor(o: PersisterOptions) {
    this.gameId = o.gameId;
    this.storage = o.storage;
    this.next = o.nextIndex ?? 0;
    this.debounceMs = o.debounceMs ?? 50;
    this.maxAttempts = Math.max(1, o.maxAttempts ?? 3);
    this.onError = o.onError ?? ((e, op) => console.error(`[persist] ${op} failed`, e));
    if (o.pageEvents !== false) this.listenPage();
  }

  /** Index the next committed intent will get (= number of intents logged so far). */
  get intentCount(): number {
    return this.next;
  }

  /**
   * Bind to the session whose commits arrive through {@link onCommit}. For a new game pass its
   * header (it is created first); `checkpoint` writes a snapshot of the current state straight away.
   */
  attach(session: HostSession, opts: { header?: GameHeader; checkpoint?: boolean } = {}): void {
    this.session = session;
    const st = session.getFullStateForPersistence();
    this.finished = st.gameStatus !== 'IN_PROGRESS';
    if (opts.header) this.pending.push({ k: 'create', header: opts.header });
    if (opts.checkpoint) this.queueCheckpoint(st);
    else this.lastTurn = st.turn.number;
    if (this.pending.length > 0) this.schedule();
  }

  /** Pass as (or compose into) `HostSession`'s `onCommit`. Never throws. */
  readonly onCommit = (entry: CommitEntry): void => {
    if (this.disposed) return;
    try {
      const stored: StoredIntent = { index: this.next++, intent: entry.intent, seat: entry.seat };
      if (entry.clientSeq !== undefined) stored.clientSeq = entry.clientSeq;
      this.pending.push({ k: 'intent', v: stored });
      const st = this.session?.getFullStateForPersistence();
      if (st) {
        const over = st.gameStatus !== 'IN_PROGRESS';
        if (st.turn.number !== this.lastTurn || (over && !this.finished)) this.queueCheckpoint(st);
        if (over && !this.finished) {
          this.finished = true;
          this.pending.push({ k: 'finish', winner: st.winner ?? null });
        }
      }
    } catch (e) {
      this.onError(e, 'onCommit');
    }
    this.schedule();
  };

  /** Pass as `HostSession`'s `onSeatClaimed` so the guest can rejoin after a host reload. */
  readonly onSeatClaimed = (guestSeatToken: string): void => {
    this.updateHeader({ guestSeatToken });
  };

  updateHeader(patch: HeaderPatch): void {
    if (this.disposed) return;
    this.pending.push({ k: 'header', patch });
    this.schedule();
  }

  /** Write everything queued now. Resolves when storage has accepted (or given up on) it. */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  /** Stop listening and flush what is left. */
  dispose(): Promise<void> {
    if (this.disposed) return this.chain;
    const done = this.flush();
    this.disposed = true;
    for (const off of this.offPage.splice(0)) off();
    return done;
  }

  // ---- internals ------------------------------------------------------------------------

  private queueCheckpoint(st: GameState): void {
    this.lastTurn = st.turn.number;
    this.pending.push({
      k: 'checkpoint',
      v: { intentCount: this.next, turnNumber: st.turn.number, stateJson: JSON.stringify(st) },
    });
  }

  private schedule(): void {
    if (this.timer !== null || this.disposed || this.pending.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private listenPage(): void {
    const g = globalThis as {
      addEventListener?: (t: string, h: () => void) => void;
      removeEventListener?: (t: string, h: () => void) => void;
      document?: {
        visibilityState?: string;
        addEventListener?: (t: string, h: () => void) => void;
        removeEventListener?: (t: string, h: () => void) => void;
      };
    };
    const now = (): void => void this.flush();
    const hidden = (): void => {
      if (g.document?.visibilityState === 'hidden') void this.flush();
    };
    if (typeof g.addEventListener === 'function') {
      g.addEventListener('pagehide', now);
      this.offPage.push(() => g.removeEventListener?.('pagehide', now));
    }
    if (g.document && typeof g.document.addEventListener === 'function') {
      const doc = g.document;
      doc.addEventListener?.('visibilitychange', hidden);
      this.offPage.push(() => doc.removeEventListener?.('visibilitychange', hidden));
    }
  }

  /** Apply queued operations in order, batching consecutive intents into one transaction. */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const head = this.pending[0] as Pending;
      let items: Pending[];
      if (head.k === 'intent') {
        // One transaction for every queued intent, even those queued after a checkpoint: the log is
        // always written ahead of (never behind) the checkpoints that count it.
        items = this.pending.filter((x) => x.k === 'intent');
        this.pending = this.pending.filter((x) => x.k !== 'intent');
      } else {
        items = this.pending.splice(0, 1);
      }
      try {
        await this.write(head, items);
        this.attempts = 0;
      } catch (e) {
        this.attempts++;
        if (this.attempts >= this.maxAttempts) {
          this.attempts = 0;
          this.onError(e, `${head.k} (dropped after ${this.maxAttempts} attempts)`);
          continue; // give up on this batch, try the rest
        }
        this.pending.unshift(...items);
        this.timer ??= setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.debounceMs * this.attempts);
        (this.timer as { unref?: () => void }).unref?.();
        return;
      }
    }
  }

  private async write(head: Pending, items: Pending[]): Promise<void> {
    switch (head.k) {
      case 'create':
        return this.storage.createGame(head.header);
      case 'header':
        return this.storage.updateHeader(this.gameId, head.patch);
      case 'intent':
        return this.storage.appendIntents(
          this.gameId,
          items.map((i) => (i as { k: 'intent'; v: StoredIntent }).v),
        );
      case 'checkpoint':
        return this.storage.saveCheckpoint(this.gameId, head.v);
      case 'finish':
        return this.storage.finishGame(this.gameId, head.winner);
    }
  }
}

// ---------------------------------------------------------------- start / restore

export type HostCallbacks = Omit<
  HostSessionOptions,
  'cards' | 'state' | 'hostSeat' | 'guestSeatToken'
>;

function composeCommit(
  p: GamePersister | null,
  user: HostSessionOptions['onCommit'],
): HostSessionOptions['onCommit'] {
  if (!p) return user;
  return (e) => {
    p.onCommit(e);
    user?.(e);
  };
}
function composeClaim(
  p: GamePersister | null,
  user: HostSessionOptions['onSeatClaimed'],
): HostSessionOptions['onSeatClaimed'] {
  if (!p) return user;
  return (t) => {
    p.onSeatClaimed(t);
    user?.(t);
  };
}

export interface PersistedHostOptions extends Omit<
  CreateHostOptions,
  'onCommit' | 'onSeatClaimed'
> {
  storage: GameStorage;
  gameId?: string;
  roomCode?: string;
  /** Solo only: saved in the header so Resume keeps the bot's difficulty. */
  difficulty?: 'easy' | 'normal' | 'hard';
  onCommit?: CreateHostOptions['onCommit'];
  onSeatClaimed?: CreateHostOptions['onSeatClaimed'];
  onError?: PersistErrorHandler;
  debounceMs?: number;
}

/** Create a new hosted game that persists itself. */
export function startPersistedHost(o: PersistedHostOptions): {
  session: HostSession;
  persister: GamePersister;
  header: GameHeader;
} {
  const gameId = o.gameId ?? newGameId();
  const pOpts: PersisterOptions = { storage: o.storage, gameId };
  if (o.onError) pOpts.onError = o.onError;
  if (o.debounceMs !== undefined) pOpts.debounceMs = o.debounceMs;
  const persister = new GamePersister(pOpts);
  const guestDeck = o.guestDeck ?? o.hostDeck;
  const { difficulty, ...sessionOpts } = o;
  const session = HostSession.create({
    ...sessionOpts,
    onCommit: composeCommit(persister, o.onCommit),
    onSeatClaimed: composeClaim(persister, o.onSeatClaimed),
  });
  const header: GameHeader = {
    gameId,
    engineVersion: ENGINE_VERSION,
    seed: o.seed,
    decks: [o.hostDeck, guestDeck],
    hostSeat: session.hostSeat,
    mode: o.mode,
    createdAt: Date.now(),
    status: 'IN_PROGRESS',
  };
  if (o.roomCode !== undefined) header.roomCode = o.roomCode;
  if (difficulty !== undefined) header.difficulty = difficulty;
  persister.attach(session, { header, checkpoint: true });
  return { session, persister, header };
}

export type RestoreErrorCode =
  'NOT_FOUND' | 'ENGINE_VERSION_MISMATCH' | 'CORRUPT' | 'STORAGE_ERROR';

export type RestoreResult =
  | {
      ok: true;
      session: HostSession;
      header: GameHeader;
      /** Re-register this PeerJS id so the guest can reconnect to the same room. */
      roomCode: string | undefined;
      /** Number of intents in the restored game. */
      intentCount: number;
      /** Where the base state came from. */
      source: 'checkpoint' | 'replay';
      /** Present unless `persist: false`. */
      persister: GamePersister | null;
    }
  | { ok: false; code: RestoreErrorCode; message: string };

export interface RestoreOptions {
  /** Keep persisting the restored game (default true). */
  persist?: boolean;
  onError?: PersistErrorHandler;
  debounceMs?: number;
}

const fail = (code: RestoreErrorCode, message: string): RestoreResult => ({
  ok: false,
  code,
  message,
});

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isSeat = (v: unknown): v is PlayerId => v === 'p0' || v === 'p1';
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function validHeader(h: unknown): h is GameHeader {
  return (
    isObj(h) &&
    typeof h.gameId === 'string' &&
    typeof h.engineVersion === 'string' &&
    typeof h.seed === 'string' &&
    Array.isArray(h.decks) &&
    h.decks.length === 2 &&
    isSeat(h.hostSeat) &&
    (h.mode === 'MULTIPLAYER' || h.mode === 'SOLO')
  );
}

function parseCheckpoint(cp: StoredCheckpoint): GameState {
  const state = JSON.parse(cp.stateJson) as unknown;
  if (
    !isObj(state) ||
    state.engineVersion !== ENGINE_VERSION ||
    !Array.isArray(state.players) ||
    state.players.length !== 2 ||
    !isObj(state.objects) ||
    !isObj(state.turn) ||
    !isObj(state.rng) ||
    !Number.isSafeInteger(cp.intentCount) ||
    cp.intentCount < 0
  ) {
    throw new Error('checkpoint has an unexpected shape');
  }
  return state as unknown as GameState;
}

/**
 * Rebuild a HostSession from storage: latest checkpoint + the intents logged after it, or the whole
 * log replayed from the seed when there is no usable checkpoint. Never throws.
 */
export async function restoreHostSession(
  storage: GameStorage,
  gameId: string,
  cards: CardDatabase,
  callbacks: HostCallbacks = {},
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  let loaded: LoadedGame | null;
  try {
    loaded = await storage.loadGame(gameId);
  } catch (e) {
    return fail('STORAGE_ERROR', `could not read game ${gameId}: ${msg(e)}`);
  }
  if (!loaded) return fail('NOT_FOUND', `no saved game ${gameId}`);
  const { header, checkpoint } = loaded;
  if (!validHeader(header)) return fail('CORRUPT', 'saved game header is malformed');
  if (header.engineVersion !== ENGINE_VERSION) {
    return fail(
      'ENGINE_VERSION_MISMATCH',
      `this game was recorded with engine ${header.engineVersion}; this build runs ${ENGINE_VERSION}`,
    );
  }

  // Contiguous, well-formed prefix of the log.
  const sorted = [...loaded.intents].sort((a, b) => a.index - b.index);
  const intents: Intent[] = [];
  for (const row of sorted) {
    if (row.index !== intents.length) break;
    if (!isObj(row.intent) || typeof row.intent.type !== 'string' || !isSeat(row.intent.playerId)) {
      break;
    }
    intents.push(row.intent);
  }

  let state: GameState | null = null;
  let source: 'checkpoint' | 'replay' = 'checkpoint';
  let total = intents.length;
  let replayedAfterCheckpoint = 0;
  let checkpointError = '';
  if (checkpoint) {
    try {
      const base = parseCheckpoint(checkpoint);
      const rest = intents.slice(checkpoint.intentCount);
      state = resumeGame(cards, base, rest).state;
      total = Math.max(intents.length, checkpoint.intentCount);
      replayedAfterCheckpoint = rest.length;
    } catch (e) {
      checkpointError = msg(e);
      state = null;
    }
  }
  if (!state) {
    source = 'replay';
    total = intents.length;
    try {
      state = replayGame(cards, header.decks, header.seed, intents).state;
    } catch (e) {
      return fail(
        'CORRUPT',
        `saved game cannot be rebuilt: ${msg(e)}${checkpointError ? ` (checkpoint: ${checkpointError})` : ''}`,
      );
    }
  }

  const persist = options.persist !== false;
  let persister: GamePersister | null = null;
  if (persist) {
    const pOpts: PersisterOptions = { storage, gameId, nextIndex: total };
    if (options.onError) pOpts.onError = options.onError;
    if (options.debounceMs !== undefined) pOpts.debounceMs = options.debounceMs;
    persister = new GamePersister(pOpts);
  }
  const sOpts: HostSessionOptions = {
    ...callbacks,
    cards,
    state,
    hostSeat: header.hostSeat,
    guestSeatToken: header.guestSeatToken ?? null,
  };
  const oc = composeCommit(persister, callbacks.onCommit);
  if (oc) sOpts.onCommit = oc;
  const cl = composeClaim(persister, callbacks.onSeatClaimed);
  if (cl) sOpts.onSeatClaimed = cl;
  let session: HostSession;
  try {
    session = new HostSession(sOpts);
  } catch (e) {
    return fail('CORRUPT', `could not start the session: ${msg(e)}`);
  }
  // A fresh snapshot makes the next restore cheap when we had to replay anything.
  persister?.attach(session, { checkpoint: source === 'replay' || replayedAfterCheckpoint > 0 });

  return {
    ok: true,
    session,
    header,
    roomCode: header.roomCode,
    intentCount: total,
    source,
    persister,
  };
}
