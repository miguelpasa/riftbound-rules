/**
 * The single authoritative entry point of the rules engine: `reduce(state, cards, intent)`.
 *
 * Pure and isomorphic. The input state is never mutated; failures return a RuleError (this function
 * never throws, whatever the intent looks like) and the caller simply keeps its old state.
 *
 * Dispatch (see the README table in the task / docs):
 *  - Everything is rejected with GAME_OVER unless gameStatus is IN_PROGRESS.
 *  - MULLIGAN: applyMulligan; when the last decision completes the mulligan, the first turn's
 *    Awaken..Main phases run immediately so the game lands in MAIN of turn 1 for p0.
 *  - CHOOSE_STAGED: showdown.chooseStaged answers flow.pendingChoice; while it is set every other
 *    intent (except CONCEDE) is rejected with WRONG_PHASE.
 *  - PASS_PRIORITY: chain.passPriority, then, if a Showdown exists, showdown.showdownAfterPass.
 *  - END_TURN: phases.endTurn.  PLAY_CARD: play.playCard (or keywords.playHiddenCard for a facedown
 *    card).  STANDARD_MOVE, ASSIGN_COMBAT_DAMAGE, HIDE_CARD, EQUIP: their modules.
 *  - ACTIVATE_RUNE: a Reaction-speed mana ability that does not use the chain (164.2): allowed at any
 *    time while the game is in progress, except during the MULLIGAN phase.
 *  - ACTIVATE_ABILITY: no activated abilities in the MVP -> ABILITY_NOT_AVAILABLE.
 *  - CONCEDE (649-651): the opponent wins at once (GAME_ENDED).
 *  - After every successful non-concede reduce the Cleanup loop runs (318-324) and its events are
 *    appended. All sub-steps thread the same state, so event `seq` values are strictly increasing and
 *    the last one is `state.nextEventSeq - 1`.
 *
 * `ENGINE_HOOKS` is the one shared wiring of the hook points; AI/host code must use it instead of
 * re-assembling hooks.
 */
import { fork, runSession } from './workingCopy.js';
import { passPriority } from './chain.js';
import { fireTriggers } from './triggers.js';
import { expireTurnEffects } from './effects.js';
import { runCleanup, defaultShowdownDeps } from './cleanup.js';
import { assignCombatDamage } from './combat.js';
import {
  equip,
  hideCard,
  makePlayHooks,
  playHiddenCard,
  temporaryOnBeginning,
} from './keywords.js';
import { applyMulligan } from './mulligan.js';
import { endTurn, runStartOfTurn } from './phases.js';
import type { PhaseHooks } from './phases.js';
import { playCard, playResolver } from './play.js';
import type { PlayHooks } from './play.js';
import { activateRune } from './resources.js';
import { holdScoringStep } from './scoring.js';
import { stampEvents } from './setup.js';
import { chooseStaged, showdownAfterPass } from './showdown.js';
import type { ShowdownDeps } from './showdown.js';
import { standardMove } from './movement.js';
import { opponentOf, ruleError } from './types/index.js';
import type {
  CardDatabase,
  GameEventInput,
  GameState,
  Intent,
  PlayerId,
  ReduceResult,
} from './types/index.js';
import type { ChainResolver } from './chain.js';

/** The canonical engine wiring. Frozen so nobody can swap a hook at runtime. */
export interface EngineHooks {
  readonly phase: Readonly<PhaseHooks>;
  readonly play: PlayHooks;
  readonly resolver: ChainResolver;
  readonly showdown: ShowdownDeps;
}

/** Cleanup as a phase hook: runCleanup's stamped events converted back to unstamped inputs. */
function phaseCleanup(
  state: GameState,
  cards: CardDatabase,
): { state: GameState; events: GameEventInput[] } {
  const r = runCleanup(state, cards, defaultShowdownDeps);
  if (!r.ok) return { state, events: [] };
  const next = fork(r.state);
  next.nextEventSeq -= r.events.length; // the phase driver restamps
  const events = r.events.map((e) => {
    const copy: Record<string, unknown> = { ...e };
    delete copy.seq;
    return copy as GameEventInput;
  });
  return { state: next, events };
}

export const ENGINE_HOOKS: EngineHooks = Object.freeze({
  phase: Object.freeze<PhaseHooks>({
    onBeginning: temporaryOnBeginning,
    onEndingStep: expireTurnEffects,
    onScoringStep: holdScoringStep,
    runCleanup: phaseCleanup,
  }),
  play: makePlayHooks(),
  resolver: playResolver,
  showdown: defaultShowdownDeps,
});

