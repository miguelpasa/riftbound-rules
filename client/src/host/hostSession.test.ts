import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  ENGINE_VERSION,
  getLegalActions,
  sanitizeFor,
  type C2S,
  type GameEvent,
  type Intent,
  type PlayerId,
  type S2C,
} from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { findLeaks } from '../../../engine/src/testing/leakCheck.js';
import { createLoopbackHub } from '../net/loopbackTransport.js';
import { GuestSession, type KeyValueStorage } from '../net/guestSession.js';
import { HostSession, type BotLike, type CommitEntry } from './hostSession.js';

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

function memStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

interface Rig {
  host: HostSession;
  hub: ReturnType<typeof createLoopbackHub<S2C, C2S>>;
  /** Everything the host sent to any guest connection (parsed, in order). */
  sent: S2C[];
  commits: CommitEntry[];
  status: boolean[];
}

function makeRig(seed = 'host-test'): Rig {
  const commits: CommitEntry[] = [];
  const status: boolean[] = [];
  const sent: S2C[] = [];
  const host = HostSession.create({
    cards: FIXTURE_CARDS,
    hostDeck: FIXTURE_DECK_A,
    guestDeck: FIXTURE_DECK_B,
    seed,
    mode: 'MULTIPLAYER',
    onCommit: (e) => commits.push(e),
    onOpponentStatus: (c) => status.push(c),
  });
  const hub = createLoopbackHub<S2C, C2S>();
  hub.hostOnConnection((t) => {
    const orig = t.send.bind(t);
    t.send = (m: S2C) => {
      // Leak check against the authoritative state at the moment of sending.
      const leaks = findLeaks(m, host.getFullStateForPersistence(), host.guestSeat, {
        cardNames: Object.fromEntries(
          Object.entries(FIXTURE_CARDS).map(([id, c]) => [id, (c as { name: string }).name]),
        ),
      });
      // Card names shared between decks / visible zones are filtered by findLeaks itself.
      expect(leaks, JSON.stringify(m).slice(0, 200)).toEqual([]);
      sent.push(JSON.parse(JSON.stringify(m)) as S2C);
      orig(m);
    };
    host.acceptGuest(t);
  });
  return { host, hub, sent, commits, status };
}

function join(rig: Rig, storage = memStorage()): GuestSession {
  return new GuestSession({ transport: rig.hub.connectGuest(), storage });
}

/** Legal actions for `seat` computed by the test from the full state (test-only privilege). */
function legal(host: HostSession, seat: PlayerId): Intent[] {
  return getLegalActions(host.getFullStateForPersistence(), FIXTURE_CARDS, seat);
}

function pick(rng: () => number, list: Intent[]): Intent {
  // Bias towards ending the turn / passing so games progress.
  const end = list.filter((i) => i.type === 'END_TURN' || i.type === 'PASS_PRIORITY');
  if (end.length > 0 && rng() < 0.35) return end[Math.floor(rng() * end.length)] as Intent;
  return list[Math.floor(rng() * list.length)] as Intent;
}

