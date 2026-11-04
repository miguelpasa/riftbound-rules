import { describe, expect, it, vi } from 'vitest';
import { createLoopbackHub, createLoopbackPair } from './loopbackTransport.js';
import type { Transport } from './transport.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Tests: ordering, JSON round trip, async delivery, close/drop semantics, hub rejoin.
describe('loopback pair', () => {
  it('delivers asynchronously and in order', async () => {
    const { a, b } = createLoopbackPair<number, number>();
    const got: number[] = [];
    b.onMessage((m) => got.push(m));
    a.send(1);
    a.send(2);
    a.send(3);
    expect(got).toEqual([]);
    await tick();
    expect(got).toEqual([1, 2, 3]);
  });
  it('is bidirectional', async () => {
    const { a, b } = createLoopbackPair<string, string>();
    const ga: string[] = [];
    const gb: string[] = [];
    a.onMessage((m) => ga.push(m));
    b.onMessage((m) => gb.push(m));
    a.send('to-b');
    b.send('to-a');
    await tick();
    expect(ga).toEqual(['to-a']);
    expect(gb).toEqual(['to-b']);
  });
  it('round-trips through JSON (clones, strips undefined, catches non-serialisable)', async () => {
    const { a, b } = createLoopbackPair<unknown, unknown>();
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m));
    const original = { x: [1, { y: 2 }], u: undefined };
    a.send(original);
    await tick();
    expect(got[0]).toEqual({ x: [1, { y: 2 }] });
    expect(got[0]).not.toBe(original);
    expect(() => a.send({ n: 1n })).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => a.send(cyc)).toThrow();
  });
  it('supports unsubscribing', async () => {
    const { a, b } = createLoopbackPair<number, number>();
    const cb = vi.fn();
    const off = b.onMessage(cb);
    off();
    a.send(1);
    await tick();
    expect(cb).not.toHaveBeenCalled();
  });
  it('close() from either side fires onClose on both after queued messages', async () => {
    const { a, b } = createLoopbackPair<number, number>();
    const order: string[] = [];
    b.onMessage((m) => order.push(`msg${m}`));
    a.onClose(() => order.push('a-close'));
    b.onClose(() => order.push('b-close'));
    a.send(1);
    a.close();
    a.close(); // idempotent
    await tick();
    expect(order).toEqual(['msg1', 'a-close', 'b-close']);
    expect(a.status).toBe('closed');
    expect(b.status).toBe('closed');
    // sends after close are ignored
    a.send(2);
    b.send(3);
    await tick();
    expect(order).toHaveLength(3);

    const p = createLoopbackPair<number, number>();
    const closed = vi.fn();
    p.a.onClose(closed);
    p.b.close();
    await tick();
    expect(closed).toHaveBeenCalledOnce();
  });
  it('drop() discards in-flight messages and closes both', async () => {
    const pair = createLoopbackPair<number, number>();
    const msg = vi.fn();
    const closeA = vi.fn();
    const closeB = vi.fn();
    pair.b.onMessage(msg);
    pair.a.onClose(closeA);
    pair.b.onClose(closeB);
    pair.a.send(1);
    pair.drop();
    await tick();
    expect(msg).not.toHaveBeenCalled();
    expect(closeA).toHaveBeenCalledOnce();
    expect(closeB).toHaveBeenCalledOnce();
    expect(pair.closed).toBe(true);
  });
  it('reports status changes', async () => {
    const { a } = createLoopbackPair();
    const seen: string[] = [];
    a.onStatus((s) => seen.push(s));
    expect(a.status).toBe('open');
    a.close();
    await tick();
    expect(seen).toEqual(['closed']);
  });
});

describe('loopback hub', () => {
  it('accepts sequential guests (rejoin)', async () => {
    const hub = createLoopbackHub<string, string>();
    const hostSide: { t: Transport<string, string>; got: string[]; closed: boolean }[] = [];
    hub.hostOnConnection((t) => {
      const rec = { t, got: [] as string[], closed: false };
      t.onMessage((m) => rec.got.push(m));
      t.onClose(() => (rec.closed = true));
      hostSide.push(rec);
    });
    const g1 = hub.connectGuest();
    g1.send('hello1');
    await tick();
    expect(hostSide[0]?.got).toEqual(['hello1']);

    hub.dropCurrent();
    await tick();
    expect(hostSide[0]?.closed).toBe(true);

    const g2 = hub.connectGuest();
    const back: string[] = [];
    g2.onMessage((m) => back.push(m));
    g2.send('hello2');
    hostSide[1]?.t.send('welcome');
    await tick();
    expect(hostSide[1]?.got).toEqual(['hello2']);
    expect(hub.connectionCount).toBe(2);
    expect(back).toEqual(['welcome']);
  });
  it('closes the guest when nobody listens', async () => {
    const hub = createLoopbackHub();
    const g = hub.connectGuest();
    const closed = vi.fn();
    g.onClose(closed);
    await tick();
    expect(closed).toHaveBeenCalledOnce();
  });
});