// ---------------------------------------------------------------- shape validation

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isMode = (v: unknown): boolean => v === 'EXHAUST' || v === 'RECYCLE';

function isLocation(v: unknown): boolean {
  if (!isObj(v)) return false;
  return v.kind === 'base' || (v.kind === 'battlefield' && isStr(v.battlefieldId));
}

function isTarget(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (v.kind === 'object') return isStr(v.id);
  if (v.kind === 'player') return v.playerId === 'p0' || v.playerId === 'p1';
  return v.kind === 'battlefield' && isStr(v.battlefieldId);
}

function isPayment(v: unknown): boolean {
  return Array.isArray(v) && v.every((a: unknown) => isObj(a) && isStr(a.runeId) && isMode(a.mode));
}

/** Returns a description of what is wrong with the intent's payload, or null if it is well formed. */
function shapeProblem(i: Obj): string | null {
  switch (i.type) {
    case 'MULLIGAN':
      return isStrArr(i.cardIds) ? null : 'cardIds must be a string array';
    case 'PASS_PRIORITY':
    case 'END_TURN':
    case 'CONCEDE':
    case 'ACTIVATE_ABILITY':
      return null;
    case 'PLAY_CARD':
      if (!isStr(i.cardInstanceId)) return 'cardInstanceId must be a string';
      if (!isPayment(i.payment)) return 'payment must be an array of rune actions';
      if (i.location !== undefined && !isLocation(i.location)) return 'bad location';
      if (i.targets !== undefined && !(Array.isArray(i.targets) && i.targets.every(isTarget))) {
        return 'bad targets';
      }
      if (i.choices !== undefined && !isObj(i.choices)) return 'bad choices';
      if (i.additionalCosts !== undefined && !isObj(i.additionalCosts))
        return 'bad additionalCosts';
      return null;
    case 'ACTIVATE_RUNE':
      return isStr(i.runeId) && isMode(i.mode) ? null : 'runeId/mode required';
    case 'STANDARD_MOVE':
      if (!isStrArr(i.unitIds)) return 'unitIds must be a string array';
      return isLocation(i.destination) ? null : 'bad destination';
    case 'ASSIGN_COMBAT_DAMAGE':
      return Array.isArray(i.assignments) &&
        i.assignments.every(
          (a: unknown) => isObj(a) && isStr(a.unitId) && typeof a.amount === 'number',
        )
        ? null
        : 'assignments must be {unitId, amount}[]';
    case 'HIDE_CARD':
      return isStr(i.cardInstanceId) && isStr(i.battlefieldId)
        ? null
        : 'cardInstanceId/battlefieldId required';
    case 'CHOOSE_STAGED':
      return isStr(i.battlefieldId) ? null : 'battlefieldId required';
    case 'EQUIP':
      return isStr(i.equipmentId) && isStr(i.unitId) ? null : 'equipmentId/unitId required';
    default:
      return 'unknown intent type';
  }
}

// ---------------------------------------------------------------- dispatch

function dispatch(state: GameState, cards: CardDatabase, intent: Intent): ReduceResult {
  switch (intent.type) {
    case 'MULLIGAN': {
      const r = applyMulligan(state, cards, intent);
      if (!r.ok) return r;
      if (r.state.mulligan === null && r.state.turn.phase === 'AWAKEN') {
        const t = runStartOfTurn(r.state, cards, ENGINE_HOOKS.phase);
        if (!t.ok) return t;
        return { ok: true, state: t.state, events: [...r.events, ...t.events] };
      }
      return r;
    }
    case 'PASS_PRIORITY': {
      const r = passPriority(state, cards, intent, ENGINE_HOOKS.resolver);
      if (!r.ok) return r;
      if (!r.state.flow.showdown) return r;
      const s = showdownAfterPass(r.state, cards, ENGINE_HOOKS.showdown);
      if (!s.ok) return s;
      return { ok: true, state: s.state, events: [...r.events, ...s.events] };
    }
    case 'END_TURN':
      return endTurn(state, cards, intent, ENGINE_HOOKS.phase);
    case 'PLAY_CARD': {
      const obj = state.objects[intent.cardInstanceId];
      if (obj && obj.zone.kind === 'facedown') {
        return playHiddenCard(state, cards, intent, ENGINE_HOOKS.resolver, ENGINE_HOOKS.play);
      }
      return playCard(state, cards, intent, ENGINE_HOOKS.resolver, ENGINE_HOOKS.play);
    }
    case 'ACTIVATE_RUNE':
      if (state.turn.phase === 'MULLIGAN')
        return ruleError('WRONG_PHASE', 'no runes during the mulligan');
      return activateRune(state, cards, intent);
    case 'STANDARD_MOVE':
      return standardMove(state, cards, intent);
    case 'ASSIGN_COMBAT_DAMAGE':
      return assignCombatDamage(state, cards, intent);
    case 'HIDE_CARD':
      return hideCard(state, cards, intent);
    case 'EQUIP':
      return equip(state, cards, intent);
    case 'CHOOSE_STAGED':
      return chooseStaged(state, cards, intent, ENGINE_HOOKS.showdown);
    case 'ACTIVATE_ABILITY':
      return ruleError('ABILITY_NOT_AVAILABLE', 'no activated abilities in the MVP');
    case 'CONCEDE': {
      const next = fork(state);
      const winner = opponentOf(intent.playerId);
      next.gameStatus = 'FINISHED';
      next.winner = winner;
      const events = stampEvents(next, [{ type: 'GAME_ENDED', winner }]);
      return { ok: true, state: next, events };
    }
    default:
      return ruleError('UNKNOWN_INTENT');
  }
}

