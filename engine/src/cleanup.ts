/**
 * Cleanup (Core Rules 318-324, step list 323).
 *
 * A Cleanup becomes Outstanding after state changes (319) and is then run by the reducer after every
 * successful reduce. `runCleanup` repeats the ordered step list until a full pass changes nothing (322).
 * Cleanups never run while a chain item is mid-resolution: the reducer only calls runCleanup after a
 * complete reduce, i.e. between chain-item resolutions, never inside one (318).
 *
 * Steps per pass (323), in order:
 *  1. Win check (scoring.checkWin). If the game ended, stop: no later step runs.
 *  2. Attacker/Defender designations: already stored in CombatState, nothing to do.
 *  3. Kill units with lethal damage (combat.killLethalUnits).
 *  4. Neutral Open, no showdown/combat: a controlled battlefield whose controller has no units
 *     there becomes uncontrolled (323.5), BATTLEFIELD_CONTROL_CHANGED.
 *  5. Recall (323.6, 456-460; not a Move): non-unit gear/runes located at a battlefield, and
 *     permanents sitting in another player's base, go to their controller's Base. Units recalled get
 *     a UNIT_MOVED event (no event type exists for other objects). Plus facedown cards at a
 *     battlefield not controlled by the same player are trashed (323.6.a, keywords.removeOrphanedFacedown).
 *  6. Stage Showdowns for Contested battlefields where the contester has units (323.7).
 *  7. Stage Combats where both players have units (323.8). 7a. Cancel staged combats (and staged
 *     showdowns) whose conditions no longer hold (323.9).
 *  8. Remove Contested where the contester has no units and nothing is ongoing there (323.10).
 *  9. Neutral Open (no chain, showdown, combat): the turn player starts one staged Showdown (323.11),
 *     applier = contestedBy ?? turn player. A battlefield that also has a staged Combat is skipped
 *     here (Combat takes precedence, 323.13: the non-combat showdown there becomes a Combat Showdown).
 * 10. Otherwise still Neutral Open: start one staged Combat (323.12). Uses deps.startCombat
 *     (default combat.startCombatHook).
 *     Steps 9/10 with SEVERAL candidates (323.11, 323.12, 463.1): the turn player chooses. The Cleanup
 *     sets flow.pendingChoice {kind:'STAGED_ORDER', player, stage, options} and starts nothing; the next
 *     pass changes nothing so the Cleanup stabilises (no circuit breaker) and the engine waits for
 *     CHOOSE_STAGED (showdown.chooseStaged), which starts the chosen one. With exactly one candidate
 *     nothing is asked. pendingChoice is recomputed (cleared when not needed) every pass.
 * 11. If flow.combat.step === 'RESOLUTION', combat.resolveCombat (after step 3 killed the lethal units).
 *
 * Circuit breaker: at most MAX_CLEANUP_ITERATIONS passes. If the last allowed pass still changed the
 * state, the game is ABORTED (GAME_ABORTED event); the result is still ok so the host can report it.
 * A CLEANUP_ITERATION event is emitted for each pass that changed something (idle runs emit nothing, so
 * runCleanup is idempotent). flow.cleanupIterations is the pass count while running, reset to 0 when
 * the state is stable.
 *
 * Pure toward callers: `fork` (workingCopy.ts) copies the input once, or not at all inside a reduce
 * session that already owns it; events are stamped once at the end.
 */
import { fork } from './workingCopy.js';
import { syncTurnState } from './chain.js';
import { continueCombatHook, killLethalUnits, resolveCombat, startCombatHook } from './combat.js';
import { removeOrphanedFacedown } from './keywords.js';
import { checkWin, onConquer } from './scoring.js';
import { stampEvents } from './setup.js';
import {
  playersWithUnitsAt,
  stageableCombats,
  stageableContests,
  startShowdown,
  unitsAt,
} from './showdown.js';
import type { ShowdownDeps } from './showdown.js';
import { MAX_CLEANUP_ITERATIONS, playerIndex } from './types/constants.js';
import type { CardDatabase, GameEventInput, GameState, ReduceResult } from './types/index.js';

/** Production wiring of the Showdown/combat/scoring modules. */
export const defaultShowdownDeps: ShowdownDeps = {
  onConquer,
  startCombat: startCombatHook,
  continueCombat: continueCombatHook,
};

