/**
 * WebRTC transports over PeerJS. The public PeerJS broker is used only for the SDP/ICE handshake
 * (room code -> peer id); all game traffic flows over the data channel, host-authoritative.
 *
 * Wire format: every data-channel frame is a JSON *string*. Frames `{"__hb":1}` / `{"__hb":2}` are
 * transport-level ping/pong and never reach onMessage. Everything else goes through decode() +
 * parseC2S/parseS2C; malformed, oversized or polluting frames are dropped.
 *
 * Duel allows exactly ONE guest at a time: a newer connection that sends a valid first frame
 * replaces (and closes) the older one. A connection is not surfaced via onConnection until its
 * first frame validates as a C2S message, so stray/garbage connections cannot kick the real guest.
 */
import Peer, { type PeerJSOption } from 'peerjs';
import type { C2S, S2C } from '@riftbound/engine';
import { decode, encode, parseC2S, parseS2C } from './protocol.js';
import { peerIdFromRoomCode } from './roomCode.js';
import { Listeners, type StatusTransport, type TransportStatus } from './transport.js';

// ---- minimal structural PeerJS surface we depend on (lets tests inject a fake) -------------------

export interface PeerErrorLike {
  type?: string;
  message?: string;
}

export interface DataConnectionLike {
  readonly peer: string;
  readonly open: boolean;
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'data', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: PeerErrorLike) => void): void;
  send(data: unknown): void;
  close(): void;
}

export interface PeerLike {
  readonly destroyed?: boolean;
  on(event: 'open', cb: (id: string) => void): void;
  on(event: 'connection', cb: (conn: DataConnectionLike) => void): void;
  on(event: 'error', cb: (err: PeerErrorLike) => void): void;
  on(event: 'disconnected' | 'close', cb: () => void): void;
  connect(id: string, opts?: { reliable?: boolean; serialization?: string }): DataConnectionLike;
  reconnect?(): void;
  destroy(): void;
}

/** `id` undefined -> broker assigns a random id. */
export type PeerFactory = (id?: string) => PeerLike;

export function defaultPeerFactory(options?: PeerJSOption): PeerFactory {
  return (id) => (id ? new Peer(id, options) : new Peer(options ?? {})) as unknown as PeerLike;
}

// ---- shared helpers ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  pingMs?: number;
  timeoutMs?: number;
}
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
}

const HB_PING = 1;
const HB_PONG = 2;

/** Exponential backoff with +-20% jitter, never above capMs. attempt starts at 0. */
export function backoffDelay(
  attempt: number,
  { baseMs = 500, capMs = 15_000 }: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.min(capMs, Math.round(raw * (1 + (random() - 0.5) * 0.4)));
}

/** Thrown by guest `send()` while the link is not open. See connectGuestPeer. */
export class TransportNotOpenError extends Error {
  constructor() {
    super('Transport is not open');
    this.name = 'TransportNotOpenError';
  }
}

interface WiredConn {
  readonly open: boolean;
  send(frame: string): void;
  close(): void;
}

function wireConn(
  conn: DataConnectionLike,
  o: {
    heartbeat: Required<HeartbeatOptions>;
    onOpen?: () => void;
    onFrame: (value: unknown) => void;
    /** Frame was not a decodable JSON object (malformed, oversized, polluting, non-string). */
    onInvalid?: () => void;
    onClose: (reason: 'closed' | 'timeout') => void;
  },
): WiredConn {
  let lastSeen = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const safeSend = (frame: string): void => {
    try {
      if (conn.open) conn.send(frame);
    } catch {
      /* channel died; close event follows */
    }
  };
  const finish = (reason: 'closed' | 'timeout'): void => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    timer = null;
    o.onClose(reason);
  };
  const start = (): void => {
    if (timer || done) return;
    lastSeen = Date.now();
    timer = setInterval(() => {
      if (Date.now() - lastSeen > o.heartbeat.timeoutMs) {
        finish('timeout');
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        return;
      }
      safeSend(JSON.stringify({ __hb: HB_PING }));
    }, o.heartbeat.pingMs);
    o.onOpen?.();
  };

  conn.on('open', start);
  conn.on('close', () => finish('closed'));
  conn.on('error', () => {
    /* a 'close' event follows fatal errors */
  });
  conn.on('data', (data) => {
    if (done) return;
    lastSeen = Date.now();
    const value = decode(data);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      o.onInvalid?.(); // malformed: dropped
      return;
    }
    const hb = (value as Record<string, unknown>).__hb;
    if (hb !== undefined) {
      if (hb === HB_PING) safeSend(JSON.stringify({ __hb: HB_PONG }));
      return;
    }
    o.onFrame(value);
  });
  if (conn.open) start();

  return {
    get open() {
      return !done && conn.open;
    },
    send: safeSend,
    close() {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      finish('closed');
    },
  };
}

