import { afterEach, describe, expect, it } from 'vitest';
import { actorToAct } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { MemoryGameStorage } from '../host/persistence';
import { GuestSession, type KeyValueStorage } from '../net/guestSession';
import { FakeBroker } from '../net/fakePeer';
import { connectGuestPeer } from '../net/peerTransport';
import { guestGameApi } from './adapters';
import { openHostLobby, resumeSavedGame, startSoloGame, type HostEnv } from './hostGame';

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await wait(5);
  }
}

function memStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function makeEnv(broker: FakeBroker, storage = new MemoryGameStorage()) {
  const errors: string[] = [];
  const env: HostEnv = {
    cards: FIXTURE_CARDS,
    storage,
    peerFactory: broker.factory,
    createBot: () => ({ decide: () => null }),
    botDelayMs: 0,
    onError: (t) => errors.push(t),
  };
  return { env, errors, storage };
}

function joinAs(broker: FakeBroker, code: string, deck = FIXTURE_DECK_B) {
  const transport = connectGuestPeer(code, { peerFactory: broker.factory });
  const guest = new GuestSession({ transport, storage: memStorage(), deck });
  cleanups.push(() => guest.close());
  return guest;
}

describe('multiplayer lobby', () => {
  it('starts the game with the guest deck from HELLO and serves both sides', async () => {
    const broker = new FakeBroker();
    const { env, storage } = makeEnv(broker);
    const lobby = openHostLobby(env, { deck: FIXTURE_DECK_A, timersEnabled: false });
    cleanups.push(() => lobby.dispose());
    await until(() => lobby.state.get().peer.detail === 'listening', 'host listening');
    expect(lobby.state.get().peer.message).toBe('Waiting for opponent...');
    expect(lobby.state.get().game).toBeNull();

    const guest = joinAs(broker, lobby.roomCode);
    await until(() => lobby.state.get().game !== null, 'game start');
    const game = lobby.state.get().game!;
    cleanups.push(() => game.dispose());
    await until(() => guest.view !== null && guest.seat !== null, 'guest view');

    // The guest's deck is the one it sent (its legend is in its own seat).
    const state = game.session.getFullStateForPersistence();
    const guestPlayer = state.players.find((p) => p.id === game.session.guestSeat)!;
    const hostPlayer = state.players.find((p) => p.id === game.session.hostSeat)!;
    expect(Object.values(state.objects).some((o) => o.cardId === FIXTURE_DECK_B.legendId)).toBe(
      true,
    );
    expect(guestPlayer.id).not.toBe(hostPlayer.id);

    const adapter = guestGameApi(guest, FIXTURE_CARDS);
    expect(adapter.getSnapshot()?.seat).toBe(game.session.guestSeat);
    expect(game.adapter.getSnapshot()?.opponentConnected).toBe(true);

    // The persisted header carries both decks and the room code.
    await game.dispose();
    const list = await storage.listGames();
    expect(list).toHaveLength(1);
    const loaded = await storage.loadGame(list[0]!.gameId);
    expect(loaded?.header.roomCode).toBe(lobby.roomCode);
    expect(loaded?.header.decks[1]).toEqual(FIXTURE_DECK_B);
  });

  it('turns away a guest with an illegal deck and keeps waiting', async () => {
    const broker = new FakeBroker();
    const { env } = makeEnv(broker);
    const lobby = openHostLobby(env, { deck: FIXTURE_DECK_A, timersEnabled: false });
    cleanups.push(() => lobby.dispose());
    await until(() => lobby.state.get().peer.detail === 'listening', 'host listening');

    const bad = joinAs(broker, lobby.roomCode, { ...FIXTURE_DECK_B, mainDeck: [] });
    await until(() => bad.refusal !== null, 'refusal');
    expect(bad.refusal?.code).toBe('DECK_ILLEGAL');
    expect(lobby.state.get().game).toBeNull();
    expect(lobby.state.get().rejected).toMatch(/deck/i);

    const good = joinAs(broker, lobby.roomCode);
    await until(() => lobby.state.get().game !== null, 'game start');
    cleanups.push(() => lobby.state.get().game!.dispose());
    await until(() => good.view !== null, 'guest view');
  });

  it('lets the guest rejoin the running game with its seat token', async () => {
    const broker = new FakeBroker();
    const { env } = makeEnv(broker);
    const lobby = openHostLobby(env, { deck: FIXTURE_DECK_A, timersEnabled: false });
    cleanups.push(() => lobby.dispose());
    await until(() => lobby.state.get().peer.detail === 'listening', 'host listening');
    const storage = memStorage();
    const t1 = connectGuestPeer(lobby.roomCode, { peerFactory: broker.factory });
    const g1 = new GuestSession({ transport: t1, storage, deck: FIXTURE_DECK_B });
    await until(() => lobby.state.get().game !== null, 'game start');
    const game = lobby.state.get().game!;
    cleanups.push(() => game.dispose());
    await until(() => g1.view !== null, 'first view');
    g1.close();
    await until(() => game.adapter.getSnapshot()?.opponentConnected === false, 'opponent left');
    const t2 = connectGuestPeer(lobby.roomCode, { peerFactory: broker.factory });
    const g2 = new GuestSession({ transport: t2, storage });
    cleanups.push(() => g2.close());
    await until(() => g2.view !== null, 'rejoined view');
    expect(g2.seat).toBe(game.session.guestSeat);
  });
});

describe('solo and resume', () => {
  it('runs the bot on the guest seat and resumes the saved game', async () => {
    const broker = new FakeBroker();
    const { env, storage } = makeEnv(broker);
    const game = startSoloGame(env, {
      deck: FIXTURE_DECK_A,
      botDeck: FIXTURE_DECK_B,
      difficulty: 'easy',
      seed: 'solo-test',
      timersEnabled: false,
    });
    cleanups.push(() => game.dispose());
    // Let the human keep their hand whenever it is their turn; the bot must answer on its own.
    const humanSeat = game.session.hostSeat;
    await until(() => {
      const st = game.session.getFullStateForPersistence();
      if (actorToAct(st) === humanSeat && st.gameStatus === 'IN_PROGRESS') {
        const keep = game.session.getLegal(humanSeat).find((i) => i.type === 'MULLIGAN');
        if (keep) game.session.localIntent({ type: 'MULLIGAN', playerId: humanSeat, cardIds: [] });
      }
      return st.turn.phase !== 'MULLIGAN';
    }, 'mulligan to finish');
    await game.dispose();

    const list = await storage.listGames();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('IN_PROGRESS');
    const res = await resumeSavedGame(env, list[0]!.gameId, { timersEnabled: false });
    expect(res.ok).toBe(true);
    if (res.ok) {
      cleanups.push(() => res.game.dispose());
      const snap = res.game.adapter.getSnapshot()!;
      expect(snap.view.turn.phase).not.toBe('MULLIGAN');
      expect(snap.opponentConnected).toBe(true);
    }
  });

  it('refuses to resume an unknown game with a readable message', async () => {
    const { env } = makeEnv(new FakeBroker());
    const res = await resumeSavedGame(env, 'nope', { timersEnabled: false });
    expect(res).toMatchObject({ ok: false });
  });
});
