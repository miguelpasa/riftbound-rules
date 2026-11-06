/**
 * AIController: a 1-ply (plus settle) determinized bot that plays from a SANITIZED view only.
 *
 * Procedure per decision (`decideNextAction(view)`):
 *  1. Determinize the view (ai/determinize.ts) with the bot's own PRNG. The determinization seed is
 *     `<seed>:<hash of the view>`, so the same seed + same view always yields the same decision and
 *     two views that differ only in hidden information (impossible by construction) cannot differ.
 *  2. If the engine is not waiting for the bot -> null. Otherwise list `getLegalActions`.
 *  3. One action -> that action. Mulligan: keep, but set aside up to 2 cards with energy cost >= 5
 *     when the hand holds at least two of them. Combat damage: `autoAssign` (the first legal action).
 *  4. Otherwise score every pruned candidate: apply it with the full `reduce` (pure; the input state
 *     is never mutated, so no extra clone is needed), then "settle" the result by auto-passing
 *     priority / auto-assigning damage (assuming the opponent does not respond) until the board is
 *     neutral again, and evaluate(). Candidates are visited in a priority order until the wall-clock
 *     budget (`opts.now`) is exhausted; the best score so far wins (ties: earlier in order).
 *  5. A non-terminal action is only chosen when it strictly beats the best terminal one (PASS_PRIORITY,
 *     or - for END_TURN - the do-nothing baseline), so the bot never churns through value-less actions.
 *  6. If the budget expires before anything was scored, a greedy heuristic is used.
 *
 * Only intents produced by `getLegalActions` are ever returned and CONCEDE never is.
 */
import { autoAssign } from '../combat.js';
import { getLegalActions } from '../legalActions.js';
import { actorToAct, reduce } from '../reducer.js';
import { randomInt, seedRng } from '../rng.js';
import type {
  CardDatabase,
  ClientGameState,
  DeckList,
  GameState,
  Intent,
  PlayerId,
  RngState,
} from '../types/index.js';
import { determinize } from './determinize.js';
import type { DeterminizeOptions } from './determinize.js';
import { DEFAULT_WEIGHTS, evaluate } from './evaluate.js';
import type { EvalWeights } from './evaluate.js';

/** easy: noisy and short-sighted; normal: 1-ply; hard: 1-ply plus a rollout of the rest of the turn. */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** Minimal synchronous bot contract. */
export interface SyncBot {
  decide(view: ClientGameState): Intent | null;
}

export interface AIControllerOptions {
  cards: CardDatabase;
  /** The bot's own decklist (used to refill its hidden decks and, by default, as the opponent prior). */
  deck: DeckList;
  /** Bot PRNG seed (default 'bot'). Never the game seed. */
  seed?: string;
  /** Wall-clock budget per decision in ms (default 500). */
  budgetMs?: number;
  /** Max candidates scored per decision (default 60). */
  maxCandidates?: number;
  /** Clock, injectable for deterministic tests (default Date.now). */
  now?: () => number;
  /** See BotDifficulty (default 'normal'). Sets the defaults of the options below. */
  difficulty?: BotDifficulty;
  /** Top candidates re-scored by playing the rest of the turn out (default: 4 on hard, else 0). */
  lookahead?: number;
  weights?: Readonly<EvalWeights>;
  /** Overrides the mirror assumption for the opponent (see determinize.ts). */
  determinize?: DeterminizeOptions;
  /** Optional per-decision profiling hook (timings use `now`). Never affects the decision. */
  onProfile?: (p: DecisionProfile) => void;
}

/** Per-decision timing/size record handed to `AIControllerOptions.onProfile`. */
export interface DecisionProfile {
  kind: 'forced' | 'mulligan' | 'assignment' | 'search';
  totalMs: number;
  hashMs: number;
  determinizeMs: number;
  legalMs: number;
  searchMs: number;
  legalCount: number;
  candidateCount: number;
  scored: number;
  /** The budget expired before every candidate was scored. */
  budgetExpired: boolean;
  /** The greedy fallback was used (nothing scored). */
  fallback: boolean;
  /** Number of reducer calls made by the search. */
  reduceCalls: number;
}

