import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, PROTOCOL_VERSION, type C2S } from '@riftbound/engine';
import {
  checkHello,
  decode,
  decodeC2S,
  decodeS2C,
  encode,
  MAX_FRAME_CHARS,
  MAX_LEGAL_HINT,
  parseC2S,
  parseS2C,
} from './protocol.js';

const hello = { type: 'HELLO', protocolVersion: PROTOCOL_VERSION, engineVersion: ENGINE_VERSION };
const intent = { type: 'INTENT', clientSeq: 3, intent: { type: 'END_TURN', playerId: 'p0' } };
const view = { viewer: 'p1', players: [{}, {}], objects: {}, battlefields: [] };
const state = { type: 'STATE', view, events: [{ type: 'CARD_DRAWN', seq: 1 }] };

// Tests: strict validation of untrusted wire messages.
describe('parseC2S', () => {
  it('accepts valid messages', () => {
    expect(parseC2S(hello)).toEqual(hello);
    expect(parseC2S({ ...hello, seatToken: 'abc' })).toMatchObject({ seatToken: 'abc' });
    expect(parseC2S(intent)).toEqual(intent);
    expect(parseC2S({ type: 'REQUEST_RESYNC', junk: 1 })).toEqual({ type: 'REQUEST_RESYNC' });
  });
  it('rejects non-objects and unknown types', () => {
    for (const bad of [
      null,
      undefined,
      5,
      'HELLO',
      [],
      [hello],
      {},
      { type: 'NOPE' },
      { type: 7 },
    ]) {
      expect(parseC2S(bad)).toBeNull();
    }
    expect(parseC2S({ type: 'WELCOME', seat: 'p0', seatToken: 'x' })).toBeNull(); // S2C type
  });
  it('rejects bad fields', () => {
    expect(parseC2S({ ...hello, protocolVersion: '1' })).toBeNull();
    expect(parseC2S({ ...hello, protocolVersion: 1.5 })).toBeNull();
    expect(parseC2S({ ...hello, engineVersion: 3 })).toBeNull();
    expect(parseC2S({ ...hello, seatToken: 3 })).toBeNull();
    expect(parseC2S({ ...intent, clientSeq: -1 })).toBeNull();
    expect(parseC2S({ ...intent, clientSeq: '3' })).toBeNull();
    expect(parseC2S({ ...intent, intent: { type: 'HACK', playerId: 'p0' } })).toBeNull();
    expect(parseC2S({ ...intent, intent: { type: 'END_TURN', playerId: 'p2' } })).toBeNull();
    expect(parseC2S({ ...intent, intent: 'END_TURN' })).toBeNull();
    // inherited names must not count as intent types
    expect(parseC2S({ ...intent, intent: { type: 'toString', playerId: 'p0' } })).toBeNull();
  });
  it('rejects prototype-pollution keys', () => {
    expect(parseC2S(JSON.parse('{"type":"REQUEST_RESYNC","__proto__":{"x":1}}'))).toBeNull();
    expect(
      parseC2S(
        JSON.parse(
          '{"type":"INTENT","clientSeq":1,"intent":{"type":"END_TURN","playerId":"p0","constructor":{}}}',
        ),
      ),
    ).toBeNull();
    expect(
      parseC2S(
        JSON.parse(
          '{"type":"INTENT","clientSeq":1,"intent":{"type":"END_TURN","playerId":"p0","a":[{"__proto__":1}]}}',
        ),
      ),
    ).toBeNull();
  });
});

