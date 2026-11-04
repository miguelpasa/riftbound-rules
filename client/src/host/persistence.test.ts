import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ENGINE_VERSION, stateHash, type Intent } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { createLoopbackHub } from '../net/loopbackTransport.js';
import { GuestSession, type KeyValueStorage } from '../net/guestSession.js';
import type { C2S, S2C } from '@riftbound/engine';
import type { HostSession } from './hostSession.js';
import {
  CHECKPOINTS_KEPT,
  IndexedDbGameStorage,
  MemoryGameStorage,
  openGameStorage,
  restoreHostSession,
  startPersistedHost,
  type GameHeader,
  type GameStorage,
  type StoredCheckpoint,
  type StoredIntent,
} from './persistence.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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

function pick(rng: () => number, list: Intent[]): Intent {
  const end = list.filter((i) => i.type === 'END_TURN' || i.type === 'PASS_PRIORITY');
  if (end.length > 0 && rng() < 0.35) return end[Math.floor(rng() * end.length)] as Intent;
  return list[Math.floor(rng() * list.length)] as Intent;
}

/** One random step for whichever seat must act (the test drives both seats itself). */
function step(host: HostSession, rng: () => number): boolean {
  const actor = host.getActor();
  const list = host.getLegal(actor);
  if (list.length === 0) return false;
  const intent = pick(rng, list);
  const res =
    actor === host.hostSeat
      ? host.localIntent(intent)
      : (host as unknown as { apply(s: string, i: Intent): { ok: boolean } }).apply(actor, intent);
  return res.ok;
}

const live = (h: HostSession) => h.getFullStateForPersistence();

/** Counts calls per storage method, optionally failing them. */
class CountingStorage implements GameStorage {
  calls: Record<string, number> = {};
  failFirst = 0; // fail this many write calls, then recover
  failAlways = false;
  constructor(readonly inner: GameStorage) {}
  private async wrap<T>(name: string, write: boolean, fn: () => Promise<T>): Promise<T> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (write && this.failAlways) throw new Error('disk on fire');
    if (write && this.failFirst > 0) {
      this.failFirst--;
      throw new Error('transient');
    }
    return fn();
  }
  createGame = (h: GameHeader) => this.wrap('createGame', true, () => this.inner.createGame(h));
  updateHeader: GameStorage['updateHeader'] = (g, p) =>
    this.wrap('updateHeader', true, () => this.inner.updateHeader(g, p));
  appendIntents = (g: string, e: StoredIntent[]) =>
    this.wrap('appendIntents', true, () => this.inner.appendIntents(g, e));
  saveCheckpoint = (g: string, c: StoredCheckpoint) =>
    this.wrap('saveCheckpoint', true, () => this.inner.saveCheckpoint(g, c));
  loadGame = (g: string) => this.wrap('loadGame', false, () => this.inner.loadGame(g));
  listGames = () => this.wrap('listGames', false, () => this.inner.listGames());
  finishGame: GameStorage['finishGame'] = (g, w) =>
    this.wrap('finishGame', true, () => this.inner.finishGame(g, w));
  deleteGame = (g: string) => this.wrap('deleteGame', true, () => this.inner.deleteGame(g));
}

/** Same data, but loadGame hides the checkpoint (forces a replay from the seed). */
function withoutCheckpoints(s: GameStorage): GameStorage {
  return {
    createGame: (h) => s.createGame(h),
    updateHeader: (g, p) => s.updateHeader(g, p),
    appendIntents: (g, e) => s.appendIntents(g, e),
    saveCheckpoint: (g, c) => s.saveCheckpoint(g, c),
    listGames: () => s.listGames(),
    finishGame: (g, w) => s.finishGame(g, w),
    deleteGame: (g) => s.deleteGame(g),
    loadGame: async (g) => {
      const l = await s.loadGame(g);
      if (l) delete l.checkpoint;
      return l;
    },
  };
}

