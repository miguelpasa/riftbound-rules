/**
 * Showdowns (Core Rules 341-348, 462-463) and battlefield control helpers.
 *
 * Pure: exported state-returning functions structuredClone first. `establishControl` is the one
 * exception: it mutates a WORKING state (documented) so combat resolution (468.5) can reuse it.
 *
 * Decisions:
 *  - startShowdown: attacker = applier, defender = opponent (combat only). Applier gets Focus and
 *    Priority (345). The battlefield is removed from the staged lists.
 *  - showdownAfterPass: closes the Showdown when the chain is empty and passesInRow >= 2 (347.2.a).
 *  - closeShowdown clears flow.showdown first, then:
 *      non-combat (348.2): one player's units -> establish control (Conquer hook if that player has
 *      not scored the battlefield this turn); nobody -> clear Contested; both -> deps.startCombat.
 *      combat (348.1): deps.continueCombat. If no flow.combat remains, Neutral Open is restored
 *      with Priority to the turn player (335); otherwise the hook owns Focus/Priority.
 *  - A Conquer leaves scoredThisTurnBy to the injected onConquer (scoring, E8).
 *  - stageableContests/stageableCombats return [] while flow.combat is set (CombatState carries no
 *    battlefield id) and skip the battlefield of an ongoing Showdown.
 */
import { fork } from './workingCopy.js';
import { syncTurnState } from './chain.js';
import { stampEvents } from './setup.js';
import { PLAYER_IDS } from './types/constants.js';
import { ruleError } from './types/errors.js';
import { opponentOf } from './types/index.js';
import type {
  CardDatabase,
  ChooseStagedIntent,
  CardInstance,
  GameEventInput,
  GameState,
  PlayerId,
  ReduceResult,
} from './types/index.js';

export interface ShowdownHookResult {
  state: GameState;
  events: GameEventInput[];
}

/** Injected behaviour (E7 combat, E8 scoring, E11). All optional; defaults are no-ops. */
export interface ShowdownDeps {
  /** A player conquered `bfId` (473.1): award points. */
  onConquer?(
    state: GameState,
    player: PlayerId,
    bfId: string,
    cards: CardDatabase,
  ): ShowdownHookResult;
  /** Both players have units at `bfId` after a non-combat Showdown: begin combat. */
  startCombat?(state: GameState, cards: CardDatabase, bfId: string): ShowdownHookResult;
  /** A combat Showdown closed: proceed to damage. */
  continueCombat?(state: GameState, cards: CardDatabase): ShowdownHookResult;
}

// ---------------------------------------------------------------- helpers

