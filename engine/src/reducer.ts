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
 *  - CHOOSE_TRIGGER_TARGET (R41): triggers.chooseTriggerTarget answers a TRIGGER_TARGET pendingChoice
 *    (the controller of a triggered ability picks its targets); same blocking rule as above.
 *  - PASS_PRIORITY: chain.passPriority, then, if a Showdown exists, showdown.showdownAfterPass.
 *  - END_TURN: phases.endTurn.  PLAY_CARD: play.playCard (or keywords.playHiddenCard for a facedown
 *    card).  STANDARD_MOVE, ASSIGN_COMBAT_DAMAGE, HIDE_CARD, EQUIP: their modules.
 *  - ACTIVATE_RUNE: a Reaction-speed mana ability that does not use the chain (164.2): allowed at any
 *    time while the game is in progress, except during the MULLIGAN phase.
 *  - ACTIVATE_ABILITY: abilities.activateAbility (R38); an object without that ability gives
 *    ABILITY_NOT_AVAILABLE.
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
import { chooseTriggerTarget, fireTriggers } from './triggers.js';
import { decideOptional } from './optional.js';
import { decideReplacement } from './deathOffer.js';
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
import { runTurnTriggers } from './turnTriggers.js';
import { playCard, playResolver } from './play.js';
import type { PlayHooks } from './play.js';
import { activateAbility } from './abilities.js';
import { activateRune } from './resources.js';
import { holdScoringStep } from './scoring.js';
import { stampEvents } from './setup.js';
import { tracksMighty, tracksReadiness } from './conditions.js';
import { effectiveMight } from './combat.js';
import { MIGHTY_MIGHT_COST } from './costReduction.js';
import { isUnitDef } from './tokens.js';
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

/** R72: "At the start of your Beginning Phase" abilities, then the Temporary kills. */
function beginningHook(state: GameState, cards: CardDatabase) {
  const a = runTurnTriggers(state, cards, 'TURN_START');
  const b = temporaryOnBeginning(a.state, cards);
  return { state: b.state, events: [...a.events, ...b.events] };
}

/** R72: "At the end of your turn" abilities (then a Cleanup, so lethal damage kills before healing). */
function endingHook(state: GameState, cards: CardDatabase) {
  const a = runTurnTriggers(state, cards, 'TURN_END');
  if (a.events.length === 0) return expireTurnEffects(a.state, cards);
  const c = phaseCleanup(a.state, cards);
  const b = expireTurnEffects(c.state, cards);
  return { state: b.state, events: [...a.events, ...c.events, ...b.events] };
}