/**
 * Everything `reduce` does EXCEPT the trailing Cleanup: shape checks plus the handler. Exposed so
 * `getLegalActions` can test many candidates cheaply (the Cleanup loop never rejects an accepted
 * intent: it only returns an error from an internal sub-step that cannot fail on a legal state).
 * Never throws.
 */
export function applyIntent(state: GameState, cards: CardDatabase, intent: Intent): ReduceResult {
  return runSession(() => applyIntentInSession(state, cards, intent));
}

function applyIntentInSession(state: GameState, cards: CardDatabase, intent: Intent): ReduceResult {
  try {
    const raw: unknown = intent;
    if (!isObj(raw)) return ruleError('UNKNOWN_INTENT', 'intent is not an object');
    if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
    const problem = shapeProblem(raw);
    if (problem === 'unknown intent type') return ruleError('UNKNOWN_INTENT', String(raw.type));
    const pid: unknown = raw.playerId;
    if (pid !== 'p0' && pid !== 'p1') return ruleError('NOT_FOUND', `player ${String(pid)}`);
    if (problem !== null) return ruleError('UNKNOWN_INTENT', problem);
    // The Cleanup is paused on a decision (323.11/323.12): nothing else may happen until it is made.
    const pending = state.flow.pendingChoice;
    if (pending && intent.type !== 'CHOOSE_STAGED' && intent.type !== 'CONCEDE') {
      return ruleError(
        'WRONG_PHASE',
        `waiting for ${pending.player} to choose which battlefield resolves first`,
      );
    }
    return dispatch(state, cards, intent);
  } catch (e) {
    return ruleError(
      'UNKNOWN_INTENT',
      `internal error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Apply `intent` to `state`. Never throws; the input state is not mutated.
 * Success returns the new (post-Cleanup) state and every event produced, in `seq` order.
 */
export function reduce(state: GameState, cards: CardDatabase, intent: Intent): ReduceResult {
  return runSession(() => reduceInSession(state, cards, intent));
}

/**
 * One working copy per reduce (R37): the first helper that needs to change anything copies the input
 * (`fork`), every later helper in this session mutates that private copy. The input is never touched.
 */
function reduceInSession(state: GameState, cards: CardDatabase, intent: Intent): ReduceResult {
  const r = applyIntentInSession(state, cards, intent);
  if (!r.ok || intent.type === 'CONCEDE') return r;
  try {
    const c = runCleanup(r.state, cards, ENGINE_HOOKS.showdown);
    if (!c.ok) return c;
    const all = [...r.events, ...c.events];
    const t = fireTriggers(c.state, cards, all);
    return { ok: true, state: t.state, events: [...all, ...t.events] };
  } catch (e) {
    return ruleError(
      'UNKNOWN_INTENT',
      `internal error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Which player the engine is waiting for (mulligan, staged-order choice, combat damage, priority, or the turn player). */
export function actorToAct(state: GameState): PlayerId {
  if (state.mulligan && state.turn.phase === 'MULLIGAN') {
    return state.mulligan.order[state.mulligan.current] ?? 'p0';
  }
  if (state.flow.pendingChoice) return state.flow.pendingChoice.player;
  const awaiting = state.flow.combat?.awaitingAssignmentFrom;
  if (awaiting) return awaiting;
  return state.flow.priority ?? state.turn.activePlayer;
}