const DEFAULT_HB: Required<HeartbeatOptions> = { pingMs: 5000, timeoutMs: 15_000 };
const hb = (h?: HeartbeatOptions): Required<HeartbeatOptions> => ({ ...DEFAULT_HB, ...h });

// ---- host ---------------------------------------------------------------------------------------

export interface HostPeerOptions {
  peerFactory?: PeerFactory;
  /** Options for the default factory (custom broker, ICE servers, ...). Ignored if peerFactory is set. */
  peerOptions?: PeerJSOption;
  heartbeat?: HeartbeatOptions;
  /** Room id already taken (crashed host still registered at the broker): retry for up to totalMs. */
  idRetry?: { totalMs?: number; baseMs?: number; capMs?: number };
  /** Backoff for broker reconnects after the signalling socket drops. */
  reconnect?: BackoffOptions;
  /** A connection that never sends a valid first frame is closed after this long (default 10s). */
  handshakeTimeoutMs?: number;
  random?: () => number;
}

export type HostStatusDetail =
  | 'registering'
  | 'id-taken-retry'
  | 'listening'
  | 'broker-disconnected'
  | 'id-unavailable'
  | 'destroyed';

export type HostTransport = StatusTransport<S2C, C2S>;

export interface HostPeer {
  readonly roomCode: string;
  readonly peerId: string;
  readonly status: TransportStatus;
  /** Fires for each guest once its first valid frame arrived; that frame is delivered right after the callback returns, so attach onMessage synchronously. */
  onConnection(cb: (t: HostTransport) => void): () => void;
  onStatus(cb: (status: TransportStatus, detail: HostStatusDetail) => void): () => void;
  destroy(): void;
}

class HostConn implements HostTransport {
  status: TransportStatus = 'open';
  readonly msgs = new Listeners<[C2S]>();
  private readonly closes = new Listeners<[]>();
  private readonly statuses = new Listeners<[TransportStatus]>();
  constructor(
    private readonly wired: WiredConn,
    private readonly onDone: (self: HostConn) => void,
  ) {}
  send(msg: S2C): void {
    if (this.status === 'open') this.wired.send(encode(msg));
  }
  onMessage(cb: (msg: C2S) => void): () => void {
    return this.msgs.add(cb);
  }
  onClose(cb: () => void): () => void {
    return this.closes.add(cb);
  }
  onStatus(cb: (s: TransportStatus) => void): () => void {
    return this.statuses.add(cb);
  }
  close(): void {
    this.wired.close();
    this.finish();
  }
  finish(): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.onDone(this);
    this.statuses.emit('closed');
    this.closes.emit();
  }
}