export const ENGINE_HOOKS: EngineHooks = Object.freeze({
  phase: Object.freeze<PhaseHooks>({
    onBeginning: beginningHook,
    onEndingStep: endingHook,
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

/** R46: the cards chosen to pay a card-choice cost: a short list of object ids. */
function isIdList(v: unknown): boolean {
  return Array.isArray(v) && v.length <= 16 && v.every(isStr);
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
      return null;
    case 'ACTIVATE_ABILITY':
      if (!(i.costCards === undefined || isIdList(i.costCards)))
        return 'costCards must be a list of ids';
      return i.targets === undefined || (Array.isArray(i.targets) && i.targets.every(isTarget))
        ? null
        : 'bad targets';
    case 'CHOOSE_TRIGGER_TARGET':
      if (!isStr(i.chainItemId)) return 'chainItemId must be a string';
      return Array.isArray(i.targets) && i.targets.every(isTarget) ? null : 'bad targets';
    case 'DECIDE_REPLACEMENT':
      if (!isStr(i.unitId)) return 'unitId must be a string';
      if (typeof i.accept !== 'boolean') return 'accept must be a boolean';
      if (!(i.sourceId === undefined || isStr(i.sourceId))) return 'sourceId must be a string';
      if (!(i.costCards === undefined || isIdList(i.costCards)))
        return 'costCards must be a list of ids';
      return i.payment === undefined || isPayment(i.payment) ? null : 'bad payment';
    case 'DECIDE_OPTIONAL':
      if (!isStr(i.chainItemId)) return 'chainItemId must be a string';
      if (typeof i.accept !== 'boolean') return 'accept must be a boolean';
      if (!(i.costCards === undefined || isIdList(i.costCards)))
        return 'costCards must be a list of ids';
      return i.payment === undefined || isPayment(i.payment) ? null : 'bad payment';
    case 'PLAY_CARD':
      if (!isStr(i.cardInstanceId)) return 'cardInstanceId must be a string';
      if (!isPayment(i.payment)) return 'payment must be an array of rune actions';
      if (i.location !== undefined && !isLocation(i.location)) return 'bad location';
      if (i.targets !== undefined && !(Array.isArray(i.targets) && i.targets.every(isTarget))) {
        return 'bad targets';
      }
      if (i.choices !== undefined && !isObj(i.choices)) return 'bad choices';
      if (i.mode !== undefined && !(Number.isInteger(i.mode) && (i.mode as number) >= 0))
        return 'bad mode';
      if (i.additionalCosts !== undefined && !isObj(i.additionalCosts))
        return 'bad additionalCosts';
      if (!(i.costCards === undefined || isIdList(i.costCards)))
        return 'costCards must be a list of ids';
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
    case 'CHOOSE_TRIGGER_TARGET':
      return chooseTriggerTarget(state, cards, intent);
    case 'DECIDE_OPTIONAL': {
      // R45: pays and resolves the optional ability, then continues like after a PASS_PRIORITY.
      const r = decideOptional(state, cards, intent, ENGINE_HOOKS.resolver);
      if (!r.ok || !r.state.flow.showdown) return r;
      const s = showdownAfterPass(r.state, cards, ENGINE_HOOKS.showdown);
      if (!s.ok) return s;
      return { ok: true, state: s.state, events: [...r.events, ...s.events] };
    }
    case 'DECIDE_REPLACEMENT':
      return decideReplacement(state, cards, intent);
    case 'ACTIVATE_ABILITY':
      return activateAbility(state, cards, intent);
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
    const answers =
      pending?.kind === 'TRIGGER_TARGET'
        ? 'CHOOSE_TRIGGER_TARGET'
        : pending?.kind === 'OPTIONAL_EFFECT'
          ? 'DECIDE_OPTIONAL'
          : pending?.kind === 'DEATH_REPLACE'
            ? 'DECIDE_REPLACEMENT'
            : 'CHOOSE_STAGED';
    if (pending && intent.type !== answers && intent.type !== 'CONCEDE') {
      return ruleError(
        'WRONG_PHASE',
        pending.kind === 'TRIGGER_TARGET'
          ? `waiting for ${pending.player} to choose the targets of a triggered ability`
          : pending.kind === 'OPTIONAL_EFFECT'
            ? `waiting for ${pending.player} to accept or decline an optional ability`
            : pending.kind === 'DEATH_REPLACE'
              ? `waiting for ${pending.player} to decide whether to save a unit from dying`
              : `waiting for ${pending.player} to choose which battlefield resolves first`,
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
    // R78: "When I become exhausted / ready": diff the readiness of the board before and after this step.
    if (tracksReadiness(cards)) {
      const extra: GameEventInput[] = [];
      for (const o of Object.values(c.state.objects)) {
        const before = state.objects[o.id];
        if (!before || before.ready === o.ready) continue;
        const z = o.zone.kind;
        if (z !== 'base' && z !== 'battlefield') continue;
        extra.push({ type: o.ready ? 'BECAME_READY' : 'BECAME_EXHAUSTED', objectId: o.id });
      }
      if (extra.length > 0) {
        const stamped = stampEvents(c.state, extra);
        all.push(...stamped);
      }
    }
    // X9 (709): "becomes Mighty": a unit that was on the board with Might below 5 and now has 5 or more.
    if (tracksMighty(cards)) {
      const extra: GameEventInput[] = [];
      for (const o of Object.values(c.state.objects)) {
        const before = state.objects[o.id];
        if (!before || (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield')) continue;
        if (before.zone.kind !== 'base' && before.zone.kind !== 'battlefield') continue;
        if (!isUnitDef(cards[o.cardId])) continue;
        const was = effectiveMight(state, cards, o.id, { role: null });
        const now = effectiveMight(c.state, cards, o.id, { role: null });
        if (was < MIGHTY_MIGHT_COST && now >= MIGHTY_MIGHT_COST) {
          extra.push({ type: 'BECAME_MIGHTY', objectId: o.id });
        }
      }
      if (extra.length > 0) all.push(...stampEvents(c.state, extra));
    }
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