describe('HostSession handshake', () => {
  // Tests: first guest gets the non-host seat, token, and a sanitized STATE.
  it('welcomes the first guest and sends a sanitized state', async () => {
    const rig = makeRig();
    const guest = join(rig);
    await flush();
    expect(guest.seat).toBe(rig.host.guestSeat);
    expect(guest.status).toBe('connected');
    expect(guest.view).toEqual(
      sanitizeFor(rig.host.getFullStateForPersistence(), rig.host.guestSeat),
    );
    expect(rig.sent.map((m) => m.type)).toEqual(['WELCOME', 'STATE']);
    expect(rig.status).toEqual([true]);
    expect(rig.host.hostSeat).not.toBe(rig.host.guestSeat);
  });

  // Tests: protocol mismatch -> REJECTED + close.
  it('rejects a protocol mismatch', async () => {
    const rig = makeRig();
    const t = rig.hub.connectGuest();
    const got: S2C[] = [];
    let closed = false;
    t.onMessage((m) => got.push(m as S2C));
    t.onClose(() => (closed = true));
    t.send({ type: 'HELLO', protocolVersion: PROTOCOL_VERSION + 1, engineVersion: ENGINE_VERSION });
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'REJECTED', code: 'ENGINE_VERSION_MISMATCH' });
    expect(closed).toBe(true);
    expect(rig.host.getGuestSeatToken()).toBeNull();
  });

  // Tests: no token / wrong token on a claimed seat is refused, and the legit guest is untouched.
  it('rejects no/incorrect token once the seat is claimed', async () => {
    const rig = makeRig();
    const guest = join(rig);
    await flush();
    for (const seatToken of [undefined, 'deadbeef', rig.host.getGuestSeatToken()!.slice(0, -1)]) {
      const t = rig.hub.connectGuest();
      const got: S2C[] = [];
      t.onMessage((m) => got.push(m as S2C));
      t.send({
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        engineVersion: ENGINE_VERSION,
        ...(seatToken ? { seatToken } : {}),
      });
      await flush();
      expect(got.map((m) => m.type)).toEqual(['REJECTED']);
    }
    expect(guest.status).toBe('connected');
    expect(rig.host.isGuestConnected()).toBe(true);
  });

  // Tests: garbage before HELLO closes the connection.
  it('closes connections whose first message is not a HELLO', async () => {
    const rig = makeRig();
    const t = rig.hub.connectGuest();
    let closed = false;
    t.onClose(() => (closed = true));
    t.send({ type: 'REQUEST_RESYNC' });
    await flush();
    expect(closed).toBe(true);
  });

  // Tests: rejoin with the token, new transport replaces old, state equals a fresh sanitizeFor.
  it('lets the guest rejoin mid-game with its token', async () => {
    const rig = makeRig();
    const storage = memStorage();
    const g1 = join(rig, storage);
    await flush();
    // Play a few moves (mulligans) so the state is not pristine.
    for (let i = 0; i < 2; i++) {
      const actor = rig.host.getActor();
      if (actor === rig.host.hostSeat) rig.host.localIntent(legal(rig.host, actor)[0] as Intent);
      else g1.sendIntent(legal(rig.host, actor)[0] as Intent);
      await flush();
    }
    const token = rig.host.getGuestSeatToken();
    rig.hub.dropCurrent();
    await flush();
    expect(rig.status.at(-1)).toBe(false);
    expect(g1.status).toBe('closed');

    const g2 = join(rig, storage);
    await flush();
    expect(rig.host.getGuestSeatToken()).toBe(token);
    expect(g2.seat).toBe(rig.host.guestSeat);
    expect(g2.view).toEqual(sanitizeFor(rig.host.getFullStateForPersistence(), rig.host.guestSeat));
    expect(rig.status.at(-1)).toBe(true);
  });

  // Tests: a second connection with the right token replaces (and closes) the first.
  it('replaces a still-open old connection on rejoin', async () => {
    const rig = makeRig();
    const storage = memStorage();
    const g1 = join(rig, storage);
    await flush();
    const g2 = join(rig, storage);
    await flush();
    expect(g1.status).toBe('closed');
    expect(g2.status).toBe('connected');
  });
});

