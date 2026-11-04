import { describe, expect, it } from 'vitest';
import { type C2S, type Intent, type S2C } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { HostSession } from '../host/hostSession.js';
import { GuestSession, type GuestStatus, type KeyValueStorage } from './guestSession.js';
import { createLoopbackHub, createLoopbackPair } from './loopbackTransport.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function memStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function setup() {
  const host = HostSession.create({
    cards: FIXTURE_CARDS,
    hostDeck: FIXTURE_DECK_A,
    guestDeck: FIXTURE_DECK_B,
    seed: 'guest-test',
    mode: 'MULTIPLAYER',
  });
  const hub = createLoopbackHub<S2C, C2S>();
  hub.hostOnConnection((t) => host.acceptGuest(t));
  return { host, hub };
}

describe('GuestSession', () => {
  // Tests: handshake stores seat+token, status goes connecting -> connected, view is kept.
  it('handshakes and persists seat and token', async () => {
    const { host, hub } = setup();
    const storage = memStorage();
    const g = new GuestSession({ transport: hub.connectGuest(), storage, storageKey: 'r1' });
    const seen: GuestStatus[] = [];
    g.onStatus((s) => seen.push(s));
    expect(g.status).toBe('connecting');
    await flush();
    expect(g.status).toBe('connected');
    expect(seen).toEqual(['connected']);
    expect(g.seat).toBe(host.guestSeat);
    expect(storage.map.get('r1:token')).toBe(host.getGuestSeatToken());
    expect(storage.map.get('r1:seat')).toBe(host.guestSeat);
    expect(g.view?.viewer).toBe(host.guestSeat);
  });

  // Tests: sendIntent refuses (-1) before the handshake, and clientSeq is monotonic across sessions.
  it('refuses to send when not connected and keeps clientSeq monotonic across reconnects', async () => {
    const { host, hub } = setup();
    const storage = memStorage();
    const g1 = new GuestSession({ transport: hub.connectGuest(), storage });
    const intent: Intent = { type: 'MULLIGAN', playerId: host.guestSeat, cardIds: [] };
    expect(g1.sendIntent(intent)).toBe(-1);
    await flush();
    expect(g1.sendIntent(intent)).toBe(1);
    expect(g1.sendIntent(intent)).toBe(2);
    await flush();
    hub.dropCurrent();
    await flush();
    expect(g1.status).toBe('closed');
    expect(g1.sendIntent(intent)).toBe(-1);
    const g2 = new GuestSession({ transport: hub.connectGuest(), storage });
    await flush();
    expect(g2.sendIntent(intent)).toBe(3);
  });

  // Tests: transport 'reconnecting' maps to host-away; 'open' re-sends HELLO with the saved token.
  it('derives host-away while reconnecting and re-handshakes on open', () => {
    const sentFrames: C2S[] = [];
    const statusCbs: Array<(s: 'open' | 'reconnecting') => void> = [];
    let status: 'open' | 'reconnecting' = 'open';
    const msgCbs: Array<(m: unknown) => void> = [];
    const fake = {
      get status() {
        return status;
      },
      send: (m: C2S) => void sentFrames.push(m),
      onMessage: (cb: (m: unknown) => void) => (msgCbs.push(cb), () => {}),
      onClose: () => () => {},
      onStatus: (cb: (s: 'open' | 'reconnecting') => void) => (statusCbs.push(cb), () => {}),
      close: () => {},
    };
    const g = new GuestSession({ transport: fake as never, storage: memStorage() });
    expect(sentFrames[0]).toMatchObject({ type: 'HELLO' });
    expect((sentFrames[0] as { seatToken?: string }).seatToken).toBeUndefined();
    const welcome = { type: 'WELCOME', seat: 'p1', seatToken: 'tok' };
    msgCbs.forEach((cb) => cb(welcome));
    expect(g.status).toBe('connected');
    status = 'reconnecting';
    statusCbs.forEach((cb) => cb('reconnecting'));
    expect(g.status).toBe('host-away');
    expect(g.sendIntent({ type: 'END_TURN', playerId: 'p1' })).toBe(-1);
    status = 'open';
    statusCbs.forEach((cb) => cb('open'));
    expect(sentFrames[1]).toMatchObject({ type: 'HELLO', seatToken: 'tok' });
    expect(g.status).toBe('connecting');
    msgCbs.forEach((cb) => cb(welcome));
    expect(g.status).toBe('connected');
  });

  // Tests: invalid inbound frames are ignored without throwing or changing state.
  it('drops invalid inbound frames', async () => {
    const pair = createLoopbackPair<C2S, unknown>();
    const g = new GuestSession({ transport: pair.a, storage: memStorage() });
    pair.b.send({ type: 'STATE', view: 'nope', events: [] });
    pair.b.send({ type: 'WHATEVER' });
    pair.b.send({ type: 'WELCOME', seat: 'p9', seatToken: 't' });
    await flush();
    expect(g.view).toBeNull();
    expect(g.seat).toBeNull();
    expect(g.status).toBe('connecting');
  });

  // Tests: a handshake refusal sets `refusal` and status closed; OPPONENT_STATUS and GAME_OVER reach listeners.
  it('surfaces refusals, opponent status and game over', async () => {
    const pair = createLoopbackPair<C2S, unknown>();
    const g = new GuestSession({ transport: pair.a, storage: memStorage() });
    const opp: boolean[] = [];
    g.onOpponentStatus((c) => opp.push(c));
    let over: unknown = null;
    g.onGameOver((w, r) => (over = { w, r }));
    pair.b.send({ type: 'OPPONENT_STATUS', connected: false });
    pair.b.send({ type: 'GAME_OVER', winner: 'p0', replayAvailable: true });
    pair.b.send({ type: 'REJECTED', clientSeq: 0, code: 'NOT_FOUND', message: 'x' });
    await flush();
    expect(opp).toEqual([false]);
    expect(over).toEqual({ w: 'p0', r: true });
    expect(g.refusal?.code).toBe('NOT_FOUND');
    expect(g.status).toBe('closed');
  });

  // Tests: a throwing storage degrades gracefully.
  it('tolerates a broken storage', async () => {
    const { hub } = setup();
    const bad: KeyValueStorage = {
      get: () => {
        throw new Error('no storage');
      },
      set: () => {
        throw new Error('no storage');
      },
    };
    const g = new GuestSession({ transport: hub.connectGuest(), storage: bad });
    await flush();
    expect(g.status).toBe('connected');
  });
});
