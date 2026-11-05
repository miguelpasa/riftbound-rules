import { describe, it, expect } from 'vitest';
import { AIController } from './ai/bot.js';
import { getLegalActions } from './legalActions.js';
import { actorToAct, applyIntent, reduce } from './reducer.js';
import { hashString, stateHash } from './replay.js';
import { sanitizeFor } from './sanitize.js';
import { createGame } from './setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import type { DeckList, GameState, Intent, PlayerId } from './types/index.js';
import { cloneState, fork, inSession, runSession } from './workingCopy.js';

const CARDS = FIXTURE_CARDS;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Intents that are mostly illegal: other player's actions, bad ids, wrong phase, junk payloads. */
function junkIntents(state: GameState, rand: () => number): Intent[] {
  const ids = Object.keys(state.objects);
  const id = (): string => ids[Math.floor(rand() * ids.length)] as string;
  const bf = state.battlefields[0]?.id ?? 'bf';
  const p = (): PlayerId => (rand() < 0.5 ? 'p0' : 'p1');
  return [
    { type: 'END_TURN', playerId: p() },
    { type: 'PASS_PRIORITY', playerId: p() },
    { type: 'PLAY_CARD', playerId: p(), cardInstanceId: id(), payment: [] },
    { type: 'PLAY_CARD', playerId: p(), cardInstanceId: 'nope', payment: [] },
    {
      type: 'PLAY_CARD',
      playerId: p(),
      cardInstanceId: id(),
      payment: [{ runeId: id(), mode: 'RECYCLE' }],
    },
    { type: 'STANDARD_MOVE', playerId: p(), unitIds: [id()], destination: { kind: 'base' } },
    {
      type: 'STANDARD_MOVE',
      playerId: p(),
      unitIds: [id(), id()],
      destination: { kind: 'battlefield', battlefieldId: bf },
    },
    { type: 'ACTIVATE_RUNE', playerId: p(), runeId: id(), mode: 'EXHAUST' },
    { type: 'ACTIVATE_RUNE', playerId: p(), runeId: id(), mode: 'RECYCLE' },
    { type: 'EQUIP', playerId: p(), equipmentId: id(), unitId: id() },
    { type: 'HIDE_CARD', playerId: p(), cardInstanceId: id(), battlefieldId: bf },
    { type: 'CHOOSE_STAGED', playerId: p(), battlefieldId: bf },
    { type: 'MULLIGAN', playerId: p(), cardIds: [id()] },
    { type: 'ASSIGN_COMBAT_DAMAGE', playerId: p(), assignments: [{ unitId: id(), amount: 9 }] },
    { type: 'ACTIVATE_ABILITY', playerId: p() } as Intent,
    { type: 'BOGUS', playerId: 'p0' } as unknown as Intent,
  ];
}

/** Seeded random game; calls `visit(state)` before every step so tests can poke at mid-game states. */
function playRandom(
  seed: number,
  steps: number,
  visit: (state: GameState, actor: PlayerId, rand: () => number) => void,
): GameState {
  const rand = prng(seed * 31 + 7);
  let state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], `r37-${seed}`);
  for (let i = 0; i < steps && state.gameStatus === 'IN_PROGRESS'; i++) {
    const actor = actorToAct(state);
    visit(state, actor, rand);
    const legal = getLegalActions(state, CARDS, actor).filter((a) => a.type !== 'CONCEDE');
    if (legal.length === 0) break;
    const end = legal.find((a) => a.type === 'END_TURN');
    const intent =
      end && rand() < 0.15 ? end : (legal[Math.floor(rand() * legal.length)] as Intent);
    const r = reduce(state, CARDS, intent);
    if (!r.ok) throw new Error(`legal intent rejected: ${JSON.stringify(intent)}`);
    state = r.state;
  }
  return state;
}

