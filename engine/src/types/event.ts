import type { Target } from './chain.js';
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
    | {
        type: 'CARD_PLAYED';
        player: PlayerId;
        cardInstanceId: string;
        cardId: string;
        /** R58: the optional additional cost was paid (public, as the payment is). */
        paidExtra?: boolean;
        /** R100: the card was played from face down (a Hidden card revealed). */
        fromFacedown?: boolean;
        /** The card was played from somewhere other than its owner's hand (the Trash, banishment, ...). */
        fromElsewhere?: boolean;
      }
    | { type: 'CARD_HIDDEN'; player: PlayerId; battlefieldId: string }
    | { type: 'FACEDOWN_REMOVED'; battlefieldId: string; cardId: string }
    | { type: 'EQUIPPED'; equipmentId: string; unitId: string }
    | { type: 'CHAIN_ITEM_ADDED'; chainItemId: string; controller: PlayerId }
    | { type: 'CHAIN_ITEM_RESOLVED'; chainItemId: string }
    | { type: 'EFFECT_UNIMPLEMENTED'; cardId: string }
    | { type: 'EFFECT_DAMAGE'; unitId: string; amount: number }
    | { type: 'EFFECT_BUFF'; unitId: string; amount: number }
    | { type: 'EFFECT_READIED'; unitId: string }
    | { type: 'EFFECT_EMPOWERED'; unitId: string }
    | { type: 'XP_GAINED'; player: PlayerId; amount: number }
    | { type: 'XP_SPENT'; player: PlayerId; amount: number }
    | { type: 'EFFECT_FIZZLED'; cardId: string }
    | { type: 'EFFECT_STUNNED'; unitId: string; by?: PlayerId }
    | { type: 'HAND_DISCARDED'; player: PlayerId; cardIds: string[]; cardNames: string[] }
    | { type: 'DAMAGE_PREVENTED'; unitId: string; amount: number }
    | { type: 'UNIT_DEATH_REPLACED'; unitId: string; cardId: string; mode: 'RECALL' | 'BANISH' }
    | { type: 'EFFECT_KEYWORD_GRANTED'; unitId: string }
    | { type: 'EFFECT_COUNTERED'; cardId: string }
    | { type: 'GEAR_KILLED'; gearId: string }
    | { type: 'UNIT_MOVED'; unitId: string; from: string; to: string }
    | { type: 'SHOWDOWN_STARTED'; battlefieldId: string; isCombat: boolean }
    | {
        type: 'STAGED_ORDER_CHOSEN';
        player: PlayerId;
        battlefieldId: string;
        stage: 'SHOWDOWN' | 'COMBAT';
      }
    | { type: 'COMBAT_DAMAGE_ASSIGNED'; player: PlayerId; unitId: string; amount: number }
    | {
        type: 'UNIT_KILLED';
        unitId: string;
        /** R71: who controlled it, where it stood ('base' or a battlefield id) and whether it was the only friendly unit there. */
        controller?: PlayerId;
        cardId?: string;
        at?: string;
        alone?: boolean;
        /** It was stunned when it died. */
        stunned?: boolean;
        /** It had 5+ Might as it died (709): "if I was Mighty". */
        mighty?: boolean;
        /** It carried a buff when it died ("a buffed friendly unit dies"). */
        buffed?: boolean;
        /** It died while a combat was being fought at its location ("When I die in combat"). */
        inCombat?: boolean;
      }
    /** R78: a permanent became exhausted / ready during this step (emitted only when a card reacts to it). */
    | { type: 'BECAME_EXHAUSTED'; objectId: string }
    | { type: 'BECAME_READY'; objectId: string }
    /** X9 (709): a unit's Might went from below 5 to 5 or more. */
    | { type: 'BECAME_MIGHTY'; objectId: string }
    /** "When my Might becomes N or more": a unit's Might went from below `n` to `n` or more (emitted only when a card asks). */
    | { type: 'BECAME_MIGHT_AT'; objectId: string; n: number }
    /** A card went to its owner's banishment (a token ceasing to exist is not a card). */
    | { type: 'CARD_BANISHED'; player: PlayerId; cardInstanceId: string; cardId: string }
    /** A spell or ability on the Chain now has this unit among its chosen targets (emitted only when a card reacts to it). */
    | { type: 'UNIT_BUFFED'; objectId: string }
    | { type: 'UNIT_CHOSEN'; objectId: string; chooser: PlayerId; spell: boolean }
    /** R71: a combat ended; `participants` are the units still standing at the battlefield (both sides). */
    | {
        type: 'COMBAT_ENDED';
        battlefieldId: string;
        winner: PlayerId | null;
        participants: string[];
      }
    | { type: 'POINT_GAINED'; player: PlayerId; amount: number; source: PointSource }
    | {
        type: 'BATTLEFIELD_SCORED';
        player: PlayerId;
        battlefieldId: string;
        method: 'HOLD' | 'CONQUER';
      }
    | { type: 'FINAL_POINT_DENIED_DREW_CARD'; player: PlayerId }
    | { type: 'BURN_OUT'; player: PlayerId }
    | {
        type: 'BATTLEFIELD_CONTROL_CHANGED';
        battlefieldId: string;
        controller: PlayerId | null;
        /** The battlefield had no controller before ('a battlefield that was uncontrolled'). */
        fromNeutral?: true;
      }
    | { type: 'GAME_ENDED'; winner: PlayerId }
    | { type: 'GAME_ABORTED'; reason: string }
    | { type: 'CLEANUP_ITERATION'; iteration: number }
    | { type: 'TOKEN_PLAYED'; player: PlayerId; unitId: string; cardId: string }
    | { type: 'UNIT_RETURNED'; player: PlayerId; unitId: string; cardId: string }
    | { type: 'CARDS_LOOKED_AT'; player: PlayerId; count: number }
    | { type: 'CARDS_RECYCLED'; player: PlayerId; count: number }
    /** R44: [Burn N] / "put the top N cards of your Main Deck into your trash": `count` cards were milled. */
    | { type: 'CARDS_BURNED'; player: PlayerId; count: number }
    | { type: 'CARD_REVEALED'; player: PlayerId; cardInstanceId: string; cardId: string }
    | { type: 'ABILITY_ACTIVATED'; player: PlayerId; sourceId: string; abilityIndex: number }
    | { type: 'RESOURCES_ADDED'; player: PlayerId; energy: number; power: number }
    /** R41: targets of a triggered ability were chosen (by the controller or automatically). `sourceId` is an object id, or a battlefield id for a Battlefield card's ability (R44). */
    | { type: 'TRIGGER_TARGETED'; player: PlayerId; sourceId: string; targets: Target[] }
    /** R41: a triggered ability had no legal target and was not put on the Chain. */
    | { type: 'TRIGGER_NO_TARGET'; player: PlayerId; sourceId: string }
    /** R45: an optional ("you may [pay] ...") triggered ability was accepted or declined (declined automatically when it could not be paid). */
    | { type: 'OPTIONAL_EFFECT_DECIDED'; player: PlayerId; sourceId: string; accepted: boolean }
    /**
     * R46: cards were paid as (part of) a cost: discarded, killed, exhausted, returned or recycled.
     * `cardIds` are object ids; a discarded / recycled card is public from then on (Trash), so the
     * event reveals nothing the board does not.
     */
    | {
        type: 'COST_CARDS_PAID';
        player: PlayerId;
        sourceId: string;
        kind: 'DISCARD' | 'KILL' | 'EXHAUST' | 'RETURN' | 'RECYCLE' | 'BANISH' | 'SPEND_BUFF' | 'REVEAL';
        cardIds: string[];
        cardNames: string[];
      }
  );

export type GameEventType = GameEvent['type'];

/** Event payload before the reducer stamps `seq`. */
export type GameEventInput = GameEvent extends infer E
  ? E extends GameEvent
    ? Omit<E, 'seq'>
    : never
  : never;
