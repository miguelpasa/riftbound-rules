import { describe, it, expect } from 'vitest';
import { checkInvariants } from '../invariants.js';
import { getLegalActions } from '../legalActions.js';
import { actorToAct, reduce } from '../reducer.js';
import { sanitizeFor } from '../sanitize.js';
import { createGame } from '../setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from '../testing/fixtures.js';
import type { ClientGameState, DeckList, GameState, Intent, PlayerId } from '../types/index.js';
import { AIController } from './bot.js';
import { determinize } from './determinize.js';

const CARDS = FIXTURE_CARDS;

/** The deck a seat actually received (createGame may swap the two decks). */
function deckOf(state: GameState, seat: PlayerId): DeckList {
  const legend = state.objects[state.players[seat === 'p0' ? 0 : 1].legend as string]?.cardId;
  return legend === FIXTURE_DECK_A.legendId ? FIXTURE_DECK_A : FIXTURE_DECK_B;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Player = (state: GameState, seat: PlayerId) => Intent | null;

function randomPlayer(seed: number): Player {
  const rand = mulberry(seed);
  let turn = -1;
  let n = 0;
  return (state, seat) => {
    if (state.turn.number !== turn) {
      turn = state.turn.number;
      n = 0;
    }
    const actions = getLegalActions(state, CARDS, seat);
    if (actions.length === 0) return null;
    n++;
    const end = actions.find((a) => a.type === 'END_TURN');
    if (end && n > 14) return end;
    return actions[Math.floor(rand() * actions.length)] as Intent;
  };
}

function botPlayer(opts: { seed: string; difficulty?: 'easy' | 'normal' }): {
  player: Player;
  rejected: string[];
} {
  const bots: Partial<Record<PlayerId, AIController>> = {};
  const rejected: string[] = [];
  const player: Player = (state, seat) => {
    let bot = bots[seat];
    if (!bot) {
      bot = new AIController(seat, {
        cards: CARDS,
        deck: deckOf(state, seat),
        seed: opts.seed,
        maxCandidates: 30,
        now: () => 0, // budget never expires: deterministic
        ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
      });
      bots[seat] = bot;
    }
    const intent = bot.decide(sanitizeFor(state, seat));
    if (intent && !reduce(state, CARDS, intent).ok) rejected.push(JSON.stringify(intent));
    return intent;
  };
  return { player, rejected };
}

interface Result {
  winner: PlayerId | undefined;
  status: GameState['gameStatus'];
  turns: number;
}

function playMatch(seed: string, players: Record<PlayerId, Player>): Result {
  let state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], seed);
  for (let step = 0; step < 4000 && state.gameStatus === 'IN_PROGRESS'; step++) {
    const seat = actorToAct(state);
    const intent = players[seat](state, seat);
    if (!intent) throw new Error(`seed ${seed} step ${step}: ${seat} produced no intent`);
    const r = reduce(state, CARDS, intent);
    if (!r.ok) throw new Error(`seed ${seed} step ${step}: rejected ${JSON.stringify(intent)}`);
    state = r.state;
    if (step % 40 === 0) {
      const bad = checkInvariants(state, CARDS);
      if (bad.length > 0) throw new Error(`invariants: ${bad.join('; ')}`);
    }
  }
  return { winner: state.winner, status: state.gameStatus, turns: state.turn.number };
}

/** A mid-game state with hidden information on both sides. */
function midGame(seed: string, steps: number): GameState {
  let state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], seed);
  const rand = randomPlayer(7);
  for (let i = 0; i < steps && state.gameStatus === 'IN_PROGRESS'; i++) {
    const seat = actorToAct(state);
    const intent = rand(state, seat);
    if (!intent) break;
    const r = reduce(state, CARDS, intent);
    if (!r.ok) break;
    state = r.state;
  }
  return state;
}

function newBot(seat: PlayerId, state: GameState, seed = 's'): AIController {
  return new AIController(seat, { cards: CARDS, deck: deckOf(state, seat), seed, now: () => 0 });
}

