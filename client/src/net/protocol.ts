import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  RULE_ERROR_CODES,
  type C2S,
  type IntentType,
  type S2C,
} from '@riftbound/engine';

/** Frames above this many characters are rejected before parsing (untrusted wire data). */
export const MAX_FRAME_CHARS = 256 * 1024;
const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Exhaustive by construction: adding an intent type to the engine breaks compilation here.
const INTENT_TYPES: Record<IntentType, true> = {
  MULLIGAN: true,
  PASS_PRIORITY: true,
  END_TURN: true,
  PLAY_CARD: true,
  ACTIVATE_RUNE: true,
  STANDARD_MOVE: true,
  ASSIGN_COMBAT_DAMAGE: true,
  HIDE_CARD: true,
  ACTIVATE_ABILITY: true,
  EQUIP: true,
  CONCEDE: true,
};

const RULE_CODES = new Set<string>(RULE_ERROR_CODES);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown, max = 4096): v is string {
  return typeof v === 'string' && v.length <= max;
}
function isSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function isPlayer(v: unknown): v is 'p0' | 'p1' {
  return v === 'p0' || v === 'p1';
}

/** True if any object in the tree has an own key that could pollute prototypes, or nesting is absurd. */
export function hasForbiddenKeys(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKeys(v, depth + 1));
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKeys((value as Obj)[key], depth + 1)) return true;
  }
  return false;
}

function isIntent(v: unknown): boolean {
  return (
    isObj(v) &&
    typeof v.type === 'string' &&
    Object.prototype.hasOwnProperty.call(INTENT_TYPES, v.type) &&
    isPlayer(v.playerId)
  );
}

/** Validate an untrusted value as a guest -> host message. Intent payloads are checked for type/player only; the engine re-validates the rest. */
export function parseC2S(raw: unknown): C2S | null {
  if (!isObj(raw) || hasForbiddenKeys(raw)) return null;
  switch (raw.type) {
    case 'HELLO': {
      if (!isSeq(raw.protocolVersion) || !isStr(raw.engineVersion, 64)) return null;
      if (raw.seatToken !== undefined && !isStr(raw.seatToken, 256)) return null;
      const msg: C2S = {
        type: 'HELLO',
        protocolVersion: raw.protocolVersion,
        engineVersion: raw.engineVersion,
      };
      if (raw.seatToken !== undefined) msg.seatToken = raw.seatToken as string;
      return msg;
    }
    case 'INTENT':
      if (!isIntent(raw.intent) || !isSeq(raw.clientSeq)) return null;
      return raw as unknown as C2S;
    case 'REQUEST_RESYNC':
      return { type: 'REQUEST_RESYNC' };
    default:
      return null;
  }
}

/** Validate an untrusted value as a host -> guest message. */
export function parseS2C(raw: unknown): S2C | null {
  if (!isObj(raw) || hasForbiddenKeys(raw)) return null;
  switch (raw.type) {
    case 'WELCOME':
      if (!isPlayer(raw.seat) || !isStr(raw.seatToken, 256)) return null;
      return { type: 'WELCOME', seat: raw.seat, seatToken: raw.seatToken };
    case 'STATE': {
      const view = raw.view;
      if (!isObj(view) || !isPlayer(view.viewer)) return null;
      if (!Array.isArray(view.players) || view.players.length !== 2) return null;
      if (!isObj(view.objects) || !Array.isArray(view.battlefields)) return null;
      if (!Array.isArray(raw.events)) return null;
      for (const e of raw.events) {
        if (!isObj(e) || !isStr(e.type, 64) || !isSeq(e.seq)) return null;
      }
      return raw as unknown as S2C;
    }
    case 'REJECTED':
      if (!isSeq(raw.clientSeq) || !isStr(raw.code, 64) || !RULE_CODES.has(raw.code)) return null;
      if (!isStr(raw.message, 2048)) return null;
      return raw as unknown as S2C;
    case 'OPPONENT_STATUS':
      if (typeof raw.connected !== 'boolean') return null;
      return { type: 'OPPONENT_STATUS', connected: raw.connected };
    case 'GAME_OVER':
      if (!(raw.winner === null || isPlayer(raw.winner))) return null;
      if (typeof raw.replayAvailable !== 'boolean') return null;
      return { type: 'GAME_OVER', winner: raw.winner, replayAvailable: raw.replayAvailable };
    default:
      return null;
  }
}

export type HelloCheck =
  | { ok: true; engineMatch: boolean }
  | { ok: false; reason: 'PROTOCOL_MISMATCH'; expected: number; got: number };

/** Host-side handshake check. Engine version mismatch is reported but not fatal. */
export function checkHello(msg: C2S): HelloCheck {
  if (msg.type !== 'HELLO') {
    return { ok: false, reason: 'PROTOCOL_MISMATCH', expected: PROTOCOL_VERSION, got: -1 };
  }
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: 'PROTOCOL_MISMATCH',
      expected: PROTOCOL_VERSION,
      got: msg.protocolVersion,
    };
  }
  return { ok: true, engineMatch: msg.engineVersion === ENGINE_VERSION };
}

export function encode(msg: C2S | S2C): string {
  return JSON.stringify(msg);
}

/** Parse a wire frame into an untrusted JSON value; null if oversized, malformed or polluting. */
export function decode(str: unknown, maxChars = MAX_FRAME_CHARS): unknown {
  if (typeof str !== 'string' || str.length > maxChars) return null;
  let value: unknown;
  try {
    value = JSON.parse(str);
  } catch {
    return null;
  }
  return hasForbiddenKeys(value) ? null : value;
}

export const decodeC2S = (str: unknown): C2S | null => parseC2S(decode(str));
export const decodeS2C = (str: unknown): S2C | null => parseS2C(decode(str));