describe('parseS2C', () => {
  it('accepts valid messages', () => {
    expect(parseS2C({ type: 'WELCOME', seat: 'p1', seatToken: 't' })).toEqual({
      type: 'WELCOME',
      seat: 'p1',
      seatToken: 't',
    });
    expect(parseS2C(state)).toEqual(state);
    expect(
      parseS2C({ type: 'REJECTED', clientSeq: 1, code: 'WRONG_PHASE', message: 'no' }),
    ).not.toBeNull();
    expect(parseS2C({ type: 'OPPONENT_STATUS', connected: false })).toEqual({
      type: 'OPPONENT_STATUS',
      connected: false,
    });
    expect(parseS2C({ type: 'GAME_OVER', winner: null, replayAvailable: true })).not.toBeNull();
    expect(parseS2C({ type: 'GAME_OVER', winner: 'p0', replayAvailable: false })).not.toBeNull();
  });
  it('rejects bad frames', () => {
    expect(parseS2C(hello)).toBeNull();
    expect(parseS2C({ type: 'WELCOME', seat: 'p3', seatToken: 't' })).toBeNull();
    expect(parseS2C({ type: 'WELCOME', seat: 'p0' })).toBeNull();
    expect(parseS2C({ ...state, view: { ...view, viewer: 'x' } })).toBeNull();
    expect(parseS2C({ ...state, view: { ...view, players: [{}] } })).toBeNull();
    expect(parseS2C({ ...state, view: undefined })).toBeNull();
    expect(parseS2C({ ...state, events: 'no' })).toBeNull();
    expect(parseS2C({ ...state, events: [{ type: 'X' }] })).toBeNull(); // missing seq
    expect(
      parseS2C({ type: 'REJECTED', clientSeq: 1, code: 'NOT_A_CODE', message: 'x' }),
    ).toBeNull();
    expect(parseS2C({ type: 'OPPONENT_STATUS', connected: 'yes' })).toBeNull();
    expect(parseS2C({ type: 'GAME_OVER', winner: 'p0' })).toBeNull();
    expect(
      parseS2C(JSON.parse('{"type":"OPPONENT_STATUS","connected":true,"__proto__":{}}')),
    ).toBeNull();
    expect(parseS2C(null)).toBeNull();
  });
});

// Tests: the legal hint is advisory, strictly validated, and dropped (not fatal) when malformed.
describe('parseS2C legalHint', () => {
  const ok = { type: 'END_TURN', playerId: 'p1' };
  it('accepts a well-formed hint and an empty one', () => {
    expect(parseS2C({ ...state, legalHint: [ok] })).toEqual({ ...state, legalHint: [ok] });
    expect(parseS2C({ ...state, legalHint: [] })).toEqual({ ...state, legalHint: [] });
    expect(parseS2C(state)).not.toHaveProperty('legalHint');
  });
  it('drops (but keeps the state of) malformed hints', () => {
    const bad: unknown[] = [
      'x',
      {},
      [{ type: 'NOT_AN_INTENT', playerId: 'p1' }],
      [{ type: 'END_TURN' }],
      [{ type: 'END_TURN', playerId: 'p0' }], // not the recipient's seat
      [ok, null],
      new Array(MAX_LEGAL_HINT + 1).fill(ok),
    ];
    for (const legalHint of bad) {
      const m = parseS2C({ ...state, legalHint });
      expect(m).toEqual(state);
      expect(m).not.toHaveProperty('legalHint');
    }
    expect(parseS2C({ ...state, legalHint: new Array(MAX_LEGAL_HINT).fill(ok) })).not.toBeNull();
  });
  it('rejects prototype pollution inside a hint', () => {
    const raw = JSON.parse(
      '{"type":"STATE","events":[],"legalHint":[{"type":"END_TURN","playerId":"p1","__proto__":{}}]}',
    );
    expect(parseS2C({ ...raw, view })).toBeNull();
  });
});

describe('encode/decode', () => {
  it('round trips', () => {
    expect(decodeC2S(encode(hello as C2S))).toEqual(hello);
    expect(decodeS2C(encode(state as never))).toEqual(state);
  });
  it('rejects oversized, malformed, non-string and polluted frames', () => {
    expect(decode('{not json')).toBeNull();
    expect(decode(5)).toBeNull();
    expect(decode(undefined)).toBeNull();
    expect(decode('x'.repeat(MAX_FRAME_CHARS + 1))).toBeNull();
    const big = JSON.stringify({ type: 'REQUEST_RESYNC', pad: 'x'.repeat(MAX_FRAME_CHARS) });
    expect(decodeC2S(big)).toBeNull();
    expect(decode('{"__proto__":{"a":1}}')).toBeNull();
    expect(decode('{"a":{"constructor":1}}')).toBeNull();
    expect(decode('{"ok":1}')).toEqual({ ok: 1 });
  });
  it('rejects absurd nesting', () => {
    const deep = '['.repeat(100) + ']'.repeat(100);
    expect(decode(deep)).toBeNull();
  });
});

describe('checkHello', () => {
  it('accepts matching protocol', () => {
    expect(checkHello(hello as C2S)).toEqual({ ok: true, engineMatch: true });
    expect(checkHello({ ...hello, engineVersion: '9.9.9' } as C2S)).toEqual({
      ok: true,
      engineMatch: false,
    });
  });
  it('rejects protocol mismatch', () => {
    expect(checkHello({ ...hello, protocolVersion: PROTOCOL_VERSION + 1 } as C2S)).toEqual({
      ok: false,
      reason: 'PROTOCOL_MISMATCH',
      expected: PROTOCOL_VERSION,
      got: PROTOCOL_VERSION + 1,
    });
  });
});