export interface CleanupDeps extends ShowdownDeps {
  /** TEST-ONLY: called on the working state at the end of every pass (simulates a runaway rule). */
  __afterPass?(state: GameState, pass: number): void;
}

/** Cheap conservative predicate: could a Cleanup change anything? (The reducer may skip when false.) */
export function needsCleanup(state: GameState): boolean {
  if (state.gameStatus !== 'IN_PROGRESS') return false;
  if (state.players.some((p) => p.points >= state.victoryScore)) return true;
  if (state.flow.combat || state.flow.showdown) return true;
  if (state.flow.stagedShowdowns.length > 0 || state.flow.stagedCombats.length > 0) return true;
  if (state.battlefields.some((b) => b.controller !== null || b.contestedBy !== null)) return true;
  if (state.battlefields.some((b) => b.facedownSlotId !== null)) return true;
  return Object.values(state.objects).some(
    (o) => o.damage > 0 || o.zone.kind === 'battlefield' || o.zone.kind === 'base',
  );
}

function snapshot(s: GameState): string {
  return JSON.stringify({ ...s, nextEventSeq: 0, flow: { ...s.flow, cleanupIterations: 0 } });
}

function isNeutralOpen(s: GameState): boolean {
  return !s.flow.showdown && !s.flow.combat && s.flow.chain.length === 0;
}

/** 323.6: Recall misplaced non-unit permanents to their controller's Base. Mutates `s`. */
function recall(s: GameState, cards: CardDatabase, out: GameEventInput[]): void {
  const ids = Object.keys(s.objects).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const id of ids) {
    const o = s.objects[id];
    if (!o) continue;
    const type = cards[o.cardId]?.type;
    const isUnit = type === 'UNIT' || type === 'TOKEN';
    let from: string;
    if (o.zone.kind === 'battlefield' && (type === 'GEAR' || type === 'RUNE')) {
      if (o.attachedTo) continue;
      from = o.zone.battlefieldId;
    } else if (o.zone.kind === 'base' && o.zone.player !== o.controller) {
      const holder = s.players[playerIndex(o.zone.player)];
      holder.base = holder.base.filter((x) => x !== id);
      from = 'base';
    } else {
      continue;
    }
    o.zone = { kind: 'base', player: o.controller };
    const base = s.players[playerIndex(o.controller)].base;
    if (!base.includes(id)) base.push(id);
    if (isUnit) out.push({ type: 'UNIT_MOVED', unitId: id, from, to: 'base' });
  }
}