function newHost(storage: GameStorage, seed: string, onError?: (e: unknown, op: string) => void) {
  return startPersistedHost({
    storage,
    cards: FIXTURE_CARDS,
    hostDeck: FIXTURE_DECK_A,
    guestDeck: FIXTURE_DECK_B,
    seed,
    mode: 'SOLO',
    debounceMs: 5,
    ...(onError ? { onError } : {}),
  });
}

async function restoreHash(storage: GameStorage, gameId: string): Promise<string> {
  const r = await restoreHostSession(storage, gameId, FIXTURE_CARDS, {}, { persist: false });
  if (!r.ok) throw new Error(`restore failed: ${r.code} ${r.message}`);
  return stateHash(live(r.session));
}

describe('restore equals live (event sourcing)', () => {
  it.each(['n3-a', 'n3-b', 'n3-c'])(
    'restores at many points of a full random game (%s)',
    async (seed) => {
      const storage = new MemoryGameStorage();
      const { session, persister, header } = newHost(storage, seed);
      const rng = mulberry32(seed.charCodeAt(3));
      let checked = 0;
      let midCombat = 0;
      let midChain = 0;
      for (let i = 0; i < 4000 && live(session).gameStatus === 'IN_PROGRESS'; i++) {
        if (i === 3500) {
          session.localIntent({ type: 'CONCEDE', playerId: session.hostSeat });
          break;
        }
        if (!step(session, rng)) break;
        const st = live(session);
        const combat = st.flow.combat != null;
        if (combat) midCombat++;
        if (st.flow.chain.length > 0) midChain++;
        // Check at a few fixed steps, at every start of combat, and now and then.
        if (i === 0 || i === 1 || i === 7 || i % 9 === 0 || (combat && midCombat % 5 === 1)) {
          await persister.flush();
          const want = stateHash(live(session));
          expect(await restoreHash(storage, header.gameId), `step ${i}`).toBe(want);
          expect(await restoreHash(withoutCheckpoints(storage), header.gameId), `replay ${i}`).toBe(
            want,
          );
          checked++;
        }
      }
      await persister.flush();
      expect(stateHash(live(session))).toBe(await restoreHash(storage, header.gameId));
      expect(checked).toBeGreaterThan(4);
      expect(midCombat + midChain).toBeGreaterThan(0);
      const game = await storage.loadGame(header.gameId);
      expect(game?.header.status).toBe('FINISHED');
      expect(game?.intents.map((e) => e.index)).toEqual(game?.intents.map((_, k) => k));
    },
    120_000,
  );

  it('restored sessions keep persisting and can be restored again', async () => {
    const storage = new MemoryGameStorage();
    const { session, persister, header } = newHost(storage, 'again');
    const rng = mulberry32(5);
    for (let i = 0; i < 30; i++) step(session, rng);
    await persister.flush();
    const r1 = await restoreHostSession(
      storage,
      header.gameId,
      FIXTURE_CARDS,
      {},
      { debounceMs: 5 },
    );
    if (!r1.ok) throw new Error(r1.message);
    expect(r1.intentCount).toBe(30);
    for (let i = 0; i < 30; i++) step(r1.session, rng);
    await r1.persister?.flush();
    const want = stateHash(live(r1.session));
    expect(await restoreHash(storage, header.gameId)).toBe(want);
    expect(await restoreHash(withoutCheckpoints(storage), header.gameId)).toBe(want);
    const g = await storage.loadGame(header.gameId);
    expect(g?.intents).toHaveLength(r1.persister!.intentCount);
    expect(r1.persister!.intentCount).toBeGreaterThan(40);
  });
});

