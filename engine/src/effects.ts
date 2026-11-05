/**
 * Effect interpreter (R1, slice 1). Mutates the working state (caller's clone) and returns events.
 * Rule 359.3 (a spell's effects happen as it resolves, then it goes to the Trash).
 */
import { drawWithBurnOut } from './burnout.js';
import { playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  CardEffect,
  CardInstance,
  GameEventInput,
  GameState,
  PlayerId,
  Target,
} from './types/index.js';

/** The first targeted effect of a spell, if any. */
export function targetedEffect(
  effects: readonly CardEffect[] | undefined,
): Extract<CardEffect, { op: 'DAMAGE_TARGET' | 'BUFF_TARGET' }> | undefined {
  return effects?.find(
    (e): e is Extract<CardEffect, { op: 'DAMAGE_TARGET' | 'BUFF_TARGET' }> =>
      e.op === 'DAMAGE_TARGET' || e.op === 'BUFF_TARGET',
  );
}

/** Is `u` a legal target for `e` when `controller` plays the spell? */
export function isLegalEffectTarget(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  e: Extract<CardEffect, { op: 'DAMAGE_TARGET' | 'BUFF_TARGET' }>,
  u: CardInstance | undefined,
): boolean {
  if (!u || cards[u.cardId]?.type !== 'UNIT') return false;
  const onBoard = u.zone.kind === 'base' || u.zone.kind === 'battlefield';
  if (!onBoard || (e.op === 'DAMAGE_TARGET' && e.atBattlefield && u.zone.kind !== 'battlefield')) {
    return false;
  }
  const side = e.side ?? 'any';
  if (side === 'friendly') return u.controller === controller;
  if (side === 'enemy') return u.controller !== controller;
  return (void state, true);
}

export function runEffects(
  state: GameState,
  controller: PlayerId,
  effects: readonly CardEffect[],
  cards: CardDatabase,
  targets: readonly Target[] = [],
  sourceCardId = '',
): GameEventInput[] {
  const out: GameEventInput[] = [];
  for (const e of effects) {
    if (state.gameStatus !== 'IN_PROGRESS') break;
    switch (e.op) {
      case 'DRAW':
        out.push(...drawWithBurnOut(state, controller, e.amount, cards));
        break;
      case 'DAMAGE_TARGET':
      case 'BUFF_TARGET': {
        // Target must still be a unit on the board; otherwise the effect fizzles (no-op).
        const t = targets.find((x) => x.kind === 'object');
        const u = t?.kind === 'object' ? state.objects[t.id] : undefined;
        if (!isLegalEffectTarget(state, cards, controller, e, u)) {
          out.push({ type: 'EFFECT_FIZZLED', cardId: sourceCardId });
          break;
        }
        if (!u) break;
        if (e.op === 'DAMAGE_TARGET') {
          u.damage += e.amount;
          out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: e.amount });
        } else {
          u.mightBonus += e.amount;
          if (e.duration === 'TURN') u.tempMight = (u.tempMight ?? 0) + e.amount;
          out.push({ type: 'EFFECT_BUFF', unitId: u.id, amount: e.amount });
        }
        break;
      }
      case 'GAIN_POINT':
        state.players[playerIndex(controller)].points += e.amount;
        out.push({ type: 'POINT_GAINED', player: controller, amount: e.amount, source: 'EFFECT' });
        break;
    }
  }
  return out;
}

/** Ending step (317): "this turn" Might bonuses expire. */
export function expireTurnEffects(
  state: GameState,
  _cards: CardDatabase,
): { state: GameState; events: GameEventInput[] } {
  void _cards;
  const s = structuredClone(state);
  for (const o of Object.values(s.objects)) {
    if (o.tempMight) {
      o.mightBonus -= o.tempMight;
      delete o.tempMight;
    }
  }
  return { state: s, events: [] };
}