/** Run the Cleanup loop (322-323). See the file header. */
export function runCleanup(
  state: GameState,
  cards: CardDatabase,
  deps: CleanupDeps = defaultShowdownDeps,
): ReduceResult {
  let s = fork(state);
  const inputs: GameEventInput[] = [];
  if (s.gameStatus !== 'IN_PROGRESS') return { ok: true, state: s, events: [] };

  /** Adopt a stamped ReduceResult as unstamped inputs (events are stamped once at the end). */
  const absorb = (r: ReduceResult): ReduceResult | null => {
    if (!r.ok) return r;
    s = fork(r.state);
    s.nextEventSeq -= r.events.length;
    for (const e of r.events) {
      const copy: Record<string, unknown> = { ...e };
      delete copy.seq;
      inputs.push(copy as GameEventInput);
    }
    return null;
  };
  const finish = (): ReduceResult => {
    s = syncTurnState(s);
    return { ok: true, state: s, events: stampEvents(s, inputs) };
  };

  // The snapshot at the end of one pass is the snapshot at the start of the next (nothing runs in
  // between), so each pass serialises the state once.
  let before = snapshot(s);
  for (let pass = 1; pass <= MAX_CLEANUP_ITERATIONS; pass++) {
    const eventsBefore = inputs.length;
    s.flow.cleanupIterations = pass;

    // 1. Win check
    const win = checkWin(s);
    s = win.state;
    inputs.push(...win.events);
    if (s.gameStatus !== 'IN_PROGRESS') {
      s.flow.cleanupIterations = 0;
      return finish();
    }

    // 2. Designations live in CombatState already.

    // 3. Lethal damage
    inputs.push(...killLethalUnits(s, cards));

    // 4. Control lost (323.5)
    if (isNeutralOpen(s)) {
      for (const bf of s.battlefields) {
        if (bf.controller !== null && unitsAt(s, bf.id, bf.controller).length === 0) {
          bf.controller = null;
          inputs.push({
            type: 'BATTLEFIELD_CONTROL_CHANGED',
            battlefieldId: bf.id,
            controller: null,
          });
        }
      }
    }

    // 5. Recall + orphaned facedown (323.6)
    recall(s, cards, inputs);
    inputs.push(...removeOrphanedFacedown(s, cards));

    // 6. Stage Showdowns (323.7)
    for (const id of stageableContests(s)) {
      if (!s.flow.stagedShowdowns.includes(id)) s.flow.stagedShowdowns.push(id);
    }

    // 7. Stage Combats (323.8) / 7a. cancel stale ones (323.9)
    const combats = stageableCombats(s);
    for (const id of combats) {
      if (!s.flow.stagedCombats.includes(id)) s.flow.stagedCombats.push(id);
    }
    s.flow.stagedCombats = s.flow.stagedCombats.filter((id) => combats.includes(id));
    const contests = stageableContests(s);
    s.flow.stagedShowdowns = s.flow.stagedShowdowns.filter((id) => contests.includes(id));

    // 8. Remove stale Contested (323.10)
    for (const bf of s.battlefields) {
      if (bf.contestedBy === null) continue;
      const here =
        bf.id === s.flow.showdown?.battlefieldId || bf.id === s.flow.combat?.battlefieldId;
      if (!here && playersWithUnitsAt(s, bf.id).indexOf(bf.contestedBy) < 0) bf.contestedBy = null;
    }

    // 9. Start a staged Showdown (323.11); 10. else a staged Combat (323.12). With several
    // candidates the turn player chooses (flow.pendingChoice): the Cleanup then idles (the next
    // pass changes nothing, so it stabilises) until CHOOSE_STAGED arrives.
    delete s.flow.pendingChoice;
    if (isNeutralOpen(s)) {
      const order = (id: string): number => s.battlefields.findIndex((b) => b.id === id);
      const sds = s.flow.stagedShowdowns
        .filter((id) => !s.flow.stagedCombats.includes(id))
        .sort((a, b) => order(a) - order(b));
      const cbs = [...s.flow.stagedCombats].sort((a, b) => order(a) - order(b));
      const sd = sds[0];
      const cb = cbs[0];
      if (sds.length > 1 || (sds.length === 0 && cbs.length > 1)) {
        s.flow.pendingChoice = {
          kind: 'STAGED_ORDER',
          player: s.turn.activePlayer,
          stage: sds.length > 1 ? 'SHOWDOWN' : 'COMBAT',
          options: sds.length > 1 ? sds : cbs,
        };
      } else if (sd !== undefined) {
        const applier = s.battlefields.find((b) => b.id === sd)?.contestedBy ?? s.turn.activePlayer;
        const err = absorb(startShowdown(s, sd, applier, false));
        if (err) return err;
      } else if (cb !== undefined) {
        const startCombat = deps.startCombat ?? startCombatHook;
        const r = startCombat(s, cards, cb);
        s = fork(r.state);
        inputs.push(...r.events);
      }
    }

    // 11. Combat Resolution (468)
    if (s.flow.combat?.step === 'RESOLUTION') {
      const err = absorb(
        resolveCombat(s, cards, deps.onConquer ? { onConquer: deps.onConquer } : {}),
      );
      if (err) return err;
    }

    deps.__afterPass?.(s, pass);

    s.flow.cleanupIterations = pass;
    const after = snapshot(s);
    if (after === before && inputs.length === eventsBefore) {
      s.flow.cleanupIterations = 0; // stable (322)
      return finish();
    }
    before = after;
    inputs.push({ type: 'CLEANUP_ITERATION', iteration: pass });
  }

  s.gameStatus = 'ABORTED';
  inputs.push({
    type: 'GAME_ABORTED',
    reason: `cleanup did not stabilise after ${MAX_CLEANUP_ITERATIONS} iterations`,
  });
  return finish();
}
