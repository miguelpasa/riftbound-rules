/**
 * Effect interpreter (R1, slice 1). Mutates the working state (caller's clone) and returns events.
 * Rule 359.3 (a spell's effects happen as it resolves, then it goes to the Trash).
 */
import { drawWithBurnOut } from './burnout.js';
import { effectiveMight } from './combat.js';
import { playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  CardEffect,
  CardInstance,
  GameEventInput,
  GameState,
  PlayerId,
  Target,
  TargetedEffect,
} from './types/index.js';

/** The first targeted effect of a spell, if any. */
export function targetedEffect(
  effects: readonly CardEffect[] | undefined,
): TargetedEffect | undefined {
  return effects?.find(
    (e): e is TargetedEffect =>
      e.op === 'DAMAGE_TARGET' ||
      e.op === 'BUFF_TARGET' ||
      e.op === 'KILL_TARGET' ||
      e.op === 'READY_TARGET',
  );
}

/** Is `u` a legal target for `e` when `controller` plays the spell? */
export function isLegalEffectTarget(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  e: TargetedEffect,
  u: CardInstance | undefined,
): boolean {
  if (!u || cards[u.cardId]?.type !== 'UNIT') return false;
  const onBoard = u.zone.kind === 'base' || u.zone.kind === 'battlefield';
  if (
    !onBoard ||
    ((e.op === 'DAMAGE_TARGET' || e.op === 'KILL_TARGET') &&
      e.atBattlefield &&
      u.zone.kind !== 'battlefield')
  ) {
    return false;
  }
  if (
    e.op === 'KILL_TARGET' &&
    e.maxMight !== undefined &&
    effectiveMight(state, cards, u.id, { role: null }) > e.maxMight
  ) {
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
      case 'BUFF_TARGET':
      case 'KILL_TARGET':
      case 'READY_TARGET': {
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
        } else if (e.op === 'KILL_TARGET') {
          // Lethal damage: Cleanup (323) then moves it to the Trash.
          const lethal = Math.max(1, effectiveMight(state, cards, u.id, { role: null })) - u.damage;
          if (lethal > 0) u.damage += lethal;
          out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: Math.max(lethal, 0) });
        } else if (e.op === 'READY_TARGET') {
          u.ready = true;
          out.push({ type: 'EFFECT_READIED', unitId: u.id });
        } else {
          u.mightBonus += e.amount;
          if (e.duration === 'TURN') u.tempMight = (u.tempMight ?? 0) + e.amount;
          out.push({ type: 'EFFECT_BUFF', unitId: u.id, amount: e.amount });
        }
        break;
      }
      case 'BUFF_ALL': {
        const units = Object.values(state.objects)
          .filter(
            (o) =>
              (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
              cards[o.cardId]?.type === 'UNIT' &&
              (e.side === 'any' ||
                (e.side === 'friendly'
                  ? o.controller === controller
                  : o.controller !== controller)),
          )
          .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
        for (const u of units) {
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
