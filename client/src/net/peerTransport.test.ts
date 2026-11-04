import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_VERSION, PROTOCOL_VERSION, type C2S, type S2C } from '@riftbound/engine';
import { FakeBroker, type FakeDataConnection } from './fakePeer.js';
import {
  backoffDelay,
  connectGuestPeer,
  createHostPeer,
  TransportNotOpenError,
  type GuestTransport,
  type HostPeer,
  type HostTransport,
} from './peerTransport.js';
import { peerIdFromRoomCode } from './roomCode.js';
import type { TransportStatus } from './transport.js';

const CODE = 'K7QWXZ';
const HOST_ID = peerIdFromRoomCode(CODE);
const HELLO: C2S = {
  type: 'HELLO',
  protocolVersion: PROTOCOL_VERSION,
  engineVersion: ENGINE_VERSION,
};
const WELCOME: S2C = { type: 'WELCOME', seat: 'p1', seatToken: 'tok' };

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

let broker: FakeBroker;
const cleanup: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  broker = new FakeBroker();
});
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  vi.useRealTimers();
});

function newHost(): { host: HostPeer; conns: HostTransport[]; got: C2S[]; statuses: string[] } {
  const host = createHostPeer(CODE, { peerFactory: broker.factory, random: () => 0.5 });
  cleanup.push(() => host.destroy());
  const conns: HostTransport[] = [];
  const got: C2S[] = [];
  const statuses: string[] = [];
  host.onConnection((t) => {
    conns.push(t);
    t.onMessage((m) => got.push(m));
  });
  host.onStatus((s, d) => statuses.push(`${s}:${d}`));
  return { host, conns, got, statuses };
}

/** autoHello mimics the session: HELLO is sent on every 'open'. */
function newGuest(autoHello = true): {
  guest: GuestTransport;
  statuses: TransportStatus[];
  got: S2C[];
} {
  const guest = connectGuestPeer(CODE, { peerFactory: broker.factory, random: () => 0.5 });
  cleanup.push(() => guest.close());
  const statuses: TransportStatus[] = [guest.status];
  const got: S2C[] = [];
  guest.onStatus((s) => statuses.push(s));
  guest.onMessage((m) => got.push(m));
  if (autoHello) guest.onStatus((s) => s === 'open' && guest.send(HELLO));
  return { guest, statuses, got };
}

// Tests: backoff, handshake + messaging, reconnect, id-taken retry, heartbeat, replacement, bad frames.
describe('backoffDelay', () => {
  it('doubles from 500ms and caps at 15s with bounded jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, {}, mid))).toEqual([
      500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000,
    ]);
    for (let n = 0; n < 12; n++) {
      const lo = backoffDelay(n, {}, () => 0);
      const hi = backoffDelay(n, {}, () => 1);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(hi).toBeLessThanOrEqual(15000);
    }
  });
});