/** Units (objects in a 'battlefield' zone) at `bfId`, optionally controlled by `player`. */
export function unitsAt(state: GameState, bfId: string, player?: PlayerId): CardInstance[] {
  return Object.values(state.objects)
    .filter(
      (o) =>
        o.zone.kind === 'battlefield' &&
        o.zone.battlefieldId === bfId &&
        (player === undefined || o.controller === player),
    )
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** Players that control at least one unit at `bfId`, in seat order. */
export function playersWithUnitsAt(state: GameState, bfId: string): PlayerId[] {
  return PLAYER_IDS.filter((p) => unitsAt(state, bfId, p).length > 0);
}

/**
 * Establish control (190, 468.5). MUTATES the working state. Clears Contested; returns the control
 * event, or nothing if `player` already controls the battlefield.
 */
export function establishControl(
  state: GameState,
  bfId: string,
  player: PlayerId,
): GameEventInput[] {
  const bf = state.battlefields.find((b) => b.id === bfId);
  if (!bf) return [];
  bf.contestedBy = null; // 190.3.b
  if (bf.controller === player) return [];
  const fromNeutral = bf.controller === null;
  bf.controller = player;
  return [
    {
      type: 'BATTLEFIELD_CONTROL_CHANGED',
      battlefieldId: bfId,
      controller: player,
      ...(fromNeutral ? { fromNeutral: true as const } : {}),
    },
  ];
}

/** Contested battlefields where the contester has units present (cleanup loop, 323.7). */
export function stageableContests(state: GameState): string[] {
  if (state.flow.combat) return [];
  const busy = state.flow.showdown?.battlefieldId;
  return state.battlefields
    .filter(
      (b) =>
        b.id !== busy && b.contestedBy !== null && unitsAt(state, b.id, b.contestedBy).length > 0,
    )
    .map((b) => b.id);
}

/** Battlefields where both players have units (cleanup loop, 323.8). */
export function stageableCombats(state: GameState): string[] {
  if (state.flow.combat) return [];
  const busy = state.flow.showdown?.battlefieldId;
  return state.battlefields
    .filter((b) => b.id !== busy && playersWithUnitsAt(state, b.id).length === 2)
    .map((b) => b.id);
}

// ---------------------------------------------------------------- start / pass / close

/** Begin a Showdown at `bfId`; `applier` (who applied Contested) gets Focus and Priority (345). */
export function startShowdown(
  state: GameState,
  bfId: string,
  applier: PlayerId,
  isCombat: boolean,
): ReduceResult {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  if (!state.battlefields.some((b) => b.id === bfId)) {
    return ruleError('NOT_FOUND', `battlefield ${bfId}`);
  }
  if (state.flow.showdown) return ruleError('WRONG_PHASE', 'a Showdown is already in progress');
  const next = fork(state);
  next.flow.showdown = {
    battlefieldId: bfId,
    isCombat,
    passesInRow: 0,
    ...(isCombat ? { attacker: applier, defender: opponentOf(applier) } : {}),
  };
  next.flow.stagedShowdowns = next.flow.stagedShowdowns.filter((b) => b !== bfId);
  next.flow.stagedCombats = next.flow.stagedCombats.filter((b) => b !== bfId);
  next.flow.focus = applier;
  next.flow.priority = applier;
  const synced = syncTurnState(next);
  return {
    ok: true,
    state: synced,
    events: stampEvents(synced, [{ type: 'SHOWDOWN_STARTED', battlefieldId: bfId, isCombat }]),
  };
}

/** Call after chain.passPriority: closes the Showdown once everyone passed on an empty chain. */
export function showdownAfterPass(
  state: GameState,
  cards: CardDatabase,
  deps: ShowdownDeps = {},
): ReduceResult {
  const sd = state.flow.showdown;
  if (!sd || state.flow.chain.length > 0 || sd.passesInRow < PLAYER_IDS.length) {
    return { ok: true, state, events: [] };
  }
  return closeShowdown(state, cards, deps);
}

function restoreNeutral(s: GameState): void {
  s.flow.focus = null;
  s.flow.priority = s.turn.activePlayer; // 335
}

/** Close the current Showdown (348). */
export function closeShowdown(
  state: GameState,
  cards: CardDatabase,
  deps: ShowdownDeps = {},
): ReduceResult {
  const sd = state.flow.showdown;
  if (!sd) return ruleError('NOT_FOUND', 'no Showdown in progress');
  let s = fork(state);
  const bfId = sd.battlefieldId;
  const inputs: GameEventInput[] = [];
  delete s.flow.showdown;
  s.flow.focus = null;

  const run = (r: ShowdownHookResult): void => {
    s = fork(r.state);
    inputs.push(...r.events);
  };

  if (sd.isCombat) {
    if (deps.continueCombat) run(deps.continueCombat(s, cards)); // 348.1
  } else {
    const present = playersWithUnitsAt(s, bfId);
    const bf = s.battlefields.find((b) => b.id === bfId);
    if (bf && present.length === 0) {
      bf.contestedBy = null;
    } else if (bf && present.length === 1) {
      const player = present[0] as PlayerId;
      const conquer = bf.controller !== player && !bf.scoredThisTurnBy.includes(player); // 348.2.a.1
      inputs.push(...establishControl(s, bfId, player));
      if (conquer && deps.onConquer) run(deps.onConquer(s, player, bfId, cards));
    } else if (bf && present.length === 2 && deps.startCombat) {
      restoreNeutral(s);
      s = syncTurnState(s);
      run(deps.startCombat(s, cards, bfId));
    }
  }

  if (!s.flow.showdown && !s.flow.combat && s.gameStatus === 'IN_PROGRESS') restoreNeutral(s);
  s = syncTurnState(s);
  return { ok: true, state: s, events: stampEvents(s, inputs) };
}

// ---------------------------------------------------------------- staged order choice

/**
 * CHOOSE_STAGED (323.11, 323.12, 463.1): the turn player picks which staged battlefield's Showdown
 * (or Combat) begins first. Answers flow.pendingChoice, which the Cleanup set and paused on; the
 * chosen one starts right away and the trailing Cleanup continues (and may ask again for the rest).
 */
export function chooseStaged(
  state: GameState,
  cards: CardDatabase,
  intent: ChooseStagedIntent,
  deps: ShowdownDeps = {},
): ReduceResult {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  const pc = state.flow.pendingChoice;
  if (pc?.kind !== 'STAGED_ORDER') {
    return ruleError('WRONG_PHASE', 'no staged Showdown/Combat order to choose');
  }
  if (pc.player !== intent.playerId) {
    return ruleError('NOT_YOUR_TURN', `${pc.player} chooses which battlefield resolves first`);
  }
  if (!pc.options.includes(intent.battlefieldId)) {
    return ruleError('ILLEGAL_TARGET', `${intent.battlefieldId} is not one of the staged options`);
  }
  const bfId = intent.battlefieldId;
  let s = fork(state);
  delete s.flow.pendingChoice;
  const chosen = stampEvents(s, [
    { type: 'STAGED_ORDER_CHOSEN', player: pc.player, battlefieldId: bfId, stage: pc.stage },
  ]);
  if (pc.stage === 'SHOWDOWN') {
    const applier = s.battlefields.find((b) => b.id === bfId)?.contestedBy ?? s.turn.activePlayer;
    const r = startShowdown(s, bfId, applier, false);
    if (!r.ok) return r;
    return { ok: true, state: r.state, events: [...chosen, ...r.events] };
  }
  if (!deps.startCombat) return ruleError('WRONG_PHASE', 'combat is not wired');
  const r = deps.startCombat(s, cards, bfId);
  s = fork(r.state);
  return { ok: true, state: s, events: [...chosen, ...stampEvents(s, r.events)] };
}