describe('HostSession intents', () => {
  // Tests: guest cannot act out of turn; state unchanged; REJECTED carries clientSeq.
  it('rejects an out-of-turn guest intent without changing state', async () => {
    const rig = makeRig();
    const guest = join(rig);
    await flush();
    const rejected: number[] = [];
    guest.onRejected((r) => rejected.push(r.clientSeq));
    const before = JSON.stringify(rig.host.getFullStateForPersistence());
    // Mulligan order: p0 first. If the guest is p0 it's their turn, so make a clearly illegal intent instead.
    const seat = rig.host.guestSeat;
    const bad: Intent =
      rig.host.getActor() === seat
        ? { type: 'END_TURN', playerId: seat }
        : { type: 'MULLIGAN', playerId: seat, cardIds: [] };
    const seq = guest.sendIntent(bad);
    await flush();
    expect(seq).toBe(1);
    expect(rejected).toEqual([1]);
    expect(JSON.stringify(rig.host.getFullStateForPersistence())).toBe(before);
    expect(rig.commits).toHaveLength(0);
  });

  // Tests: spoofed playerId (acting as the host's seat) is rejected even when it would be legal.
  it('rejects a spoofed playerId and never applies it', async () => {
    const rig = makeRig();
    const guest = join(rig);
    await flush();
    const rejected: Array<{ seq: number; code: string }> = [];
    guest.onRejected((r) => rejected.push({ seq: r.clientSeq, code: r.code }));
    const hostSeat = rig.host.hostSeat;
    const spoof = legal(rig.host, hostSeat)[0];
    // The host may not be the actor yet; mulligan for the actor is always available.
    const actor = rig.host.getActor();
    const intent: Intent =
      actor === hostSeat && spoof ? spoof : { type: 'MULLIGAN', playerId: hostSeat, cardIds: [] };
    const before = JSON.stringify(rig.host.getFullStateForPersistence());
    guest.sendIntent(intent);
    await flush();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe('NOT_OWNED');
    expect(JSON.stringify(rig.host.getFullStateForPersistence())).toBe(before);
    expect(rig.commits).toHaveLength(0);
  });

  // Tests: a duplicate clientSeq is not applied twice; the guest is re-sent STATE.
  it('does not apply a duplicate clientSeq', async () => {
    const rig = makeRig();
    const guest = join(rig);
    await flush();
    // Drive until the guest is the actor.
    while (rig.host.getActor() !== rig.host.guestSeat) {
      rig.host.localIntent(legal(rig.host, rig.host.hostSeat)[0] as Intent);
    }
    const intent = legal(rig.host, rig.host.guestSeat)[0] as Intent;
    const seq = guest.sendIntent(intent);
    await flush();
    expect(rig.commits.filter((c) => c.seat === rig.host.guestSeat)).toHaveLength(1);
    const states = rig.sent.filter((m) => m.type === 'STATE').length;
    // Replay the same clientSeq through the raw transport path of the session.
    (guest as unknown as { t: { send(m: C2S): void } }).t.send({
      type: 'INTENT',
      intent,
      clientSeq: seq,
    });
    await flush();
    expect(rig.commits.filter((c) => c.seat === rig.host.guestSeat)).toHaveLength(1);
    expect(rig.sent.filter((m) => m.type === 'STATE').length).toBe(states + 1);
  });

  // Tests: more than rateLimit intents per window are dropped with REJECTED.
  it('rate-limits a flooding guest', async () => {
    const rig = makeRig();
    const guest = join(rig);
    await flush();
    const codes: string[] = [];
    guest.onRejected((r) => codes.push(r.message));
    const seat = rig.host.guestSeat;
    for (let i = 0; i < 40; i++) guest.sendIntent({ type: 'PASS_PRIORITY', playerId: seat });
    await flush();
    expect(codes.filter((m) => m.includes('rate limited')).length).toBeGreaterThanOrEqual(10);
  });

  // Tests: localIntent forces the host seat and surfaces RuleErrors to the caller.
  it('forces the host seat on local intents and returns RuleErrors', () => {
    const rig = makeRig();
    const res = rig.host.localIntent({
      type: 'END_TURN',
      playerId: rig.host.guestSeat,
    });
    expect(res.ok).toBe(false);
    expect(rig.commits).toHaveLength(0);
  });

  // Tests: onLocalUpdate receives the host view after a local commit.
  it('reports local updates with the host view', () => {
    const views: PlayerId[] = [];
    const evs: GameEvent[][] = [];
    let host: HostSession | null = null;
    for (let k = 0; k < 20 && !host; k++) {
      const h = HostSession.create({
        cards: FIXTURE_CARDS,
        hostDeck: FIXTURE_DECK_A,
        guestDeck: FIXTURE_DECK_B,
        seed: 'lu' + k,
        mode: 'MULTIPLAYER',
        onLocalUpdate: (v, e) => {
          views.push(v.viewer);
          evs.push(e);
        },
      });
      if (h.getActor() === h.hostSeat) host = h;
    }
    expect(host).not.toBeNull();
    const h = host as HostSession;
    expect(h.localIntent(legal(h, h.hostSeat)[0] as Intent).ok).toBe(true);
    expect(views).toEqual([h.hostSeat]);
  });
});