describe('write behaviour', () => {
  it('checkpoints once per turn, not per intent', async () => {
    const counting = new CountingStorage(new MemoryGameStorage());
    const { session, persister } = newHost(counting, 'cadence');
    const rng = mulberry32(11);
    let n = 0;
    while (live(session).gameStatus === 'IN_PROGRESS' && n < 600 && step(session, rng)) n++;
    await persister.flush();
    const turns = live(session).turn.number;
    const cps = counting.calls.saveCheckpoint ?? 0;
    expect(turns).toBeGreaterThan(2);
    // initial + one per turn change (+ at most one for the game end)
    expect(cps).toBeLessThanOrEqual(turns + 2);
    expect(cps).toBeGreaterThanOrEqual(turns);
    expect(cps).toBeLessThan(n / 2);
    const g = await counting.inner.loadGame((await counting.inner.listGames())[0]!.gameId);
    expect(g?.checkpoint?.turnNumber).toBe(live(session).turn.number);
  });

  it('batches intents into few storage transactions', async () => {
    const counting = new CountingStorage(new MemoryGameStorage());
    const { session, persister } = newHost(counting, 'batch');
    const rng = mulberry32(3);
    let n = 0;
    for (; n < 80 && step(session, rng); n++);
    expect(n).toBeGreaterThan(40);
    expect(counting.calls.appendIntents ?? 0).toBe(0); // nothing flushed synchronously
    await persister.flush();
    expect(counting.calls.appendIntents).toBe(1);
    expect(counting.calls.createGame).toBe(1);
    // Debounce timer path: more intents, no explicit flush.
    for (let i = 0; i < 10; i++) step(session, rng);
    await new Promise((r) => setTimeout(r, 40));
    expect(counting.calls.appendIntents).toBe(2);
  });

  it('a failing storage never breaks the game and is reported', async () => {
    const counting = new CountingStorage(new MemoryGameStorage());
    counting.failAlways = true;
    const errors: string[] = [];
    const { session, persister } = newHost(counting, 'broken', (_e, op) => errors.push(op));
    const rng = mulberry32(9);
    for (let i = 0; i < 40; i++) expect(step(session, rng)).toBe(true);
    for (let i = 0; i < 10; i++) await persister.flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(live(session).turn.number).toBeGreaterThanOrEqual(0);
    expect(step(session, rng)).toBe(true);
  });

  it('retries transient failures without losing intents', async () => {
    const counting = new CountingStorage(new MemoryGameStorage());
    const errors: unknown[] = [];
    const { session, persister, header } = newHost(counting, 'flaky', (e) => errors.push(e));
    counting.failFirst = 2; // createGame fails twice, then everything works
    const rng = mulberry32(21);
    for (let i = 0; i < 30; i++) step(session, rng);
    for (let i = 0; i < 6; i++) await persister.flush();
    expect(errors).toEqual([]);
    const g = await counting.inner.loadGame(header.gameId);
    expect(g?.intents).toHaveLength(30);
    expect(await restoreHash(counting.inner, header.gameId)).toBe(stateHash(live(session)));
  });

  it('openGameStorage falls back to memory without IndexedDB', async () => {
    const errors: string[] = [];
    const r = await openGameStorage((_e, op) => errors.push(op), {
      factory: undefined,
      keyRange: undefined,
    });
    // Node has no global indexedDB, so this is the fallback path.
    expect(r.persistent).toBe(false);
    expect(r.storage).toBeInstanceOf(MemoryGameStorage);
    expect(errors).toEqual(['openGameStorage']);
  });
});

