import type { Phase, PlayerId } from './state.js';

export type PointSource = 'HOLD' | 'CONQUER' | 'BURN_OUT' | 'EFFECT';

interface EventBase {
  /** Monotonic sequence number within the game. */
  seq: number;
  /** Omit = public. Otherwise only these players may see the event. */
  visibleTo?: PlayerId[];
}

export type GameEvent = EventBase &
  (
    | { type: 'CARD_DRAWN'; player: PlayerId; cardInstanceId: string }
    | { type: 'RUNE_CHANNELED'; player: PlayerId; runeId: string }
    | { type: 'PHASE_CHANGED'; player: PlayerId; turn: number; phase: Phase }
    | { type: 'CARD_PLAYED'; player: PlayerId; cardInstanceId: string; cardId: string }
    | { type: 'CHAIN_ITEM_ADDED'; chainItemId: string; controller: PlayerId }
    | { type: 'CHAIN_ITEM_RESOLVED'; chainItemId: string }
    | { type: 'EFFECT_UNIMPLEMENTED'; cardId: string }
    | { type: 'UNIT_MOVED'; unitId: string; from: string; to: string }
    | { type: 'SHOWDOWN_STARTED'; battlefieldId: string; isCombat: boolean }
    | { type: 'COMBAT_DAMAGE_ASSIGNED'; player: PlayerId; unitId: string; amount: number }
    | { type: 'UNIT_KILLED'; unitId: string }
    | { type: 'POINT_GAINED'; player: PlayerId; amount: number; source: PointSource }
    | { type: 'FINAL_POINT_DENIED_DREW_CARD'; player: PlayerId }
    | { type: 'BURN_OUT'; player: PlayerId }
    | { type: 'BATTLEFIELD_CONTROL_CHANGED'; battlefieldId: string; controller: PlayerId | null }
    | { type: 'GAME_ENDED'; winner: PlayerId }
    | { type: 'GAME_ABORTED'; reason: string }
    | { type: 'CLEANUP_ITERATION'; iteration: number }
  );

export type GameEventType = GameEvent['type'];

/** Event payload before the reducer stamps `seq`. */
export type GameEventInput = GameEvent extends infer E
  ? E extends GameEvent
    ? Omit<E, 'seq'>
    : never
  : never;
