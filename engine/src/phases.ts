/**
 * Turn structure (Core Rules 315-317): Awaken, Beginning (+Scoring step), Channel, Draw, Main, Ending.
 *
 * Pure API: every function structuredClones the input and returns a ReduceResult.
 *
 * Decisions:
 * - runStartOfTurn requires phase AWAKEN (as left by the mulligan / by the end of the previous turn).
 * - Awaken readies every object controlled by the turn player in a base, battlefield or legend zone.
 * - The p1 "first Channel Phase" (487.7) is identified as turn.number === 2 with p1 active.
 * - Flow is reset (priority = turn player, focus null, empty chain, no showdown/combat) on entering
 *   Main; scoredThisTurnBy is cleared at the very start of each new turn.
 * - If the game ends (e.g. burn-out win or a hook ending it) phase processing stops where it is.
 * - Cleanup (hooks.runCleanup) runs after Beginning effects, after the Scoring step, after Channel
 *   and after Draw (319, 323): kills and control loss precede Scoring; a win is detected before
 *   Channel / Draw.
 * - Ending a turn while a Showdown/Combat exists is rejected with WRONG_PHASE; a non-empty chain
 *   gives CLOSED_STATE_REACTION_ONLY.
 * - Expiration hooks exist for "this turn" effects; the MVP has none, so Might bonuses are untouched.
 */
import { fork } from './workingCopy.js';
import { syncTurnState, nextPlayerInTurnOrder } from './chain.js';
import { drawWithBurnOut } from './burnout.js';
import { stampEvents } from './setup.js';
import {
  RUNES_PER_CHANNEL,
  SECOND_PLAYER_EXTRA_FIRST_CHANNEL,
  playerIndex,
} from './types/constants.js';
import { ruleError } from './types/errors.js';
import type {
  CardDatabase,
  CardInstance,
  EndTurnIntent,
  GameEventInput,
  GameState,
  Phase,
  ReduceResult,
  RuleError,
} from './types/index.js';

type HookResult = { state: GameState; events: GameEventInput[] };
type Hook = (state: GameState, cards: CardDatabase) => HookResult;

/** Extension points for effects implemented elsewhere. All default to no-ops. */
export interface PhaseHooks {
  /** 315.2.a start-of-Beginning effects (before the Scoring step). */
  onBeginning?(state: GameState, cards: CardDatabase): HookResult;
  /** 315.2.b Scoring step (turn.step === 'SCORING'): Hold battlefields. */
  onScoringStep?(state: GameState, cards: CardDatabase): HookResult;
  /** 316.3 start-of-Main effects (after Rune Pools are emptied). */
  onMainStart?(state: GameState, cards: CardDatabase): HookResult;
  /** 317.1 Ending step effects. */
  onEndingStep?(state: GameState, cards: CardDatabase): HookResult;
  /** 317.2 Expiration step: expire "this turn" effects (after healing, before pools empty). */
  onExpiration?(state: GameState, cards: CardDatabase): HookResult;
  /**
   * Run the Cleanup loop (318-324) on the working state, returning UNSTAMPED events. Injected (not
   * imported) to avoid a phases -> cleanup -> combat import cycle. Called inside the start-of-turn
   * sequence after Beginning effects, after the Scoring step, after Channel and after Draw, so that
   * kills / control loss happen before Scoring and a win check happens before Channel and Draw.
   */
  runCleanup?(state: GameState, cards: CardDatabase): HookResult;
}

/** Null if the game is in progress and in `phase`; otherwise GAME_OVER / WRONG_PHASE. */
export function assertPhase(state: GameState, phase: Phase): RuleError | null {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  if (state.turn.phase !== phase) {
    return ruleError('WRONG_PHASE', `expected ${phase}, in ${state.turn.phase}`);
  }
  return null;
}

interface Ctx {
  s: GameState;
  out: GameEventInput[];
  cards: CardDatabase;
  hooks: PhaseHooks;
}

const over = (c: Ctx): boolean => c.s.gameStatus !== 'IN_PROGRESS';

function runHook(c: Ctx, hook: Hook | undefined): void {
  if (!hook) return;
  const r = hook(c.s, c.cards);
  c.s = r.state;
  c.out.push(...r.events);
}

/** Outstanding Cleanup between phases (319); stops the remaining phases if it ends the game. */
function cleanup(c: Ctx): void {
  runHook(c, c.hooks.runCleanup);
}

function enterPhase(c: Ctx, phase: Phase): void {
  c.s.turn.phase = phase;
  c.s.turn.step = 'NONE';
  c.out.push({
    type: 'PHASE_CHANGED',
    player: c.s.turn.activePlayer,
    turn: c.s.turn.number,
    phase,
  });
}

function emptyPools(s: GameState): void {
  for (const p of s.players) p.runePool = { energy: 0, power: {} };
}