describe('host + guest over the fake broker', () => {
  it('connects, transfers messages both ways, and hides heartbeats', async () => {
    const { host, conns, got } = newHost();
    const { guest, statuses, got: guestGot } = newGuest();
    expect(guest.status).toBe('connecting');
    await advance(0);
    expect(host.status).toBe('open');
    expect(guest.status).toBe('open');
    expect(statuses).toEqual(['connecting', 'open']);

    expect(conns).toHaveLength(1);
    expect(got).toEqual([HELLO]);

    conns[0]?.send(WELCOME);
    await advance(0);
    expect(guestGot).toEqual([WELCOME]);

    // 60s of idle time: pings flow but never surface as messages, and the link stays up.
    await advance(60_000);
    expect(got).toEqual([HELLO]);
    expect(guestGot).toEqual([WELCOME]);
    expect(guest.status).toBe('open');
    expect(conns[0]?.status).toBe('open');
  });

  it('guest send throws while not open', async () => {
    newHost();
    const { guest } = newGuest(false);
    expect(() => guest.send(HELLO)).toThrow(TransportNotOpenError);
    await advance(0);
    expect(() => guest.send(HELLO)).not.toThrow();
  });

  it('guest retries (connecting) until the host appears', async () => {
    const { guest, statuses } = newGuest();
    await advance(0);
    expect(guest.status).toBe('connecting'); // peer-unavailable -> backing off
    await advance(5000);
    expect(guest.status).toBe('connecting');
    newHost();
    await advance(20_000);
    expect(guest.status).toBe('open');
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('host restart: guest goes connecting -> open -> reconnecting -> open', async () => {
    const first = newHost();
    const { guest, statuses } = newGuest();
    await advance(0);
    expect(first.got).toEqual([HELLO]);

    // Host browser crashes; broker still holds the room id for 3s.
    broker.crash(HOST_ID, 3000);
    first.host.destroy();
    await advance(0);
    expect(guest.status).toBe('reconnecting');

    const second = newHost(); // host reloads and re-registers the same room code
    await advance(0);
    expect(second.statuses).toContain('connecting:id-taken-retry');
    expect(second.host.status).toBe('connecting');

    await advance(30_000);
    expect(second.host.status).toBe('open');
    expect(guest.status).toBe('open');
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);

    await advance(0); // session re-sent HELLO on open
    expect(second.got).toEqual([HELLO]);
  });

  it('reconnect backoff grows and caps while the host is gone', async () => {
    const first = newHost();
    const { guest } = newGuest();
    await advance(0);
    broker.crash(HOST_ID);
    first.host.destroy();
    await advance(0);
    expect(guest.status).toBe('reconnecting');
    const before = broker.created.length;
    await advance(120_000);
    const attempts = broker.created.length - before;
    // 0.5,1,2,4,8 then 15s steps: ~5 + (120-15.5)/15 ~ 11-13 attempts, far below constant-500ms (240).
    expect(attempts).toBeGreaterThan(8);
    expect(attempts).toBeLessThan(16);
    expect(guest.status).toBe('reconnecting');
  });

  it('close() stops retrying and fires onClose once', async () => {
    const { guest, statuses } = newGuest();
    const closed = vi.fn();
    guest.onClose(closed);
    await advance(2000);
    guest.close();
    guest.close();
    const created = broker.created.length;
    await advance(60_000);
    expect(broker.created.length).toBe(created);
    expect(closed).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe('closed');
  });

  it('host retries a taken id with backoff and gives up after the deadline', async () => {
    broker.factory(HOST_ID); // squatter holding the id
    await advance(0);
    const { host, statuses } = newHost();
    await advance(0);
    expect(host.status).toBe('connecting');
    expect(statuses).toEqual(['connecting:id-taken-retry']);
    await advance(61_000);
    expect(host.status).toBe('closed');
    expect(statuses.at(-1)).toBe('closed:id-unavailable');
  });

  it('host takes the id as soon as it is released', async () => {
    broker.factory(HOST_ID);
    await advance(0);
    broker.crash(HOST_ID, 8000);
    const { host, statuses } = newHost();
    await advance(0);
    expect(host.status).toBe('connecting');
    await advance(20_000);
    expect(host.status).toBe('open');
    expect(statuses.at(-1)).toBe('open:listening');
  });

  it('heartbeat timeout triggers reconnecting on the guest and closes the host side', async () => {
    const { conns } = newHost();
    const { guest, statuses } = newGuest();
    await advance(0);
    const hostClosed = vi.fn();
    conns[0]?.onClose(hostClosed);

    // Silent network death: no close event, just no traffic.
    const guestPeer = broker.created.find((p) => p.id.startsWith('guest'));
    const conn = [...(guestPeer?.conns ?? [])][0] as FakeDataConnection;
    conn.blackhole();
    await advance(14_000);
    expect(guest.status).toBe('open'); // not yet: timeout is 15s of silence
    await advance(8000);
    expect(statuses).toContain('reconnecting');
    expect(hostClosed).toHaveBeenCalledOnce();

    // The new connection is healthy, so the guest recovers by itself.
    await advance(5000);
    expect(guest.status).toBe('open');
    expect(statuses.slice(0, 4)).toEqual(['connecting', 'open', 'reconnecting', 'open']);
  });

  it('only one guest at a time: a newer valid connection replaces the older', async () => {
    const { conns, got } = newHost();
    const g1 = newGuest();
    await advance(0);
    expect(conns).toHaveLength(1);
    const firstClosed = vi.fn();
    conns[0]?.onClose(firstClosed);

    // A second connection; the first guest would also auto-reconnect, so stop it to observe cleanly.
    const g2 = newGuest(false);
    await advance(0);
    expect(conns).toHaveLength(1); // not surfaced until it sends a valid frame
    expect(firstClosed).not.toHaveBeenCalled();
    g2.guest.send(HELLO);
    g1.guest.close();
    await advance(0);
    expect(conns).toHaveLength(2);
    expect(firstClosed).toHaveBeenCalled();
    expect(conns[0]?.status).toBe('closed');
    expect(conns[1]?.status).toBe('open');
    expect(got).toEqual([HELLO, HELLO]);

    conns[1]?.send(WELCOME);
    await advance(0);
    expect(g2.got).toEqual([WELCOME]);
    conns[0]?.send(WELCOME); // replaced connection is dead: no-op
    await advance(0);
    expect(g1.got).toEqual([]);
  });

  it('ignores connections whose first frame is invalid and closes them', async () => {
    const { conns } = newHost();
    const raw = broker.factory();
    await advance(0);
    const c = raw.connect(HOST_ID);
    await advance(0);
    expect(c.open).toBe(true);
    c.send('garbage');
    await advance(0);
    expect(conns).toHaveLength(0);
    expect(c.open).toBe(false);
  });

  it('closes a connection that never says anything after the handshake timeout', async () => {
    const { conns } = newHost();
    const raw = broker.factory();
    await advance(0);
    const c = raw.connect(HOST_ID);
    await advance(0);
    expect(c.open).toBe(true);
    await advance(9000);
    expect(c.open).toBe(true);
    await advance(2000);
    expect(c.open).toBe(false);
    expect(conns).toHaveLength(0);
  });

  it('drops malformed inbound frames on both sides but keeps the link', async () => {
    const { conns, got } = newHost();
    const { guest, got: guestGot } = newGuest();
    await advance(0);

    const guestPeer = broker.created.find((p) => p.id.startsWith('guest'));
    const gc = [...(guestPeer?.conns ?? [])][0] as FakeDataConnection;
    const hc = gc.other as FakeDataConnection;
    gc.send('not json');
    gc.send(JSON.stringify({ type: 'NOPE' }));
    gc.send(JSON.stringify({ type: 'REQUEST_RESYNC', __proto__x: 1 }));
    gc.send('{"type":"REQUEST_RESYNC","__proto__":{"a":1}}');
    gc.send(42);
    gc.send(JSON.stringify({ type: 'REQUEST_RESYNC', pad: 'x'.repeat(300_000) }));
    hc.send('not json');
    hc.send(JSON.stringify({ type: 'WELCOME', seat: 'p9', seatToken: 'x' }));
    hc.send(JSON.stringify(WELCOME));
    await advance(0);
    expect(got.map((m) => m.type)).toEqual(['HELLO', 'REQUEST_RESYNC']); // only the harmless extra-key one
    expect(guestGot).toEqual([WELCOME]);
    expect(conns[0]?.status).toBe('open');
    expect(guest.status).toBe('open');
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it('host destroy closes the active guest and frees the id', async () => {
    const { host, conns } = newHost();
    const { guest } = newGuest();
    await advance(0);
    expect(guest.status).toBe('open');
    host.destroy();
    expect(conns[0]?.status).toBe('closed');
    expect(host.status).toBe('closed');
    expect(broker.peers.has(HOST_ID)).toBe(false);
  });

  it('host marks reconnecting when the broker drops and recovers on its own', async () => {
    const { host, statuses } = newHost();
    await advance(0);
    expect(host.status).toBe('open');
    broker.setOnline(false);
    await advance(0);
    expect(host.status).toBe('reconnecting');
    await advance(5000);
    broker.setOnline(true);
    await advance(40_000);
    expect(host.status).toBe('open');
    expect(statuses).toContain('reconnecting:broker-disconnected');
    expect(statuses.at(-1)).toBe('open:listening');
  });
});