const EPS = 0.5;
const MAX_EQUIP = 3;
const MAX_MOVES = 8;
const SETTLE_STEPS = 12;
const EASY_JITTER = 400;
/** Chance (per mille) that an easy bot just ends its turn / passes instead of acting. */
const EASY_LAZY = 150;
const ROLLOUT_STEPS = 10;
const ROLLOUT_CANDIDATES = 10;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const isTerminal = (i: Intent): boolean => i.type === 'PASS_PRIORITY' || i.type === 'END_TURN';

export class AIController implements SyncBot {
  readonly playerId: PlayerId;
  private readonly cards: CardDatabase;
  private readonly deck: DeckList;
  private readonly seed: string;
  private readonly budgetMs: number;
  private readonly maxCandidates: number;
  private readonly now: () => number;
  private readonly difficulty: BotDifficulty;
  private readonly lookahead: number;
  private readonly weights: Readonly<EvalWeights>;
  private readonly detOpts: DeterminizeOptions;
  private readonly onProfile: ((p: DecisionProfile) => void) | undefined;
  private reduceCalls = 0;
  private lastSearch = { candidates: 0, scored: 0, expired: false, fallback: false };

  constructor(aiPlayerId: PlayerId, opts: AIControllerOptions) {
    this.playerId = aiPlayerId;
    this.cards = opts.cards;
    this.deck = opts.deck;
    this.seed = opts.seed ?? 'bot';
    this.budgetMs = opts.budgetMs ?? 500;
    this.difficulty = opts.difficulty ?? 'normal';
    this.maxCandidates = Math.max(1, opts.maxCandidates ?? (this.difficulty === 'easy' ? 12 : 60));
    this.lookahead = Math.max(0, opts.lookahead ?? (this.difficulty === 'hard' ? 4 : 0));
    this.now = opts.now ?? (() => Date.now());
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.detOpts = opts.determinize ?? {};
    this.onProfile = opts.onProfile;
  }

  /** BotLike-compatible alias (synchronous). */
  decide(view: ClientGameState): Intent | null {
    return this.decideNextAction(view);
  }