describe('restore errors', () => {
  async function seeded(): Promise<{ storage: MemoryGameStorage; id: string }> {
    const storage = new MemoryGameStorage();
    const { session, persister, header } = newHost(storage, 'errs');
    const rng = mulberry32(2);
    for (let i = 0; i < 25; i++) step(session, rng);
    await persister.flush();
    return { storage, id: header.gameId };
  }

  it('NOT_FOUND', async () => {
    const r = await restoreHostSession(new MemoryGameStorage(), 'nope', FIXTURE_CARDS);
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('engine version mismatch is a clear error, not a crash', async () => {
    const { storage, id } = await seeded();
    await storage.updateHeader(id, {});
    const g = (storage as unknown as { games: Map<string, { header: GameHeader }> }).games.get(id)!;
    g.header.engineVersion = '0.0.0-old';
    const r = await restoreHostSession(storage, id, FIXTURE_CARDS);
    expect(r).toMatchObject({ ok: false, code: 'ENGINE_VERSION_MISMATCH' });
    if (!r.ok) expect(r.message).toContain(ENGINE_VERSION);
  });

  it('a corrupt checkpoint falls back to replaying the log', async () => {
    const { storage, id } = await seeded();
    await storage.saveCheckpoint(id, { intentCount: 9999, turnNumber: 99, stateJson: '{not json' });
    const r = await restoreHostSession(storage, id, FIXTURE_CARDS, {}, { persist: false });
    expect(r.ok && r.source).toBe('replay');
    expect(r.ok && r.intentCount).toBe(25);
  });

  it('a corrupt log and no checkpoint is a CORRUPT result', async () => {
    const { storage, id } = await seeded();
    const g = (
      storage as unknown as {
        games: Map<string, { intents: Map<number, StoredIntent>; checkpoints: unknown[] }>;
      }
    ).games.get(id)!;
    g.checkpoints = [];
    const e = g.intents.get(3)!;
    g.intents.set(3, {
      ...e,
      intent: { type: 'PLAY_CARD', playerId: e.seat, cardId: 'zzz' } as never,
    });
    const r = await restoreHostSession(storage, id, FIXTURE_CARDS);
    expect(r).toMatchObject({ ok: false, code: 'CORRUPT' });
  });

  it('a storage that throws on load is a STORAGE_ERROR result', async () => {
    const s = new CountingStorage(new MemoryGameStorage());
    s.loadGame = () => Promise.reject(new Error('boom'));
    expect(await restoreHostSession(s, 'x', FIXTURE_CARDS)).toMatchObject({
      ok: false,
      code: 'STORAGE_ERROR',
    });
  });
});

describe('storage contract (memory + fake-indexeddb)', () => {
  const makers: Array<[string, () => Promise<GameStorage>]> = [
    ['memory', async () => new MemoryGameStorage()],
    [
      'indexeddb',
      () => IndexedDbGameStorage.open({ factory: new IDBFactory(), keyRange: IDBKeyRange }),
    ],
  ];

  describe.each(makers)('%s', (_name, make) => {
    const header = (id: string, createdAt: number): GameHeader => ({
      gameId: id,
      engineVersion: ENGINE_VERSION,
      seed: 's',
      decks: [FIXTURE_DECK_A, FIXTURE_DECK_B],
      hostSeat: 'p0',
      mode: 'MULTIPLAYER',
      createdAt,
      status: 'IN_PROGRESS',
    });
    const intent = (i: number): StoredIntent => ({
      index: i,
      intent: { type: 'PASS_PRIORITY', playerId: i % 2 ? 'p1' : 'p0' },
      seat: i % 2 ? 'p1' : 'p0',
      ...(i === 2 ? { clientSeq: 7 } : {}),
    });

    it('create / append / load / list / finish / delete', async () => {
      const s = await make();
      await s.createGame(header('a', 100));
      await s.createGame(header('b', 200));
      await s.appendIntents('a', [0, 1, 2].map(intent));
      await s.appendIntents('a', [3, 4].map(intent));
      await s.appendIntents('a', [4].map(intent)); // idempotent
      await s.appendIntents('b', [0].map(intent));

      const a = await s.loadGame('a');
      expect(a?.header.gameId).toBe('a');
      expect(a?.checkpoint).toBeUndefined();
      expect(a?.intents.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
      expect(a?.intents[2]?.clientSeq).toBe(7);
      expect(await s.loadGame('zzz')).toBeNull();

      await s.updateHeader('a', { roomCode: 'ROOM', guestSeatToken: 'tok' });
      expect((await s.loadGame('a'))?.header).toMatchObject({
        roomCode: 'ROOM',
        guestSeatToken: 'tok',
      });

      const list = await s.listGames();
      expect(list.map((g) => g.gameId)).toEqual(['b', 'a']);
      expect(list.find((g) => g.gameId === 'a')).toMatchObject({
        intentCount: 5,
        status: 'IN_PROGRESS',
        roomCode: 'ROOM',
      });

      await s.finishGame('a', 'p1');
      expect((await s.listGames()).find((g) => g.gameId === 'a')).toMatchObject({
        status: 'FINISHED',
        winner: 'p1',
      });

      await s.deleteGame('a');
      expect(await s.loadGame('a')).toBeNull();
      expect((await s.listGames()).map((g) => g.gameId)).toEqual(['b']);
      expect((await s.loadGame('b'))?.intents).toHaveLength(1); // other games untouched
    });

    it('keeps only the latest two checkpoints and returns the newest', async () => {
      const s = await make();
      await s.createGame(header('c', 1));
      for (const n of [0, 10, 20, 30]) {
        await s.saveCheckpoint('c', {
          intentCount: n,
          turnNumber: n / 10,
          stateJson: `{"n":${n}}`,
        });
      }
      expect(CHECKPOINTS_KEPT).toBe(2);
      expect((await s.loadGame('c'))?.checkpoint).toEqual({
        intentCount: 30,
        turnNumber: 3,
        stateJson: '{"n":30}',
      });
      // A game with its own checkpoints does not see another game's.
      await s.createGame(header('d', 2));
      expect((await s.loadGame('d'))?.checkpoint).toBeUndefined();
    });

    it('full persisted game restores, and a seat token survives', async () => {
      const s = await make();
      const { session, persister, header: h } = newHost(s, 'idb-' + _name);
      const rng = mulberry32(4);
      for (let i = 0; i < 150 && live(session).gameStatus === 'IN_PROGRESS'; i++)
        step(session, rng);
      persister.onSeatClaimed('seat-token-1');
      persister.updateHeader({ roomCode: 'ABCD' });
      await persister.flush();
      const r = await restoreHostSession(s, h.gameId, FIXTURE_CARDS, {}, { persist: false });
      if (!r.ok) throw new Error(r.message);
      expect(stateHash(live(r.session))).toBe(stateHash(live(session)));
      expect(r.roomCode).toBe('ABCD');
      expect(r.session.getGuestSeatToken()).toBe('seat-token-1');
      expect(r.session.hostSeat).toBe(session.hostSeat);
    });
  });
});

describe('guest rejoin after host restore', () => {
  afterEach(() => undefined);
  it('claims the seat through a real HELLO, persists the token, and the guest rejoins the restored host', async () => {
    const storage = new MemoryGameStorage();
    const started = startPersistedHost({
      storage,
      cards: FIXTURE_CARDS,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed: 'rejoin',
      mode: 'MULTIPLAYER',
      roomCode: 'RM12',
      debounceMs: 5,
    });
    const hub = createLoopbackHub<S2C, C2S>();
    hub.hostOnConnection((t) => started.session.acceptGuest(t));
    const kv = new Map<string, string>();
    const gstore: KeyValueStorage = {
      get: (k) => kv.get(k) ?? null,
      set: (k, v) => void kv.set(k, v),
    };
    const g1 = new GuestSession({ transport: hub.connectGuest(), storage: gstore });
    await flush();
    expect(g1.status).toBe('connected');
    const rng = mulberry32(6);
    for (let i = 0; i < 30; i++) step(started.session, rng);
    await flush();
    await started.persister.flush();
    g1.close();

    const r = await restoreHostSession(
      storage,
      started.header.gameId,
      FIXTURE_CARDS,
      {},
      { debounceMs: 5 },
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.roomCode).toBe('RM12');
    const hub2 = createLoopbackHub<S2C, C2S>();
    hub2.hostOnConnection((t) => r.session.acceptGuest(t));
    const g2 = new GuestSession({ transport: hub2.connectGuest(), storage: gstore });
    await flush();
    expect(g2.status).toBe('connected');
    expect(g2.seat).toBe(r.session.guestSeat);
    expect(g2.view).toEqual(r.session.getView(r.session.guestSeat));
    expect(g2.legal).toEqual(r.session.getLegal(r.session.guestSeat));
  });
});