describe('full games', () => {
  // Tests: a complete host vs guest game over loopback with leak checks on every guest-bound message.
  it.each(['g1', 'g2', 'g3'])(
    'plays a complete game with no leaks (%s)',
    async (seed) => {
      const rig = makeRig(seed);
      const guest = join(rig);
      await flush();
      const rng = mulberry32(seed.charCodeAt(1));
      let over = false;
      guest.onGameOver(() => (over = true));
      for (let step = 0; step < 4000 && !over; step++) {
        const actor = rig.host.getActor();
        const list = legal(rig.host, actor);
        if (list.length === 0) break;
        if (step === 3500) {
          // Safety valve so the test always terminates: the host concedes.
          rig.host.localIntent({ type: 'CONCEDE', playerId: rig.host.hostSeat });
          await flush();
          break;
        }
        if (actor === rig.host.hostSeat) {
          expect(rig.host.localIntent(pick(rng, list)).ok).toBe(true);
        } else {
          expect(guest.sendIntent(pick(rng, list))).toBeGreaterThan(0);
        }
        await flush();
        if (rig.host.getTurnInfo().status !== 'IN_PROGRESS') break;
      }
      await flush();
      expect(rig.host.getTurnInfo().status).not.toBe('IN_PROGRESS');
      expect(over).toBe(true);
      expect(guest.view).toEqual(
        sanitizeFor(rig.host.getFullStateForPersistence(), rig.host.guestSeat),
      );
      expect(rig.sent.at(-1)?.type).toBe('GAME_OVER');
      expect(rig.commits.length).toBeGreaterThan(10);
    },
    60_000,
  );

  // Tests: rejoin in the middle of a played game yields identical state to a fresh sanitize.
  it('rejoins mid-game and keeps playing', async () => {
    const rig = makeRig('mid');
    const storage = memStorage();
    let guest = join(rig, storage);
    await flush();
    const rng = mulberry32(7);
    const play = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const actor = rig.host.getActor();
        const list = legal(rig.host, actor);
        if (list.length === 0 || rig.host.getTurnInfo().status !== 'IN_PROGRESS') return;
        if (actor === rig.host.hostSeat) rig.host.localIntent(pick(rng, list));
        else guest.sendIntent(pick(rng, list));
        await flush();
      }
    };
    await play(60);
    rig.hub.dropCurrent();
    await flush();
    guest = join(rig, storage);
    await flush();
    expect(guest.view).toEqual(
      sanitizeFor(rig.host.getFullStateForPersistence(), rig.host.guestSeat),
    );
    const before = rig.commits.length;
    await play(40);
    expect(rig.commits.length).toBeGreaterThan(before);
  }, 60_000);
});