  decideNextAction(view: ClientGameState): Intent | null {
    const me = this.playerId;
    if (view.viewer !== me || view.gameStatus !== 'IN_PROGRESS') return null;
    const prof = this.onProfile !== undefined;
    const t0 = this.now();
    const start = t0;
    const seed = `${this.seed}:${fnv1a(JSON.stringify(view))}`;
    const t1 = prof ? this.now() : 0;
    const state = determinize(view, this.cards, this.deck, seed, this.detOpts);
    const t2 = prof ? this.now() : 0;
    if (actorToAct(state) !== me) return null;

    const legal = getLegalActions(state, this.cards, me).filter((i) => i.type !== 'CONCEDE');
    const t3 = prof ? this.now() : 0;
    if (legal.length === 0) return null;
    this.reduceCalls = 0;
    this.lastSearch = { candidates: 0, scored: 0, expired: false, fallback: false };
    let kind: DecisionProfile['kind'] = 'forced';
    let out: Intent;
    if (legal.length === 1) out = legal[0] as Intent;
    else if (state.turn.phase === 'MULLIGAN') {
      kind = 'mulligan';
      out = this.mulligan(state, legal);
    } else if (state.flow.combat?.awaitingAssignmentFrom === me) {
      kind = 'assignment';
      out = this.assignment(state, legal);
    } else {
      kind = 'search';
      out = this.search(state, legal, start, seed);
    }
    if (this.onProfile) {
      const t4 = this.now();
      this.onProfile({
        kind,
        totalMs: t4 - t0,
        hashMs: t1 - t0,
        determinizeMs: t2 - t1,
        legalMs: t3 - t2,
        searchMs: t4 - t3,
        legalCount: legal.length,
        candidateCount: this.lastSearch.candidates,
        scored: this.lastSearch.scored,
        budgetExpired: this.lastSearch.expired,
        fallback: this.lastSearch.fallback,
        reduceCalls: this.reduceCalls,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ mulligan / damage

  private mulligan(state: GameState, legal: Intent[]): Intent {
    const me = this.playerId;
    const hand = state.players[me === 'p0' ? 0 : 1].hand;
    const heavy = hand
      .filter(
        (id) =>
          (this.cards[(state.objects[id] as { cardId: string }).cardId]?.cost.energy ?? 0) >= 5,
      )
      .sort((a, b) => this.energyOf(state, b) - this.energyOf(state, a) || a.localeCompare(b));
    const keep = legal.find((i) => i.type === 'MULLIGAN' && i.cardIds.length === 0) ?? legal[0];
    if (heavy.length < 2) return keep as Intent;
    const want = new Set(heavy.slice(0, 2));
    const match = legal.find(
      (i) =>
        i.type === 'MULLIGAN' &&
        i.cardIds.length === want.size &&
        i.cardIds.every((c) => want.has(c)),
    );
    return match ?? (keep as Intent);
  }

  private energyOf(state: GameState, id: string): number {
    const o = state.objects[id];
    return o ? (this.cards[o.cardId]?.cost.energy ?? 0) : 0;
  }

  private assignment(state: GameState, legal: Intent[]): Intent {
    const me = this.playerId;
    const assignments = autoAssign(state, this.cards, me);
    const want = JSON.stringify(assignments);
    return (
      legal.find(
        (i) => i.type === 'ASSIGN_COMBAT_DAMAGE' && JSON.stringify(i.assignments) === want,
      ) ?? (legal[0] as Intent)
    );
  }

  // ------------------------------------------------------------------ search

  /** Auto-resolve chain / showdown / combat assuming the opponent just passes. */
  private settle(start: GameState, deadline: number): GameState {
    let s = start;
    for (let i = 0; i < SETTLE_STEPS; i++) {
      if (s.gameStatus !== 'IN_PROGRESS') break;
      // Hard stop: a settle must not push the decision past its budget (the partial state is scored).
      if (i > 0 && this.now() >= deadline) break;
      if (!s.flow.showdown && !s.flow.combat && s.flow.chain.length === 0) break;
      const awaiting = s.flow.combat?.awaitingAssignmentFrom ?? null;
      const intent: Intent =
        awaiting !== null
          ? {
              type: 'ASSIGN_COMBAT_DAMAGE',
              playerId: awaiting,
              assignments: autoAssign(s, this.cards, awaiting),
            }
          : { type: 'PASS_PRIORITY', playerId: actorToAct(s) };
      this.reduceCalls++;
      const r = reduce(s, this.cards, intent);
      if (!r.ok) break;
      s = r.state;
    }
    return s;
  }

  private score(state: GameState, intent: Intent, deadline: number): number | null {
    this.reduceCalls++;
    const r = reduce(state, this.cards, intent);
    if (!r.ok) return null;
    return evaluate(this.settle(r.state, deadline), this.cards, this.playerId, this.weights);
  }

  private cardIdOf(state: GameState, id: string): string {
    return state.objects[id]?.cardId ?? id;
  }

  private energyOfIntent(state: GameState, i: Intent): number {
    return i.type === 'PLAY_CARD' ? this.energyOf(state, i.cardInstanceId) : 0;
  }

  /** Prune and order the legal list: plays (expensive first), hides, moves (best first), equips, rest. */
  private candidates(state: GameState, legal: Intent[]): Intent[] {
    const terminal = legal.filter(isTerminal);
    // Identical plays of copies of the same card (same payment/location/targets) are equivalent.
    const seenPlays = new Set<string>();
    const plays = legal
      .filter((i) => {
        if (i.type !== 'PLAY_CARD') return false;
        const key = JSON.stringify({
          ...i,
          cardInstanceId: this.cardIdOf(state, i.cardInstanceId),
        });
        if (seenPlays.has(key)) return false;
        seenPlays.add(key);
        return true;
      })
      .map((i, idx) => ({ i, idx, e: this.energyOfIntent(state, i) }))
      .sort((a, b) => b.e - a.e || a.idx - b.idx)
      .map((x) => x.i);
    const hides = legal.filter((i) => i.type === 'HIDE_CARD');
    const moves = legal
      .filter((i) => i.type === 'STANDARD_MOVE')
      .map((i, idx) => ({ i, idx, v: this.moveValue(state, i) }))
      .sort((a, b) => b.v - a.v || a.idx - b.idx)
      .slice(0, MAX_MOVES)
      .map((x) => x.i);
    // Only attach gear that is not attached yet: re-shuffling free Equipment between units
    // gains nothing and would otherwise let the bot loop forever without ending its turn.
    const equips = legal
      .filter((i) => i.type === 'EQUIP' && !state.objects[i.equipmentId]?.attachedTo)
      .slice(0, MAX_EQUIP);
    const rest = legal.filter(
      (i) =>
        !isTerminal(i) &&
        i.type !== 'PLAY_CARD' &&
        i.type !== 'HIDE_CARD' &&
        i.type !== 'STANDARD_MOVE' &&
        i.type !== 'EQUIP',
    );
    const body = [...plays, ...hides, ...moves, ...equips, ...rest].slice(
      0,
      Math.max(0, this.maxCandidates - terminal.length),
    );
    return [...terminal, ...body];
  }

  private moveValue(state: GameState, i: Intent): number {
    if (i.type !== 'STANDARD_MOVE') return 0;
    let might = 0;
    for (const id of i.unitIds) {
      const def = this.cards[(state.objects[id] as { cardId: string } | undefined)?.cardId ?? ''];
      might += def?.stats.might ?? 0;
    }
    if (i.destination.kind === 'base') return -1;
    const dest = i.destination.battlefieldId;
    const bf = state.battlefields.find((b) => b.id === dest);
    const mine = bf?.controller === this.playerId;
    return might + (mine ? 0 : 10);
  }

  private search(state: GameState, legal: Intent[], start: number, seed: string): Intent {
    // Only PASS_PRIORITY / END_TURN to choose from: nothing to score (same pick as the scored path).
    if (legal.every(isTerminal)) {
      return legal.find((i) => i.type === 'PASS_PRIORITY') ?? (legal[0] as Intent);
    }
    const cands = this.candidates(state, legal);
    const rng = { r: seedRng(`${seed}/jitter`) as RngState };
    const jitter = (): number => {
      if (this.difficulty !== 'easy') return 0;
      const [v, next] = randomInt(rng.r, 1000);
      rng.r = next;
      return (v / 1000 - 0.5) * 2 * EASY_JITTER;
    };

    const scored: { intent: Intent; score: number }[] = [];
    // Nothing scored yet -> keep going until the hard deadline; afterwards also stop when the
    // costliest candidate seen so far would not fit in the time left (keeps the total within budget).
    const deadline = start + this.budgetMs;
    let expired = false;
    let worst = 0;
    for (const c of cands) {
      const t = this.now();
      if (t >= deadline || (scored.length > 0 && t + worst > deadline)) {
        expired = true;
        break;
      }
      const s = this.score(state, c, deadline);
      worst = Math.max(worst, this.now() - t);
      if (s !== null) scored.push({ intent: c, score: s + jitter() });
    }
    this.lastSearch = {
      candidates: cands.length,
      scored: scored.length,
      expired,
      fallback: scored.length === 0,
    };
    if (scored.length === 0) return this.greedy(state, legal);

    const terminals = scored.filter((x) => isTerminal(x.intent));
    const others = scored.filter((x) => !isTerminal(x.intent));
    const best = (xs: typeof scored): { intent: Intent; score: number } | undefined => {
      let b: (typeof scored)[number] | undefined;
      for (const x of xs) if (b === undefined || x.score > b.score) b = x;
      return b;
    };
    const bestOther = best(others);
    const pass = terminals.find((x) => x.intent.type === 'PASS_PRIORITY');
    const end = terminals.find((x) => x.intent.type === 'END_TURN');
    const bestTerminal = pass ?? end;
    if (!bestOther) return (bestTerminal ?? (scored[0] as { intent: Intent })).intent;
    if (!bestTerminal) {
      const t = legal.find(isTerminal);
      return t && bestOther.score <= evaluate(state, this.cards, this.playerId, this.weights) + EPS
        ? t
        : bestOther.intent;
    }
    // An easy bot sometimes just stops acting.
    if (this.difficulty === 'easy') {
      const [v, next] = randomInt(rng.r, 1000);
      rng.r = next;
      if (v < EASY_LAZY) return bestTerminal.intent;
    }
    // PASS is compared with its own outcome; END_TURN with the do-nothing baseline.
    const threshold = pass ? pass.score : evaluate(state, this.cards, this.playerId, this.weights);
    if (bestOther.score <= threshold + EPS) return bestTerminal.intent;

    // Hard: replay the rest of the turn after each of the best few actions and compare end-of-turn
    // positions. Only at the end-of-turn decision (END_TURN legal), where a combination matters.
    if (this.lookahead > 0 && end && !pass) {
      const top = [...others]
        .sort((a, b) => b.score - a.score)
        .filter((x) => x.score > threshold + EPS)
        .slice(0, this.lookahead);
      let choice: { intent: Intent; score: number } | undefined;
      for (const c of top) {
        if (this.now() >= deadline) break;
        const r = reduce(state, this.cards, c.intent);
        this.reduceCalls++;
        if (!r.ok) continue;
        const v = this.rollout(r.state, deadline);
        if (choice === undefined || v > choice.score) choice = { intent: c.intent, score: v };
      }
      if (choice !== undefined && choice.score > end.score + EPS) return choice.intent;
      return choice === undefined ? bestOther.intent : end.intent;
    }
    return bestOther.intent;
  }

  /**
   * Play the rest of my turn greedily (best 1-ply action each step, opponent just passes) and return
   * the evaluation once my turn is over (or the step / time cap hits).
   */
  private rollout(start: GameState, deadline: number): number {
    const me = this.playerId;
    let s = this.settle(start, deadline);
    for (let k = 0; k < ROLLOUT_STEPS; k++) {
      if (s.gameStatus !== 'IN_PROGRESS' || actorToAct(s) !== me || this.now() >= deadline) break;
      if (s.turn.activePlayer !== me) break;
      const legal = getLegalActions(s, this.cards, me).filter((i) => i.type !== 'CONCEDE');
      if (legal.length === 0) break;
      const pick = this.rolloutStep(s, legal, deadline);
      const r = reduce(s, this.cards, pick);
      this.reduceCalls++;
      if (!r.ok) break;
      s = this.settle(r.state, deadline);
      if (pick.type === 'END_TURN') break;
    }
    return evaluate(s, this.cards, me, this.weights);
  }

  /** The 1-ply choice used inside a rollout: few candidates, no jitter, no recursion. */
  private rolloutStep(state: GameState, legal: Intent[], deadline: number): Intent {
    if (legal.length === 1) return legal[0] as Intent;
    if (legal.every(isTerminal))
      return legal.find((i) => i.type === 'END_TURN') ?? (legal[0] as Intent);
    const end = legal.find((i) => i.type === 'END_TURN');
    const body = this.candidates(state, legal)
      .filter((i) => !isTerminal(i))
      .slice(0, ROLLOUT_CANDIDATES);
    const baseline = evaluate(state, this.cards, this.playerId, this.weights);
    let best: Intent | undefined;
    let bestScore = baseline + EPS;
    for (const c of body) {
      if (this.now() >= deadline) break;
      const v = this.score(state, c, deadline);
      if (v !== null && v > bestScore) {
        bestScore = v;
        best = c;
      }
    }
    return best ?? end ?? (legal.find(isTerminal) as Intent);
  }

  /** Cheap fallback when no candidate could be scored in time. */
  private greedy(state: GameState, legal: Intent[]): Intent {
    const plays = legal
      .filter(
        (i) =>
          i.type === 'PLAY_CARD' &&
          this.cards[(state.objects[i.cardInstanceId] as { cardId: string }).cardId]?.type ===
            'UNIT',
      )
      .sort((a, b) => this.energyOfIntent(state, b) - this.energyOfIntent(state, a));
    if (plays[0]) return plays[0];
    const move = legal.find((i) => i.type === 'STANDARD_MOVE' && this.moveValue(state, i) >= 10);
    if (move) return move;
    return legal.find(isTerminal) ?? (legal[0] as Intent);
  }
}
