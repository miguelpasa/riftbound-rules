import { afterEach, describe, expect, it } from 'vitest';
import { actorToAct, type C2S, type Intent, type S2C } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { HostSession } from '../host/hostSession';
import { GuestSession, type KeyValueStorage } from '../net/guestSession';
import { createLoopbackHub } from '../net/loopbackTransport';
import { createHostBridge, guestGameApi, hostGameApi, MAX_RECENT_EVENTS } from './adapters';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function memStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function setup(sendTimeoutMs?: number) {
  const bridge = createHostBridge();
  const session = HostSession.create({
    cards: FIXTURE_CARDS,
    hostDeck: FIXTURE_DECK_A,
    guestDeck: FIXTURE_DECK_B,
    seed: 'adapter-test',
    mode: 'MULTIPLAYER',
    ...bridge.callbacks,
  });
  const host = hostGameApi(session, bridge, { cards: FIXTURE_CARDS });
  const hub = createLoopbackHub<S2C, C2S>();
  hub.hostOnConnection((t) => session.acceptGuest(t));
  const guestSession = new GuestSession({
    transport: hub.connectGuest(),
    storage: memStorage(),
  });
  const guest = guestGameApi(guestSession, FIXTURE_CARDS, sendTimeoutMs ? { sendTimeoutMs } : {});
  return { session, host, guest, guestSession, hub };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

async function actKeep(
  session: HostSession,
  host: ReturnType<typeof hostGameApi>,
  guest: ReturnType<typeof guestGameApi>,
): Promise<void> {
  const seat = actorToAct(session.getFullStateForPersistence());
  const api = (seat === session.hostSeat ? host : guest).getSnapshot()!;
  await api.send({ type: 'MULLIGAN', playerId: seat, cardIds: [] });
  await flush();
}

describe('hostGameApi / guestGameApi', () => {
  it('both sides see consistent views and legal actions', async () => {
    const { session, host, guest } = setup();
    disposers.push(() => session.dispose());
    expect(guest.getSnapshot()).toBeNull(); // no view until the handshake completes
    await flush();
    const h = host.getSnapshot()!;
    const g = guest.getSnapshot()!;
    expect(h.seat).toBe(session.hostSeat);
    expect(g.seat).toBe(session.guestSeat);
    expect(g.connection).toBe('connected');
    expect(h.opponentConnected).toBe(true);
    expect(h.view.turn.phase).toBe(g.view.turn.phase);
    expect(h.view.players.map((p) => p.id)).toEqual(g.view.players.map((p) => p.id));
    // Exactly the actor has legal actions in the mulligan.
    const actor = actorToAct(session.getFullStateForPersistence());
    expect((actor === h.seat ? h : g).legal.length).toBeGreaterThan(0);
    expect((actor === h.seat ? g : h).legal).toEqual([]);
    // The opponent hand is hidden from both sides.
    const opp = h.view.players.find((p) => p.id !== h.seat)!;
    expect(opp.hand.every((id) => 'hidden' in (h.view.objects[id] ?? {}))).toBe(true);
  });

  it('snapshots are stable until something changes, then notify subscribers', async () => {
    const { session, host, guest } = setup();
    disposers.push(() => session.dispose());
    await flush();
    const a = host.getSnapshot();
    expect(host.getSnapshot()).toBe(a);
    let hostNotes = 0;
    let guestNotes = 0;
    host.subscribe(() => hostNotes++);
    guest.subscribe(() => guestNotes++);
    const gBefore = guest.getSnapshot();
    expect(guest.getSnapshot()).toBe(gBefore);
    await actKeep(session, host, guest);
    expect(hostNotes).toBeGreaterThan(0);
    expect(guestNotes).toBeGreaterThan(0);
    expect(host.getSnapshot()).not.toBe(a);
    expect(guest.getSnapshot()).not.toBe(gBefore);
  });

  it('send() resolves ok for legal intents on both sides and a RuleError for rejected ones', async () => {
    const { session, host, guest } = setup();
    disposers.push(() => session.dispose());
    await flush();
    const h = host.getSnapshot()!;
    const g = guest.getSnapshot()!;
    const actor = actorToAct(session.getFullStateForPersistence());
    const [actorApi, otherApi] = actor === h.seat ? [h, g] : [g, h];
    // Out of turn: rejected with the engine's error on either side.
    const bad: Intent = { type: 'MULLIGAN', playerId: otherApi.seat, cardIds: [] };
    const rejected = await otherApi.send(bad);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBeTruthy();
    // In turn: accepted.
    const good: Intent = { type: 'MULLIGAN', playerId: actorApi.seat, cardIds: [] };
    expect(await actorApi.send(good)).toEqual({ ok: true });
    await flush();
    // Both views advanced.
    expect(host.getSnapshot()!.view.mulligan?.done.length).toBe(1);
    expect(guest.getSnapshot()!.view.mulligan?.done.length).toBe(1);
  });

  it('guest send() resolves with a RuleError when the link is down', async () => {
    const { session, guest, hub } = setup(30);
    disposers.push(() => session.dispose());
    await flush();
    const g = guest.getSnapshot()!;
    hub.dropCurrent();
    await flush();
    const r = await guest.getSnapshot()!.send({ type: 'PASS_PRIORITY', playerId: g.seat });
    expect(r.ok).toBe(false);
  });

  it('guest send() times out with a RuleError when the host never answers', async () => {
    const { session, guest, guestSession } = setup(30);
    disposers.push(() => session.dispose());
    await flush();
    const g = guest.getSnapshot()!;
    // An intent the host will drop silently (duplicate clientSeq is answered with STATE, so use a
    // detached transport instead): sever the host's side of the link without telling the guest.
    session.dispose();
    const r = await g.send({ type: 'PASS_PRIORITY', playerId: g.seat });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/did not answer|Not connected|Rule Error/i);
    void guestSession;
  });

  it('keeps at most 50 recent events per seat', async () => {
    const { session, host } = setup();
    disposers.push(() => session.dispose());
    for (let i = 0; i < 150 && host.getSnapshot()!.view.gameStatus === 'IN_PROGRESS'; i++) {
      const state = session.getFullStateForPersistence();
      const seat = actorToAct(state);
      const legal = session.getLegal(seat);
      const pick =
        legal.find((x) => x.type === 'MULLIGAN' && x.cardIds.length === 0) ??
        legal.find((x) => x.type === 'END_TURN' || x.type === 'PASS_PRIORITY') ??
        legal[0];
      if (!pick) break;
      session.forceIntent(seat, pick);
    }
    const events = host.getSnapshot()!.recentEvents;
    expect(events.length).toBeLessThanOrEqual(MAX_RECENT_EVENTS);
    expect(events.length).toBeGreaterThan(0);
  }, 30_000);

  it('reports opponent presence and game over', async () => {
    const { session, host, guest, hub } = setup();
    disposers.push(() => session.dispose());
    await flush();
    expect(host.getSnapshot()!.opponentConnected).toBe(true);
    hub.dropCurrent();
    await flush();
    expect(host.getSnapshot()!.opponentConnected).toBe(false);
    expect(guest.getSnapshot()!.connection).toBe('closed');
    const h = host.getSnapshot()!;
    await h.send({ type: 'CONCEDE', playerId: h.seat });
    expect(host.getSnapshot()!.gameOver).toEqual({ winner: session.guestSeat });
  });
});