describe('AIController', () => {
  it('returns null when the engine is not waiting for the bot', () => {
    // Tests Rule 117: only the player whose mulligan turn it is may act
    const state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'idle');
    expect(newBot('p1', state).decide(sanitizeFor(state, 'p1'))).toBeNull();
    expect(newBot('p0', state).decide(sanitizeFor(state, 'p0'))).not.toBeNull();
  });

  it('never returns a view of another seat or a CONCEDE', () => {
    // Tests Rule 649: conceding is never chosen by the bot
    const state = midGame('concede', 30);
    const seat = actorToAct(state);
    const bot = newBot(seat, state);
    const i = bot.decide(sanitizeFor(state, seat));
    expect(i?.type).not.toBe('CONCEDE');
    expect(newBot(seat === 'p0' ? 'p1' : 'p0', state).decide(sanitizeFor(state, seat))).toBeNull();
  });

  it('keeps its hand in the mulligan unless it holds two heavy cards, then swaps them', () => {
    // Tests Rule 117: mulligan sets aside up to two cards
    let checkedSwap = false;
    let checkedKeep = false;
    for (let n = 0; n < 12 && !(checkedSwap && checkedKeep); n++) {
      const state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'mull-' + n);
      const seat = actorToAct(state);
      const idx = seat === 'p0' ? 0 : 1;
      const heavy = (s: GameState): string[] =>
        s.players[idx]!.hand.filter((id) => (CARDS[s.objects[id]!.cardId]?.cost.energy ?? 0) >= 5);
      const intent = newBot(seat, state).decide(sanitizeFor(state, seat));
      expect(intent?.type).toBe('MULLIGAN');
      if (intent?.type !== 'MULLIGAN') continue;
      if (heavy(state).length < 2) {
        expect(intent.cardIds).toEqual([]);
        checkedKeep = true;
        continue;
      }
      expect(new Set(intent.cardIds)).toEqual(new Set(heavy(state)));
      checkedSwap = true;
    }
    expect(checkedKeep).toBe(true);
    // Force two 5-cost cards into the opening hand by swapping them with hand cards.
    let state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'mull-forced');
    const heavyIn = (s: GameState): string[] => {
      const i = actorToAct(s) === 'p0' ? 0 : 1;
      return s.players[i]!.mainDeck.filter(
        (id) => (CARDS[s.objects[id]!.cardId]?.cost.energy ?? 0) >= 5,
      );
    };
    for (let n = 0; heavyIn(state).length < 2; n++) {
      state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'mull-forced-' + n);
    }
    const seat = actorToAct(state);
    const idx = seat === 'p0' ? 0 : 1;
    const forced = structuredClone(state);
    const ps = forced.players[idx]!;
    const titans = heavyIn(forced);
    for (let k = 0; k < 2; k++) {
      const h = ps.hand[k] as string;
      const d = titans[k] as string;
      const hz = forced.objects[h]!.zone;
      forced.objects[h]!.zone = forced.objects[d]!.zone;
      forced.objects[d]!.zone = hz;
      ps.hand[k] = d;
      ps.mainDeck[ps.mainDeck.indexOf(d)] = h;
    }
    expect(checkInvariants(forced, CARDS)).toEqual([]);
    const intent = newBot(seat, forced).decide(sanitizeFor(forced, seat));
    expect(intent).toMatchObject({ type: 'MULLIGAN' });
    if (intent?.type === 'MULLIGAN')
      expect(new Set(intent.cardIds)).toEqual(new Set(titans.slice(0, 2)));
  });

  it('plays a unit rather than ending the turn when it can afford one', () => {
    // Tests Rule 315: the Main Phase is where the turn player plays cards
    let found = 0;
    for (const seed of ['a', 'b', 'c', 'd']) {
      let state = createGame(CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], `play-${seed}`);
      const pl = botPlayer({ seed: 'x' }).player;
      for (let i = 0; i < 200 && state.gameStatus === 'IN_PROGRESS'; i++) {
        const seat = actorToAct(state);
        const intent = pl(state, seat) as Intent;
        if (intent.type === 'PLAY_CARD') found++;
        const r = reduce(state, CARDS, intent);
        if (!r.ok) throw new Error('rejected');
        state = r.state;
        if (found > 0) break;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('is deterministic for the same seed and view, and honours the budget with a greedy fallback', () => {
    // Tests Rule 315: a decision is a pure function of (seed, view)
    const state = midGame('det', 40);
    const seat = actorToAct(state);
    const view = sanitizeFor(state, seat);
    const a = newBot(seat, state, 'k').decide(view);
    const b = newBot(seat, state, 'k').decide(view);
    expect(a).toEqual(b);
    // budget 0 -> nothing can be scored -> greedy fallback, which is still legal
    const zero = new AIController(seat, {
      cards: CARDS,
      deck: deckOf(state, seat),
      seed: 'k',
      budgetMs: 0,
      now: () => 5,
    });
    const g = zero.decide(view);
    expect(g).not.toBeNull();
    expect(reduce(state, CARDS, g as Intent).ok).toBe(true);
  });
});

describe('information hiding', () => {
  /** Rebuild the true state with the opponent's (and the bot's own) hidden zones permuted/swapped. */
  function scramble(state: GameState, seat: PlayerId): GameState {
    const s = structuredClone(state);
    const opp = seat === 'p0' ? 1 : 0;
    const swapCards = (a: string, b: string): void => {
      const ca = s.objects[a]!.cardId;
      s.objects[a]!.cardId = s.objects[b]!.cardId;
      s.objects[b]!.cardId = ca;
    };
    const oh = s.players[opp]!.hand;
    const od = s.players[opp]!.mainDeck;
    // reverse the opponent's deck ORDER and exchange hand cards with deck cards
    s.players[opp]!.mainDeck = [...od].reverse();
    for (let i = 0; i < Math.min(oh.length, od.length); i++)
      swapCards(oh[i] as string, od[i] as string);
    s.players[opp]!.runeDeck = [...s.players[opp]!.runeDeck].reverse();
    // the bot's own deck order is secret too
    const me = seat === 'p0' ? 0 : 1;
    s.players[me]!.mainDeck = [...s.players[me]!.mainDeck].reverse();
    return s;
  }

  it('makes the same decision when hidden hand / deck order differ in the true state', () => {
    // Tests Rule 128: hidden zones (opponent hand, deck order) never influence the bot
    for (const seed of ['h1', 'h2', 'h3', 'h4', 'h5']) {
      for (const steps of [10, 35, 70]) {
        const state = midGame(seed, steps);
        if (state.gameStatus !== 'IN_PROGRESS') continue;
        const seat = actorToAct(state);
        const other = scramble(state, seat);
        expect(JSON.stringify(other)).not.toBe(JSON.stringify(state)); // truly different worlds
        const v1 = sanitizeFor(state, seat);
        const v2 = sanitizeFor(other, seat);
        expect(v2).toEqual(v1);
        const d1 = newBot(seat, state, 'same').decide(v1);
        const d2 = newBot(seat, other, 'same').decide(v2);
        expect(d2).toEqual(d1);
      }
    }
  }, 60_000);

  it('never mutates the view it is given', () => {
    // Tests Rule 128: the bot only reads the sanitized view
    for (const steps of [0, 12, 50, 90]) {
      const state = midGame('mut', steps);
      if (state.gameStatus !== 'IN_PROGRESS') continue;
      const seat = actorToAct(state);
      const view: ClientGameState = sanitizeFor(state, seat);
      const before = structuredClone(view);
      const stateBefore = structuredClone(state);
      newBot(seat, state, 'm').decide(view);
      expect(view).toEqual(before);
      expect(state).toEqual(stateBefore); // and the real game (incl. its rng) is untouched
    }
  });
});

describe('determinize', () => {
  it('builds an invariant-clean state consistent with the view, with bot-seeded rng', () => {
    // Tests Rule 107: object zones stay consistent after filling hidden information
    for (const steps of [0, 25, 60, 110]) {
      const state = midGame('det-inv', steps);
      for (const seat of ['p0', 'p1'] as const) {
        const view = sanitizeFor(state, seat);
        const det = determinize(view, CARDS, deckOf(state, seat), 'bot-seed');
        expect(checkInvariants(det, CARDS)).toEqual([]);
        const i = seat === 'p0' ? 0 : 1;
        const o = 1 - i;
        expect(det.players[i]!.hand).toEqual(state.players[i]!.hand);
        expect(det.players[i]!.mainDeck.length).toBe(state.players[i]!.mainDeck.length);
        expect(det.players[o]!.hand.length).toBe(state.players[o]!.hand.length);
        expect(det.players[o]!.mainDeck.length).toBe(state.players[o]!.mainDeck.length);
        expect(det.players[o]!.runeDeck.length).toBe(state.players[o]!.runeDeck.length);
        expect(det.seed.seed).toBe('bot-seed');
        expect(det.rng.s).not.toEqual(state.rng.s);
        for (const [id, obj] of Object.entries(state.objects)) {
          if (view.objects[id] && !('hidden' in view.objects[id]!)) {
            expect(det.objects[id]!.cardId).toBe(obj.cardId);
          }
        }
        // the own main deck holds exactly the deck minus the visible cards
        expect(sanitizeFor(det, seat)).toEqual(view);
      }
    }
  });

  it('is deterministic per seed and varies with the seed', () => {
    // Tests Rule 114: shuffling uses the bot PRNG only
    const state = midGame('det-seed', 30);
    const view = sanitizeFor(state, 'p0');
    const a = determinize(view, CARDS, deckOf(state, 'p0'), 's1');
    const b = determinize(view, CARDS, deckOf(state, 'p0'), 's1');
    const c = determinize(view, CARDS, deckOf(state, 'p0'), 's2');
    expect(a).toEqual(b);
    expect(JSON.stringify(a.objects)).not.toBe(JSON.stringify(c.objects));
  });
});

describe('strength and regression', () => {
  it('beats a random-legal-action player in seeded games and never has an intent rejected', () => {
    // Tests Rule 473: games reach a victory; every bot intent is accepted by the real state
    let botWins = 0;
    let finished = 0;
    const games = 20;
    for (let g = 0; g < games; g++) {
      const { player, rejected } = botPlayer({ seed: `b${g}` });
      const rnd = randomPlayer(g + 1);
      const botSeat: PlayerId = g % 2 === 0 ? 'p0' : 'p1';
      const res = playMatch(`str-${g}`, {
        p0: botSeat === 'p0' ? player : rnd,
        p1: botSeat === 'p1' ? player : rnd,
      });
      expect(res.status, `game ${g}`).not.toBe('ABORTED');
      expect(rejected, `game ${g}`).toEqual([]);
      if (res.status === 'FINISHED') {
        finished++;
        if (res.winner === botSeat) botWins++;
      }
    }
    (globalThis as { console?: { log(s: string): void } }).console?.log(
      `BOT vs RANDOM: wins=${botWins}/${games} finished=${finished}`,
    );
    expect(finished).toBeGreaterThanOrEqual(games - 2);
    expect(botWins).toBeGreaterThan(games * 0.6);
  }, 60_000);

  it('plays bot vs bot to completion with no aborts and no rejected intents', () => {
    // Tests Rule 473: bot-vs-bot games terminate
    let finished = 0;
    for (let g = 0; g < 6; g++) {
      const a = botPlayer({ seed: `A${g}` });
      const b = botPlayer({ seed: `B${g}`, difficulty: g % 2 === 0 ? 'easy' : 'normal' });
      const res = playMatch(`bvb-${g}`, { p0: a.player, p1: b.player });
      expect(res.status).not.toBe('ABORTED');
      expect(a.rejected).toEqual([]);
      expect(b.rejected).toEqual([]);
      if (res.status === 'FINISHED') finished++;
    }
    expect(finished).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
