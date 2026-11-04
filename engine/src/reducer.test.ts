import { describe, it, expect } from 'vitest';
import { checkInvariants } from './invariants.js';
import { reduce, ENGINE_HOOKS, applyIntent } from './reducer.js';
import { autoPlan } from './resources.js';
import { createGame } from './setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import type { GameState, Intent, PlayerId } from './types/index.js';

const fresh = (seed = 'r'): GameState =>
  createGame(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], seed);

function ok(s: GameState, i: Intent): { state: GameState; events: { seq: number }[] } {
  const r = reduce(s, FIXTURE_CARDS, i);
  if (!r.ok) throw new Error(`${i.type} rejected: ${r.code} ${r.message}`);
  return r;
}

/** Both players keep their hand; the game lands in MAIN of turn 1. */
function started(seed = 'r'): GameState {
  let s = fresh(seed);
  s = ok(s, { type: 'MULLIGAN', playerId: 'p0', cardIds: [] }).state;
  s = ok(s, { type: 'MULLIGAN', playerId: 'p1', cardIds: [] }).state;
  return s;
}

const isRune = (s: GameState, id: string): boolean =>
  FIXTURE_CARDS[s.objects[id]?.cardId as string]?.type === 'RUNE';

const baseRunes = (s: GameState, p: PlayerId): number =>
  s.players[p === 'p0' ? 0 : 1].base.filter((id) => isRune(s, id)).length;

/** Move a copy of `cardId` owned by `p` from its main deck into its hand. */
function give(s: GameState, p: PlayerId, cardId: string): { state: GameState; id: string } {
  const next = structuredClone(s);
  const ps = next.players[p === 'p0' ? 0 : 1];
  const id = ps.mainDeck.find((x) => next.objects[x]?.cardId === cardId) as string;
  ps.mainDeck = ps.mainDeck.filter((x) => x !== id);
  ps.hand.push(id);
  (next.objects[id] as { zone: unknown }).zone = { kind: 'hand', player: p };
  return { state: next, id };
}

describe('reduce: turn flow', () => {
  it('runs the mulligan into MAIN of turn 1 for p0 with a continuous event log', () => {
    // Tests Rule 117: mulligan in turn order, then the first turn begins
    const s1 = ok(fresh(), { type: 'MULLIGAN', playerId: 'p0', cardIds: [] });
    expect(s1.state.turn.phase).toBe('MULLIGAN');
    const s2 = ok(s1.state, { type: 'MULLIGAN', playerId: 'p1', cardIds: [] });
    expect(s2.state.mulligan).toBeNull();
    expect(s2.state.turn).toMatchObject({ number: 1, activePlayer: 'p0', phase: 'MAIN' });
    expect(s2.state.flow.priority).toBe('p0');
    expect(baseRunes(s2.state, 'p0')).toBe(2);
    expect(s2.state.players[0].hand).toHaveLength(5);
    const seqs = s2.events.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(3);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBe(s2.state.nextEventSeq - 1);
    expect(checkInvariants(s2.state, FIXTURE_CARDS)).toEqual([]);
  });

  it('END_TURN rotates to p1, who channels 3 runes on their first turn', () => {
    // Tests Rule 487.7: the second player channels an extra rune on their first Channel Phase
    const r = ok(started(), { type: 'END_TURN', playerId: 'p0' });
    expect(r.state.turn).toMatchObject({ number: 2, activePlayer: 'p1', phase: 'MAIN' });
    expect(baseRunes(r.state, 'p1')).toBe(3);
    expect(r.state.flow.priority).toBe('p1');
    const back = ok(r.state, { type: 'END_TURN', playerId: 'p1' });
    expect(back.state.turn).toMatchObject({ number: 3, activePlayer: 'p0' });
    expect(baseRunes(back.state, 'p0')).toBe(4);
    expect(baseRunes(back.state, 'p1')).toBe(3);
  });

  it('only the turn player may end the turn', () => {
    // Tests Rule 307: only the turn player acts in the Main Phase
    expect(reduce(started(), FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p1' })).toMatchObject({
      ok: false,
    });
  });
});

describe('reduce: chain and Closed State', () => {
  it('rejects a non-Reaction play during a chain with CLOSED_STATE_REACTION_ONLY', () => {
    // Tests Rule 309.1.a: only Reactions may be played while a Chain exists
    let s = started();
    const a = give(s, 'p0', 'fx-plain-spell');
    s = a.state;
    const plan = autoPlan(s, FIXTURE_CARDS, 'p0', { energy: 2, power: [] });
    expect(plan).not.toBeNull();
    s = ok(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: a.id,
      payment: plan ?? [],
    }).state;
    expect(s.flow.chain).toHaveLength(1);
    expect(s.flow.priority).toBe('p1');
    const b = give(s, 'p1', 'fx-plain-spell');
    const res = reduce(b.state, FIXTURE_CARDS, {
      type: 'PLAY_CARD',
      playerId: 'p1',
      cardInstanceId: b.id,
      payment: [],
    });
    expect(res).toMatchObject({ ok: false, code: 'CLOSED_STATE_REACTION_ONLY' });
    // both pass -> the spell resolves and p0 regains priority
    s = ok(s, { type: 'PASS_PRIORITY', playerId: 'p1' }).state;
    s = ok(s, { type: 'PASS_PRIORITY', playerId: 'p0' }).state;
    expect(s.flow.chain).toHaveLength(0);
    expect(s.players[0].trash).toContain(a.id);
    expect(checkInvariants(s, FIXTURE_CARDS)).toEqual([]);
  });

  it('rejects PASS_PRIORITY in a Neutral Open state', () => {
    // Tests Rule 310: nothing to pass when no Chain or Showdown exists
    expect(
      reduce(started(), FIXTURE_CARDS, { type: 'PASS_PRIORITY', playerId: 'p0' }),
    ).toMatchObject({ ok: false });
  });
});

