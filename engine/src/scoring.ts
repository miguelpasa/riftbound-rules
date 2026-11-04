/**
 * Scoring (Core Rules 470-473, 194, 323.1).
 *
 * Decisions:
 * - Scoring a battlefield (470-472) is tracked in BattlefieldState.scoredThisTurnBy; a battlefield is
 *   scored at most once per player per turn, by either method. A repeat call is a no-op (no points).
 * - 473.1: scoring gains up to ONE point. 473.1.b Final Point (Conquer only): a player at
 *   victoryScore - 1 or more who Conquers gains the point only if they have Scored EVERY battlefield
 *   this turn (including the one being scored now); otherwise they draw a card instead (not an error;
 *   FINAL_POINT_DENIED_DREW_CARD, drawWithBurnOut). The battlefield is marked scored either way.
 * - Hold is unrestricted at 7 points (docs/ASSUMPTIONS.md).
 * - Non-Conquer point sources (Burn Out, effects) are exempt from the restriction (473.1.a.1);
 *   gainPoints applies no restriction and never checks for a win.
 * - scoreBattlefield / holdScoringStep / onConquer never end the game (except via drawWithBurnOut's own
 *   432.3.c Burn Out ending). The win check (194.2) runs at Cleanup step 1 (323.1): call checkWin there.
 * - 473.2 Conquer/Hold triggers: MVP provides only the optional `onScored` hook.
 *
 * All public functions are pure: they structuredClone the input state and return the new state plus
 * unstamped event inputs. gainPoints is the exception: it mutates a working state.
 */
import { drawWithBurnOut } from './burnout.js';
import { playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  GameEventInput,
  GameState,
  PlayerId,
  PointSource,
} from './types/index.js';

export type ScoreMethod = 'CONQUER' | 'HOLD';

export interface ScoreResult {
  state: GameState;
  events: GameEventInput[];
}

/** Optional 473.2 hook, run on the working state after a battlefield is scored. */
export interface ScoringHooks {
  onScored?(
    state: GameState,
    player: PlayerId,
    battlefieldId: string,
    method: ScoreMethod,
  ): GameEventInput[];
}

/** 194.1/194.4: add points to the working state (mutates), clamped at 0. No restriction, no win check. */
export function gainPoints(
  state: GameState,
  player: PlayerId,
  amount: number,
  source: PointSource,
): GameEventInput[] {
  const ps = state.players[playerIndex(player)];
  ps.points = Math.max(0, ps.points + amount);
  return [{ type: 'POINT_GAINED', player, amount, source }];
}

/** Score one battlefield for `player` by `method` (470-473). Does not end the game. */
export function scoreBattlefield(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  battlefieldId: string,
  method: ScoreMethod,
  hooks?: ScoringHooks,
): ScoreResult {
  const next = structuredClone(state);
  const events: GameEventInput[] = [];
  const bf = next.battlefields.find((b) => b.id === battlefieldId);
  if (!bf || next.gameStatus !== 'IN_PROGRESS' || bf.scoredThisTurnBy.includes(player)) {
    return { state: next, events }; // 472: at most once per turn
  }
  bf.scoredThisTurnBy.push(player);
  const ps = next.players[playerIndex(player)];
  const atFinal = ps.points >= next.victoryScore - 1;
  if (method === 'CONQUER' && atFinal) {
    const scoredAll = next.battlefields.every((b) => b.scoredThisTurnBy.includes(player));
    if (scoredAll) {
      events.push(...gainPoints(next, player, 1, 'CONQUER')); // 473.1.b
    } else {
      events.push({ type: 'FINAL_POINT_DENIED_DREW_CARD', player }); // 473.1.b.1
      events.push(...drawWithBurnOut(next, player, 1, cards));
    }
  } else {
    events.push(...gainPoints(next, player, 1, method)); // 473.1
  }
  if (hooks?.onScored) events.push(...hooks.onScored(next, player, battlefieldId, method)); // 473.2
  return { state: next, events };
}

/** PhaseHooks.onScoringStep (315.2.b): Hold each battlefield the active player controls, in order. */
export function holdScoringStep(state: GameState, cards: CardDatabase): ScoreResult {
  let cur = structuredClone(state);
  const events: GameEventInput[] = [];
  const player = cur.turn.activePlayer;
  for (const id of cur.battlefields.map((b) => b.id)) {
    const bf = cur.battlefields.find((b) => b.id === id);
    if (!bf || bf.controller !== player || bf.scoredThisTurnBy.includes(player)) continue;
    const r = scoreBattlefield(cur, cards, player, id, 'HOLD');
    cur = r.state;
    events.push(...r.events);
  }
  return { state: cur, events };
}

/** Signature expected by ShowdownDeps.onConquer. */
export function onConquer(
  state: GameState,
  player: PlayerId,
  battlefieldId: string,
  cards: CardDatabase,
): ScoreResult {
  return scoreBattlefield(state, cards, player, battlefieldId, 'CONQUER');
}

/** 194.2/323.1: end the game if a player has >= victoryScore and more points than every other. Idempotent. */
export function checkWin(state: GameState): ScoreResult {
  const next = structuredClone(state);
  const events: GameEventInput[] = [];
  if (next.gameStatus !== 'IN_PROGRESS') return { state: next, events };
  const qualifying = next.players.filter(
    (p) =>
      p.points >= next.victoryScore &&
      next.players.every((o) => o.id === p.id || p.points > o.points),
  );
  if (qualifying.length === 0) return { state: next, events };
  const winner = qualifying.reduce((a, b) => (b.points > a.points ? b : a)).id;
  next.gameStatus = 'FINISHED';
  next.winner = winner;
  events.push({ type: 'GAME_ENDED', winner });
  return { state: next, events };
}