describe('restore', () => {
  // Tests: a new HostSession restored from a saved full state keeps playing and the old guest token still works.
  it('resumes from a persisted state', async () => {
    const rig = makeRig('persist');
    const storage = memStorage();
    const guest = join(rig, storage);
    await flush();
    for (let i = 0; i < 6; i++) {
      const actor = rig.host.getActor();
      const first = legal(rig.host, actor)[0] as Intent;
      if (actor === rig.host.hostSeat) rig.host.localIntent(first);
      else guest.sendIntent(first);
      await flush();
    }
    const saved = JSON.parse(JSON.stringify(rig.host.getFullStateForPersistence()));
    const token = rig.host.getGuestSeatToken();
    rig.host.dispose();

    const commits: CommitEntry[] = [];
    const host2 = new HostSession({
      cards: FIXTURE_CARDS,
      state: saved,
      hostSeat: rig.host.hostSeat,
      guestSeatToken: token,
      onCommit: (e) => commits.push(e),
    });
    const hub2 = createLoopbackHub<S2C, C2S>();
    hub2.hostOnConnection((t) => host2.acceptGuest(t));
    const g2 = new GuestSession({ transport: hub2.connectGuest(), storage });
    await flush();
    expect(g2.status).toBe('connected');
    expect(g2.view).toEqual(sanitizeFor(saved, host2.guestSeat));
    const actor = host2.getActor();
    const list = legal(host2, actor);
    if (actor === host2.hostSeat) expect(host2.localIntent(list[0] as Intent).ok).toBe(true);
    else g2.sendIntent(list[0] as Intent);
    await flush();
    expect(commits).toHaveLength(1);

    // restore() on a live session swaps the state and re-syncs the guest.
    host2.restore(saved);
    await flush();
    expect(g2.view).toEqual(sanitizeFor(saved, host2.guestSeat));
  });
});

describe('legal hints', () => {
  // Tests: every STATE carries the engine's legal actions for the recipient (leak-checked by the rig's
  // send wrapper, which scans whole messages), the host's own callback gets its own list, and the
  // seat claim callback fires exactly once.
  it('ships recipient-specific legal hints on every STATE and to the host UI', async () => {
    const hostLegal: Intent[][] = [];
    const claims: string[] = [];
    const rig = makeRig('hints');
    const host = HostSession.create({
      cards: FIXTURE_CARDS,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed: 'hints',
      mode: 'MULTIPLAYER',
      onLocalUpdate: (view, _e, l) => {
        expect(view.viewer).toBe(host.hostSeat);
        hostLegal.push(l);
        expect(l).toEqual(
          getLegalActions(host.getFullStateForPersistence(), FIXTURE_CARDS, host.hostSeat),
        );
        expect(l.every((i) => i.playerId === host.hostSeat)).toBe(true);
      },
      onSeatClaimed: (t) => claims.push(t),
    });
    void rig;
    const sent: S2C[] = [];
    const hub = createLoopbackHub<S2C, C2S>();
    hub.hostOnConnection((t) => {
      const orig = t.send.bind(t);
      t.send = (m: S2C) => {
        sent.push(JSON.parse(JSON.stringify(m)) as S2C);
        const leaks = findLeaks(m, host.getFullStateForPersistence(), host.guestSeat);
        expect(leaks).toEqual([]);
        orig(m);
      };
      host.acceptGuest(t);
    });
    const guest = new GuestSession({ transport: hub.connectGuest(), storage: memStorage() });
    await flush();
    expect(claims).toEqual([host.getGuestSeatToken()]);
    const rng = mulberry32(99);
    let sawNonEmpty = false;
    for (let i = 0; i < 400 && host.getTurnInfo().status === 'IN_PROGRESS'; i++) {
      const actor = host.getActor();
      const list = legal(host, actor);
      if (list.length === 0) break;
      if (actor === host.hostSeat) host.localIntent(pick(rng, list));
      else guest.sendIntent(pick(rng, list));
      await flush();
      const last = [...sent].reverse().find((m) => m.type === 'STATE');
      const expected = legal(host, host.guestSeat);
      expect(last && last.type === 'STATE' ? last.legalHint : undefined).toEqual(expected);
      expect(guest.legal).toEqual(expected);
      expect(expected.length).toBeLessThanOrEqual(300);
      if (expected.length > 0) sawNonEmpty = true;
    }
    expect(sawNonEmpty).toBe(true);
    expect(hostLegal.length).toBeGreaterThan(10);
    expect(claims).toHaveLength(1);
    // A resync request re-sends the hint too.
    guest.requestResync();
    await flush();
    expect(guest.legal).toEqual(legal(host, host.guestSeat));
    expect(host.getLegal(host.hostSeat)).toEqual(legal(host, host.hostSeat));
  }, 60_000);
});