describe('reduce: runes, abilities, concede', () => {
  it('lets a participant activate a rune at any time except during the mulligan', () => {
    // Tests Rule 164.2: rune abilities are Reaction-speed mana abilities that skip the chain
    expect(
      reduce(fresh(), FIXTURE_CARDS, {
        type: 'ACTIVATE_RUNE',
        playerId: 'p0',
        runeId: 'o1',
        mode: 'EXHAUST',
      }),
    ).toMatchObject({ ok: false, code: 'WRONG_PHASE' });
    let s = started();
    const runeId = s.players[0].base.find((id) => isRune(s, id)) as string;
    s = ok(s, { type: 'END_TURN', playerId: 'p0' }).state; // now p1's turn: p0 has no priority
    const r = ok(s, { type: 'ACTIVATE_RUNE', playerId: 'p0', runeId, mode: 'EXHAUST' });
    expect(r.state.players[0].runePool.energy).toBe(1);
  });

  it('has no activated abilities in the MVP', () => {
    // Tests Rule 166: activated abilities are not implemented yet
    expect(
      reduce(started(), FIXTURE_CARDS, {
        type: 'ACTIVATE_ABILITY',
        playerId: 'p0',
        sourceId: 'o1',
        abilityIndex: 0,
        payment: [],
      }),
    ).toMatchObject({ ok: false, code: 'ABILITY_NOT_AVAILABLE' });
  });

  it('CONCEDE makes the opponent win immediately, even during the mulligan', () => {
    // Tests Rule 649: conceding ends the game at once; the opponent wins
    const r = ok(fresh(), { type: 'CONCEDE', playerId: 'p0' });
    expect(r.state.gameStatus).toBe('FINISHED');
    expect(r.state.winner).toBe('p1');
    expect(r.events).toMatchObject([{ type: 'GAME_ENDED', winner: 'p1' }]);
    const r2 = ok(started(), { type: 'CONCEDE', playerId: 'p1' });
    expect(r2.state.winner).toBe('p0');
    expect(checkInvariants(r2.state, FIXTURE_CARDS)).toEqual([]);
  });

  it('rejects every intent once the game is over', () => {
    // Tests Rule 473.1: a finished game accepts no more actions
    const over = ok(started(), { type: 'CONCEDE', playerId: 'p0' }).state;
    const intents: Intent[] = [
      { type: 'END_TURN', playerId: 'p0' },
      { type: 'CONCEDE', playerId: 'p1' },
      { type: 'PASS_PRIORITY', playerId: 'p1' },
      { type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: 'o1', mode: 'EXHAUST' },
    ];
    for (const i of intents) {
      expect(reduce(over, FIXTURE_CARDS, i)).toMatchObject({ ok: false, code: 'GAME_OVER' });
    }
  });
});

describe('reduce: robustness', () => {
  it('returns a RuleError (never throws) for malformed intents', () => {
    // Tests Rule 100: unrecognised or malformed input is rejected, not crashed on
    const s = started();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      'END_TURN',
      [],
      {},
      { type: 'NOPE', playerId: 'p0' },
      { type: 'END_TURN' },
      { type: 'END_TURN', playerId: 'p2' },
      { type: 'END_TURN', playerId: 7 },
      { type: 'MULLIGAN', playerId: 'p0', cardIds: 'o1' },
      { type: 'PLAY_CARD', playerId: 'p0', cardInstanceId: 'o1' },
      { type: 'PLAY_CARD', playerId: 'p0', cardInstanceId: 5, payment: [] },
      { type: 'PLAY_CARD', playerId: 'p0', cardInstanceId: 'o1', payment: [{ runeId: 1 }] },
      { type: 'PLAY_CARD', playerId: 'p0', cardInstanceId: '__proto__', payment: [] },
      {
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: 'o1',
        payment: [],
        location: { kind: 'x' },
      },
      { type: 'STANDARD_MOVE', playerId: 'p0', unitIds: ['o1'], destination: null },
      { type: 'STANDARD_MOVE', playerId: 'p0', unitIds: 'o1', destination: { kind: 'base' } },
      { type: 'ASSIGN_COMBAT_DAMAGE', playerId: 'p0', assignments: [{ unitId: 'o1' }] },
      { type: 'HIDE_CARD', playerId: 'p0' },
      { type: 'EQUIP', playerId: 'p0', equipmentId: 'zzz', unitId: 'yyy' },
      { type: 'ACTIVATE_RUNE', playerId: 'p0', runeId: 'o1', mode: 'SMASH' },
    ];
    for (const j of junk) {
      let res: ReturnType<typeof reduce> | undefined;
      expect(() => {
        res = reduce(s, FIXTURE_CARDS, j as Intent);
      }).not.toThrow();
      expect(res?.ok, JSON.stringify(j)).toBe(false);
    }
  });

  it('never mutates its input state', () => {
    // Tests Rule 100: the engine is a pure function of state and intent
    const s = started();
    const before = JSON.stringify(s);
    ok(s, { type: 'END_TURN', playerId: 'p0' });
    reduce(s, FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p1' });
    applyIntent(s, FIXTURE_CARDS, { type: 'CONCEDE', playerId: 'p0' });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('exposes one frozen hook wiring', () => {
    // Tests Rule 100: a single shared wiring keeps host and AI deterministic
    expect(Object.isFrozen(ENGINE_HOOKS)).toBe(true);
    expect(ENGINE_HOOKS.phase.onBeginning).toBeTypeOf('function');
    expect(ENGINE_HOOKS.phase.onScoringStep).toBeTypeOf('function');
  });
});