/** Runs from the AWAKEN phase of the current turn to the start of MAIN (stops early on game end). */
function startOfTurn(c: Ctx): void {
  const player = c.s.turn.activePlayer;
  for (const b of c.s.battlefields) b.scoredThisTurnBy = []; // new turn: score memory resets

  // 315.1 AWAKEN
  enterPhase(c, 'AWAKEN');
  for (const o of Object.values(c.s.objects)) {
    if (o.controller !== player) continue;
    const k = o.zone.kind;
    if (k === 'base' || k === 'battlefield' || k === 'legend') o.ready = true; // 416
  }

  // 315.2 BEGINNING
  enterPhase(c, 'BEGINNING');
  runHook(c, c.hooks.onBeginning);
  cleanup(c); // 319, 323: Temporary kills / control loss resolve before the Scoring step
  if (over(c)) return;
  c.s.turn.step = 'SCORING';
  runHook(c, c.hooks.onScoringStep);
  c.s.turn.step = 'NONE';
  cleanup(c); // 323.1: win check right after Holds, before Channel / Draw
  if (over(c)) return;

  // 315.3 CHANNEL
  enterPhase(c, 'CHANNEL');
  let count = RUNES_PER_CHANNEL;
  if (player === 'p1' && c.s.turn.number === 2) count += SECOND_PLAYER_EXTRA_FIRST_CHANNEL; // 487.7
  const cs = c.s.players[playerIndex(player)];
  for (let i = 0; i < count; i++) {
    const id = cs.runeDeck.shift(); // 431.3: as many as available
    if (id === undefined) break;
    const rune = c.s.objects[id] as CardInstance;
    rune.zone = { kind: 'base', player };
    rune.ready = true; // 431.2.a
    rune.enteredTurn = c.s.turn.number;
    cs.base.push(id);
    c.out.push({ type: 'RUNE_CHANNELED', player, runeId: id });
  }
  cleanup(c);
  if (over(c)) return;

  // 315.4 DRAW
  enterPhase(c, 'DRAW');
  c.out.push(...drawWithBurnOut(c.s, player, 1, c.cards));
  if (!over(c)) cleanup(c); // a Burn Out gives a point: check for the win before Main
  if (over(c)) return;

  // 316 MAIN
  enterPhase(c, 'MAIN');
  emptyPools(c.s); // 316.3
  c.s.flow = {
    priority: player,
    focus: null,
    chain: [],
    stagedShowdowns: [],
    stagedCombats: [],
    cleanupIterations: 0,
  };
  runHook(c, c.hooks.onMainStart);
}

function finish(c: Ctx): ReduceResult {
  const state = syncTurnState(c.s);
  const events = stampEvents(state, c.out);
  return { ok: true, state, events };
}

/** Run AWAKEN -> BEGINNING(+SCORING) -> CHANNEL -> DRAW -> MAIN for the active player. */
export function runStartOfTurn(
  state: GameState,
  cards: CardDatabase,
  hooks: PhaseHooks = {},
): ReduceResult {
  const err = assertPhase(state, 'AWAKEN');
  if (err) return err;
  const c: Ctx = { s: fork(state), out: [], cards, hooks };
  startOfTurn(c);
  return finish(c);
}

/** Alias for clarity: begin turn 1 after the mulligan. */
export const startGameAfterMulligan = runStartOfTurn;

/** Handle END_TURN: Ending phase, turn rotation, then the next player's start of turn. */
export function endTurn(
  state: GameState,
  cards: CardDatabase,
  intent: EndTurnIntent,
  hooks: PhaseHooks = {},
): ReduceResult {
  const err = assertPhase(state, 'MAIN');
  if (err) return err;
  if (state.turn.activePlayer !== intent.playerId) return ruleError('NOT_YOUR_TURN');
  if (state.flow.chain.length > 0) return ruleError('CLOSED_STATE_REACTION_ONLY');
  if (state.flow.showdown !== undefined || state.flow.combat !== undefined) {
    return ruleError('WRONG_PHASE', 'a Showdown or Combat is in progress');
  }

  const c: Ctx = { s: fork(state), out: [], cards, hooks };
  // 317.1 ending step
  enterPhase(c, 'ENDING');
  runHook(c, hooks.onEndingStep);
  if (over(c)) return finish(c);
  // 317.2 expiration step
  for (const o of Object.values(c.s.objects)) o.damage = 0; // 317.2.b heal
  runHook(c, hooks.onExpiration);
  emptyPools(c.s); // 317.2.e
  if (over(c)) return finish(c);
  // 317.3 next turn
  c.s.turn.activePlayer = nextPlayerInTurnOrder(c.s.turn.activePlayer);
  c.s.turn.number += 1;
  startOfTurn(c);
  return finish(c);
}