export function createHostPeer(roomCode: string, opts: HostPeerOptions = {}): HostPeer {
  const peerId = peerIdFromRoomCode(roomCode);
  const factory = opts.peerFactory ?? defaultPeerFactory(opts.peerOptions);
  const random = opts.random ?? Math.random;
  const hbOpts = hb(opts.heartbeat);
  const idTotal = opts.idRetry?.totalMs ?? 60_000;
  const idBackoff = { baseMs: opts.idRetry?.baseMs ?? 1000, capMs: opts.idRetry?.capMs ?? 5000 };
  const handshakeMs = opts.handshakeTimeoutMs ?? 10_000;

  const connListeners = new Listeners<[HostTransport]>();
  const statusListeners = new Listeners<[TransportStatus, HostStatusDetail]>();
  let status: TransportStatus = 'connecting';
  let detail: HostStatusDetail = 'registering';
  let gen = 0;
  let peer: PeerLike | null = null;
  let destroyed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idAttempt = 0;
  let idDeadline: number | null = null;
  let reconnectAttempt = 0;
  let active: HostConn | null = null;
  const pending = new Set<WiredConn>();

  const setStatus = (s: TransportStatus, d: HostStatusDetail): void => {
    if (s === status && d === detail) return;
    status = s;
    detail = d;
    statusListeners.emit(s, d);
  };
  const killPeer = (): void => {
    const p = peer;
    peer = null;
    try {
      p?.destroy();
    } catch {
      /* ignore */
    }
  };
  const later = (ms: number, fn: () => void): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!destroyed) fn();
    }, ms);
  };

  const incoming = (conn: DataConnectionLike): void => {
    let claimed: HostConn | null = null;
    let hsTimer: ReturnType<typeof setTimeout> | null = null;
    const wired: WiredConn = wireConn(conn, {
      heartbeat: hbOpts,
      onInvalid: () => {
        if (!claimed) wired.close(); // garbage before a valid first frame: not a client
      },
      onFrame: (value) => {
        const msg = parseC2S(value);
        if (!claimed) {
          if (!msg) {
            wired.close(); // not a valid client
            return;
          }
          if (hsTimer) clearTimeout(hsTimer);
          pending.delete(wired);
          const t = new HostConn(wired, (self) => {
            if (active === self) active = null;
          });
          claimed = t;
          const old = active;
          active = t;
          old?.close(); // one active guest: newer valid connection wins
          connListeners.emit(t);
          t.msgs.emit(msg);
          return;
        }
        if (msg) claimed.msgs.emit(msg);
      },
      onClose: () => {
        if (hsTimer) clearTimeout(hsTimer);
        pending.delete(wired);
        claimed?.finish();
      },
    });
    pending.add(wired);
    hsTimer = setTimeout(() => {
      if (!claimed) {
        pending.delete(wired);
        wired.close();
      }
    }, handshakeMs);
  };

  const register = (): void => {
    if (destroyed) return;
    const g = ++gen;
    const p = factory(peerId);
    peer = p;
    let opened = false;
    const stale = (): boolean => g !== gen || destroyed;

    p.on('open', () => {
      if (stale()) return;
      opened = true;
      idAttempt = 0;
      idDeadline = null;
      reconnectAttempt = 0;
      setStatus('open', 'listening');
    });
    p.on('connection', (conn) => {
      if (!stale()) incoming(conn);
    });
    p.on('error', (err) => {
      if (stale()) return;
      if (err.type === 'unavailable-id') {
        // Broker may still hold a crashed host's id; retry with backoff until the deadline.
        gen++;
        killPeer();
        const now = Date.now();
        idDeadline ??= now + idTotal;
        if (now >= idDeadline) {
          setStatus('closed', 'id-unavailable');
          return;
        }
        setStatus('connecting', 'id-taken-retry');
        later(Math.min(backoffDelay(idAttempt++, idBackoff, random), idDeadline - now), register);
      } else if (!opened) {
        // Broker unreachable during registration: retry like a reconnect.
        gen++;
        killPeer();
        setStatus('connecting', 'registering');
        later(backoffDelay(reconnectAttempt++, opts.reconnect, random), register);
      }
      // After opening, other errors are non-fatal for existing data channels.
    });
    p.on('disconnected', () => {
      if (stale() || !opened) return;
      // Signalling socket lost: existing guest channel keeps working, but new guests cannot join.
      setStatus('reconnecting', 'broker-disconnected');
      later(backoffDelay(reconnectAttempt++, opts.reconnect, random), () => {
        if (peer?.reconnect && !peer.destroyed) peer.reconnect();
        else {
          gen++;
          killPeer();
          register();
        }
        // If reconnect fails we get 'disconnected' / 'error' again and back off further.
        later(backoffDelay(reconnectAttempt++, opts.reconnect, random), () => {
          if (status !== 'open') {
            gen++;
            killPeer();
            register();
          }
        });
      });
    });
    p.on('close', () => {
      if (stale()) return;
      gen++;
      peer = null;
      setStatus('connecting', 'registering');
      later(backoffDelay(reconnectAttempt++, opts.reconnect, random), register);
    });
  };

  register();

  return {
    roomCode,
    peerId,
    get status() {
      return status;
    },
    onConnection: (cb) => connListeners.add(cb),
    onStatus: (cb) => statusListeners.add(cb),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gen++;
      if (retryTimer) clearTimeout(retryTimer);
      active?.close();
      for (const w of [...pending]) w.close();
      pending.clear();
      killPeer();
      setStatus('closed', 'destroyed');
    },
  };
}

