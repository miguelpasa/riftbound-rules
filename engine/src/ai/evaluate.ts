/**
 * Static position evaluation for the bot. Higher = better for `me`. Pure; works on a (determinized)
 * GameState. Everything is a linear combination of tunable weights (DEFAULT_WEIGHTS).
 */
import { effectiveMight } from '../combat.js';
import { opponentOf } from '../types/index.js';
import type { CardDatabase, GameState, PlayerId } from '../types/index.js';

export interface EvalWeights {
  /** Per scored point. */
  point: number;
  /** Added/subtracted when the game is finished. */
  win: number;
  /** Per held battlefield. */
  battlefield: number;
  /** Per point of effective Might on the board (base or battlefield). */
  might: number;
  /** Extra Might weight for units standing on a battlefield. */
  mightAtBattlefield: number;
  /** Per card in own hand. */
  handOwn: number;
  /** Per card in the opponent's hand (applied negatively). */
  handOpp: number;
  /** Per channeled rune (capped at `runeCap`), both sides. */
  rune: number;
  runeCap: number;
  /** Per ready unit (own only). */
  readyUnit: number;
  /** Per unit, scaled by damage / health (own: penalty, opponent: bonus). */
  damagedFraction: number;
  /** Per facedown (hidden) card, both sides. */
  facedown: number;
  /** Per gear in base, both sides. */
  gear: number;
}

export const DEFAULT_WEIGHTS: Readonly<EvalWeights> = Object.freeze({
  point: 1000,
  win: 100000,
  battlefield: 50,
  might: 10,
  mightAtBattlefield: 2,
  handOwn: 5,
  handOpp: 3,
  rune: 8,
  runeCap: 12,
  readyUnit: 2,
  damagedFraction: 15,
  facedown: 7,
  gear: 4,
});

export function evaluate(
  state: GameState,
  cards: CardDatabase,
  me: PlayerId,
  w: Readonly<EvalWeights> = DEFAULT_WEIGHTS,
): number {
  const opp = opponentOf(me);
  if (state.gameStatus === 'FINISHED') {
    if (state.winner === me) return w.win;
    if (state.winner === opp) return -w.win;
    return 0;
  }
  const side = (p: PlayerId): number => (p === me ? 1 : -1);
  let score = 0;

  for (const ps of state.players) {
    score += side(ps.id) * ps.points * w.point;
    score += ps.id === me ? ps.hand.length * w.handOwn : -ps.hand.length * w.handOpp;
  }
  for (const bf of state.battlefields) {
    if (bf.controller !== null) score += side(bf.controller) * w.battlefield;
  }
  const runes: Record<PlayerId, number> = { p0: 0, p1: 0 };
  for (const o of Object.values(state.objects)) {
    const def = cards[o.cardId];
    if (!def) continue;
    const owner = o.controller;
    if (o.zone.kind === 'facedown') {
      score += side(owner) * w.facedown;
      continue;
    }
    if (o.zone.kind === 'base' && def.type === 'RUNE') {
      runes[owner] += 1;
      continue;
    }
    if (o.zone.kind === 'base' && def.type === 'GEAR') {
      score += side(owner) * w.gear;
      continue;
    }
    if (def.type !== 'UNIT' && !(def.type === 'TOKEN' && def.stats.might !== undefined)) continue;
    if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
    const might = effectiveMight(state, cards, o.id, { role: null });
    const perMight = w.might + (o.zone.kind === 'battlefield' ? w.mightAtBattlefield : 0);
    score += side(owner) * Math.max(0, might) * perMight;
    const health = Math.max(1, might);
    score -= side(owner) * Math.min(1, o.damage / health) * w.damagedFraction;
    if (owner === me && o.ready) score += w.readyUnit;
  }
  for (const pid of ['p0', 'p1'] as const) {
    score += side(pid) * Math.min(w.runeCap, runes[pid]) * w.rune;
  }
  return score;
}