describe('reduce purity (R37 working copy)', () => {
  it('never mutates its input state: legal and junk intents on 6 seeded games', () => {
    // Tests Rule 322: Cleanup runs on a private copy; the caller's state is untouched
    let checked = 0;
    let rejected = 0;
    for (let seed = 1; seed <= 6; seed++) {
      playRandom(seed, 220, (state, actor, rand) => {
        const before = JSON.stringify(state);
        const candidates = [
          ...getLegalActions(state, CARDS, actor),
          ...junkIntents(state, rand),
          { type: 'CONCEDE', playerId: actor } as Intent,
        ];
        for (const intent of candidates) {
          const r = reduce(state, CARDS, intent);
          const a = applyIntent(state, CARDS, intent);
          expect(
            JSON.stringify(state) === before,
            `${JSON.stringify(intent)} mutated the input`,
          ).toBe(true);
          if (r.ok) {
            expect(r.state).not.toBe(state);
          } else {
            rejected++;
            expect(Object.keys(r)).not.toContain('state');
            expect(a.ok).toBe(false);
          }
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(250);
  }, 120_000);

  it('works on a deeply frozen input (any write to it would throw and reject the intent)', () => {
    // Tests Rule 322: a frozen input proves no helper writes to the caller's state
    let ok = 0;
    for (let seed = 20; seed <= 24; seed++) {
      playRandom(seed, 160, (state, actor) => {
        const frozen = deepFreeze(structuredClone(state));
        for (const intent of getLegalActions(frozen, CARDS, actor)) {
          const r = reduce(frozen, CARDS, intent);
          expect(r.ok, `${JSON.stringify(intent)} on a frozen state`).toBe(true);
          if (r.ok) {
            expect(Object.isFrozen(r.state)).toBe(false);
            ok++;
          }
        }
      });
    }
    expect(ok).toBeGreaterThan(500);
  }, 120_000);

  it('the returned state is private: reducing twice gives equal, distinct states', () => {
    // Tests Rule 322: no ownership leaks out of a reduce session
    playRandom(5, 120, (state, actor) => {
      const intent = getLegalActions(state, CARDS, actor)[0];
      if (!intent) return;
      const a = reduce(state, CARDS, intent);
      const b = reduce(state, CARDS, intent);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.state).not.toBe(b.state);
      expect(a.state).toStrictEqual(b.state);
      expect(a.events).toStrictEqual(b.events);
      // feeding a result back in must not mutate it either
      const snap = structuredClone(a.state);
      const next = getLegalActions(a.state, CARDS, actorToAct(a.state))[0];
      if (next) reduce(a.state, CARDS, next);
      expect(a.state).toStrictEqual(snap);
    });
    expect(inSession()).toBe(false);
  });

  it('fork copies outside a session and only skips the copy for states the session made', () => {
    // Tests Rule 322: fork() outside reduce is a plain copy
    const s = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'fork');
    const c = fork(s);
    expect(c).not.toBe(s);
    expect(c).toStrictEqual(s);
    runSession(() => {
      const first = fork(s);
      expect(first).not.toBe(s);
      expect(fork(first)).toBe(first); // owned by this session: no second copy
      expect(fork(s)).not.toBe(first); // the input itself is never owned
    });
    expect(fork(s)).not.toBe(s);
  });
});

describe('cloneState equals structuredClone', () => {
  it('on game states from 12 random games (every 5th step)', () => {
    // Tests Rule 115: the hand-written clone is value-identical to structuredClone
    let n = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let i = 0;
      playRandom(seed, 200, (state) => {
        if (i++ % 5 !== 0) return;
        const a = cloneState(state);
        const b = structuredClone(state);
        expect(a).toStrictEqual(b);
        expect(a).toStrictEqual(state);
        expect(stateHash(a)).toBe(stateHash(state));
        expect(JSON.stringify(a)).toBe(JSON.stringify(state)); // key order too
        // independence: a write to the copy never reaches the original
        a.players[0].points += 5;
        a.flow.chain.push({} as never);
        expect(state.players[0].points).toBe(b.players[0].points);
        expect(state.flow.chain).toHaveLength(b.flow.chain.length);
        n++;
      });
    }
    expect(n).toBeGreaterThan(100);
  });

  it('keeps undefined properties and falls back to structuredClone for non-plain values', () => {
    // Tests Rule 115: edge cases of the clone
    const src = {
      a: undefined,
      b: [1, [2, { c: null }]],
      d: new Date(5),
      e: new Map([[1, { x: 1 }]]),
    };
    const out = cloneState(src);
    expect(Object.keys(out)).toStrictEqual(['a', 'b', 'd', 'e']);
    expect(out).toStrictEqual(structuredClone(src));
    expect(out.e.get(1)).not.toBe(src.e.get(1));
  });
});

// Golden digests recorded with the pre-R37 engine (structuredClone in every helper). If a rule
// change legitimately alters play, regenerate them; an optimisation must never change them.
const GOLDEN = { s3: '1e72e78b61094b', s8: '0c5de2a9671cad', s15: '077db1f86f080b' };
const GOLDEN_BOT = '165d6c957b708c';

describe('determinism and replay hashes', () => {
  /** Scripted seeded game on the fixture decks; the digest covers the hash before every step. */
  function scriptedDigest(seed: number, steps: number): string {
    const hashes: string[] = [];
    const final = playRandom(seed, steps, (state) => {
      hashes.push(stateHash(state));
    });
    hashes.push(stateHash(final));
    return hashString(hashes.join(','));
  }

  it('replays to an identical hash chain, and matches the golden digests', () => {
    // Tests Rule 115: results are a pure function of seed and intents
    expect(scriptedDigest(3, 300)).toBe(scriptedDigest(3, 300));
    const got = {
      s3: scriptedDigest(3, 300),
      s8: scriptedDigest(8, 300),
      s15: scriptedDigest(15, 300),
    };
    expect(got).toStrictEqual(GOLDEN);
  }, 60_000);

  it('bot vs bot with a fixed clock is deterministic and never has an intent rejected', () => {
    // Tests Rule 115: bot games are reproducible
    const run = (): { digest: string; rejected: number } => {
      let state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'r37-bots');
      const bots: Partial<Record<PlayerId, AIController>> = {};
      const deckOf = (seat: PlayerId): DeckList => {
        const legend = state.objects[state.players[seat === 'p0' ? 0 : 1].legend as string]?.cardId;
        return legend === FIXTURE_DECK_A.legendId ? FIXTURE_DECK_A : FIXTURE_DECK_B;
      };
      const hashes: string[] = [];
      let rejected = 0;
      for (let i = 0; i < 90 && state.gameStatus === 'IN_PROGRESS'; i++) {
        const seat = actorToAct(state);
        const bot = (bots[seat] ??= new AIController(seat, {
          cards: CARDS,
          deck: deckOf(seat),
          seed: 'r37',
          maxCandidates: 20,
          now: () => 0,
        }));
        const intent = bot.decide(sanitizeFor(state, seat));
        if (!intent) break;
        const r = reduce(state, CARDS, intent);
        if (!r.ok) {
          rejected++;
          break;
        }
        state = r.state;
        hashes.push(stateHash(state));
      }
      return { digest: hashString(hashes.join(',')), rejected };
    };
    const a = run();
    const b = run();
    expect(a.rejected).toBe(0);
    expect(a).toStrictEqual(b);
    expect(a.digest).toBe(GOLDEN_BOT);
  }, 60_000);
});