// ---- guest --------------------------------------------------------------------------------------

export interface GuestPeerOptions {
  peerFactory?: PeerFactory;
  peerOptions?: PeerJSOption;
  heartbeat?: HeartbeatOptions;
  /** Reconnect backoff: base 500ms doubling, cap 15s, +-20% jitter, retried forever until close(). */
  backoff?: BackoffOptions;
  /** Give up a single connection attempt after this long (default 20s) and back off. */
  connectTimeoutMs?: number;
  random?: () => number;
  /** Called for each dropped inbound frame (debug hook). */
  onInvalidFrame?: () => void;
}

export type GuestTransport = StatusTransport<C2S, S2C>;

/**
 * Guest side. Status: 'connecting' until first open, then 'open'; any loss (data channel closed,
 * heartbeat timeout, peer-unavailable, broker error before open) -> 'reconnecting' (or 'connecting'
 * if never opened) and retried forever. onClose fires only after the app calls close().
 *
 * send() while not 'open' THROWS TransportNotOpenError (no queueing): intents buffered across an
 * outage would be stale, the UI blocks input with a "waiting for host" overlay, and the session
 * re-sends HELLO and requests a resync on every 'open'.
 */
export function connectGuestPeer(roomCode: string, opts: GuestPeerOptions = {}): GuestTransport {
  const hostId = peerIdFromRoomCode(roomCode);
  const factory = opts.peerFactory ?? defaultPeerFactory(opts.peerOptions);
  const random = opts.random ?? Math.random;
  const hbOpts = hb(opts.heartbeat);
  const connectTimeout = opts.connectTimeoutMs ?? 20_000;

  const msgs = new Listeners<[S2C]>();
  const closes = new Listeners<[]>();
  const statuses = new Listeners<[TransportStatus]>();
  let status: TransportStatus = 'connecting';
  let everOpen = false;
  let closed = false;
  let gen = 0;
  let attempt = 0;
  let peer: PeerLike | null = null;
  let wired: WiredConn | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: TransportStatus): void => {
    if (s === status) return;
    status = s;
    statuses.emit(s);
  };
  const teardown = (): void => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    const w = wired;
    const p = peer;
    wired = null;
    peer = null;
    try {
      w?.close();
    } catch {
      /* ignore */
    }
    try {
      p?.destroy();
    } catch {
      /* ignore */
    }
  };

  const start = (): void => {
    retryTimer = null;
    if (closed) return;
    const g = ++gen;
    let isOpen = false;
    const stale = (): boolean => g !== gen || closed;
    const lost = (): void => {
      if (stale()) return;
      gen++;
      teardown();
      setStatus(everOpen ? 'reconnecting' : 'connecting');
      retryTimer = setTimeout(start, backoffDelay(attempt++, opts.backoff, random));
    };

    const p = factory(undefined);
    peer = p;
    connectTimer = setTimeout(lost, connectTimeout);

    p.on('open', () => {
      if (stale()) return;
      const conn = p.connect(hostId, { reliable: true, serialization: 'json' });
      wired = wireConn(conn, {
        heartbeat: hbOpts,
        onOpen: () => {
          if (stale()) return;
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
          isOpen = true;
          everOpen = true;
          attempt = 0;
          setStatus('open');
        },
        onFrame: (value) => {
          if (stale()) return;
          const m = parseS2C(value);
          if (m) msgs.emit(m);
          else opts.onInvalidFrame?.();
        },
        onInvalid: () => opts.onInvalidFrame?.(),
        onClose: lost,
      });
    });
    // peer-unavailable (host not there yet / gone) and pre-open broker errors -> back off and retry.
    // Once the data channel is open, signalling-level errors do not affect it.
    p.on('error', () => {
      if (!isOpen) lost();
    });
    p.on('disconnected', () => {
      if (!isOpen) lost();
    });
    p.on('close', lost);
  };

  start();

  return {
    get status() {
      return status;
    },
    send(msg: C2S): void {
      if (status !== 'open' || !wired?.open) throw new TransportNotOpenError();
      wired.send(encode(msg));
    },
    onMessage: (cb) => msgs.add(cb),
    onClose: (cb) => closes.add(cb),
    onStatus: (cb) => statuses.add(cb),
    close(): void {
      if (closed) return;
      closed = true;
      gen++;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
      setStatus('closed');
      closes.emit();
    },
  };
}