describe('solo bot', () => {
  const firstLegal = (host: HostSession): BotLike => ({
    decide: (view) => {
      expect(view.viewer).toBe(host.guestSeat); // the bot only gets its own sanitized view
      expect(JSON.stringify(view)).not.toContain('"rng"');
      return legal(host, host.guestSeat)[0] ?? null;
    },
  });

  function soloHost(seed: string, hostCommits: CommitEntry[] = []): HostSession {
    return HostSession.create({
      cards: FIXTURE_CARDS,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed,
      mode: 'SOLO',
      onCommit: (e) => hostCommits.push(e),
    });
  }

  async function playSolo(host: HostSession, seed: number): Promise<void> {
    const rng = mulberry32(seed);
    for (let i = 0; i < 6000 && host.getTurnInfo().status === 'IN_PROGRESS'; i++) {
      if (host.getActor() === host.hostSeat) {
        const list = legal(host, host.hostSeat);
        if (i > 5000 || list.length === 0) {
          host.localIntent({ type: 'CONCEDE', playerId: host.hostSeat });
          break;
        }
        host.localIntent(pick(rng, list));
      } else {
        await flush(); // let the bot act
      }
    }
  }

  // Tests: the bot seat is driven to completion with a trivial bot; the game never stalls.
  it('runs a solo game to completion with a first-legal-action bot', async () => {
    const commits: CommitEntry[] = [];
    const host = soloHost('solo4', commits);
    host.attachBot(firstLegal(host), { delayMs: 0 });
    await playSolo(host, 5);
    await flush();
    expect(host.getTurnInfo().status).not.toBe('IN_PROGRESS');
    expect(commits.some((c) => c.seat === host.guestSeat)).toBe(true);
  }, 60_000);

  // Tests: a bot returning null or an illegal intent falls back to a legal action.
  it('falls back when the bot returns null or illegal intents', async () => {
    const commits: CommitEntry[] = [];
    const host = soloHost('solo-bad', commits);
    let n = 0;
    host.attachBot(
      {
        decide: () => {
          n++;
          if (n % 2 === 0) return null;
          return {
            type: 'PLAY_CARD',
            playerId: host.guestSeat,
            cardInstanceId: 'nope',
            payment: [],
          };
        },
      },
      { delayMs: 0 },
    );
    await playSolo(host, 5);
    await flush();
    expect(n).toBeGreaterThan(0);
    expect(host.getTurnInfo().status).not.toBe('IN_PROGRESS');
    expect(commits.some((c) => c.seat === host.guestSeat)).toBe(true);
  }, 60_000);

  // Tests: a throwing bot still progresses; a bot-seated game refuses network guests.
  it('survives a throwing bot and refuses network guests', async () => {
    const host = soloHost('solo-throw');
    host.attachBot(
      {
        decide: () => {
          throw new Error('boom');
        },
      },
      { delayMs: 0 },
    );
    const hub = createLoopbackHub<S2C, C2S>();
    hub.hostOnConnection((t) => host.acceptGuest(t));
    const g = new GuestSession({ transport: hub.connectGuest(), storage: memStorage() });
    await flush();
    expect(g.status).toBe('closed');
    expect(g.refusal?.code).toBe('NOT_FOUND');
    await playSolo(host, 9);
    await flush();
    expect(host.getTurnInfo().status).not.toBe('IN_PROGRESS');
  }, 60_000);

  // Tests: the step cap yields to the event loop (many steps never run in one synchronous burst).
  it('caps bot steps per tick', async () => {
    const host = soloHost('solo-cap');
    let calls = 0;
    host.attachBot(
      {
        decide: () => {
          calls++;
          return legal(host, host.guestSeat)[0] ?? null;
        },
      },
      { delayMs: 0, maxStepsPerTick: 1 },
    );
    // Make the host act until it's the bot's move.
    while (host.getActor() === host.hostSeat) {
      host.localIntent(legal(host, host.hostSeat)[0] as Intent);
    }
    expect(calls).toBe(0);
    await flush();
    expect(calls).toBe(1);
  });
});
