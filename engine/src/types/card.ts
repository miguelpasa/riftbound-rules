/** Static card definitions (data, not game objects). */

export type Domain = 'Fury' | 'Calm' | 'Mind' | 'Body' | 'Chaos' | 'Order';
export const DOMAINS: readonly Domain[] = ['Fury', 'Calm', 'Mind', 'Body', 'Chaos', 'Order'];

export type CardType = 'UNIT' | 'SPELL' | 'GEAR' | 'LEGEND' | 'RUNE' | 'BATTLEFIELD' | 'TOKEN';

/** Keywords implemented in the MVP. */
export type MvpKeywordName =
  | 'Action'
  | 'Reaction'
  | 'Tank'
  | 'Backline'
  | 'Assault'
  | 'Shield'
  | 'Ganking'
  | 'Accelerate'
  | 'Temporary'
  | 'Hidden'
  | 'Deflect'
  | 'Unique'
  | 'Equip'
  | 'QuickDraw'
  | 'Legion'
  | 'Ambush';

/** Keywords typed but deferred (not implemented; cards using them are 'partial'). */
export type DeferredKeywordName =
  | 'Deathknell'
  | 'Level'
  | 'Hunt'
  | 'Flow'
  | 'Repeat'
  | 'Predict'
  | 'ShowOff'
  | 'Weaponmaster'
  | 'Empower'
  | 'Deploy'
  | 'Vision'
  | 'Disarm';

export type KeywordName = MvpKeywordName | DeferredKeywordName;

/** Keywords the engine implements. */
export const MVP_KEYWORDS: readonly MvpKeywordName[] = [
  'Action',
  'Reaction',
  'Tank',
  'Backline',
  'Assault',
  'Shield',
  'Ganking',
  'Accelerate',
  'Temporary',
  'Hidden',
  'Deflect',
  'Unique',
  'Equip',
  'QuickDraw',
  'Legion',
  'Ambush',
];

/** Keywords that are typed but not yet implemented. */
export const DEFERRED_KEYWORDS: readonly DeferredKeywordName[] = [
  'Deathknell',
  'Level',
  'Hunt',
  'Flow',
  'Repeat',
  'Predict',
  'ShowOff',
  'Weaponmaster',
  'Empower',
  'Deploy',
  'Vision',
  'Disarm',
];

export interface KeywordInstance {
  name: KeywordName;
  /** Numeric parameter, e.g. Assault 2, Shield 1. */
  value?: number;
}

export interface CardCost {
  /** Energy cost. */
  energy: number;
  /** Total generic Power cost, if any. */
  power?: number;
  /** Domain-specific Power requirement (PRD-compatible). */
  domain?: { element: Domain; amount: number }[];
}

export interface CardStats {
  might?: number;
  health?: number;
}

/**
 * Executable card effects (R1). A spell with `effects` resolves them in order; `supportLevel`
 * 'partial' + `effects` means the listed effects run and no "unimplemented" badge is shown.
 * Slice 1 is target-free: more ops (damage, buff, kill, move, ...) extend this union.
 */
/**
 * R81: "..., if <condition>, <stronger effect> instead" on a targeted damage / Might effect. The alternative
 * replaces the amount when it holds: `when` is a controller / source condition (Level, facedown card, source
 * Empowered); `target` is a state of the chosen unit. `temp` turns a [Buff] into a plain "+N this turn".
 */
export interface AltAmount {
  amount: number;
  when?: Condition;
  target?: 'EMPOWERED' | 'ATTACKING' | 'BUFFED';
  temp?: boolean;
}

/** Whose unit may be targeted, relative to the spell's controller (default 'any'). */
export type TargetSide = 'friendly' | 'enemy' | 'any';

/**
 * Target slots: a spell's chosen objects are `PLAY_CARD.targets` filtered to kind 'object', and a
 * targeted effect reads `slot` (default 0) from that list. An effect with `count` is the spell's
 * only targeted effect and takes ALL its object targets (min..max, all distinct): "each of up to
 * two units".
 */
export interface TargetCount {
  min: number;
  max: number;
}

/**
 * Scoping of a chosen unit relative to the ability's source (R42), for triggered and activated
 * abilities: `here` = at the same battlefield as the source ("an enemy unit here"), `another` = not
 * the source itself ("another friendly unit").
 */
export interface TargetScope {
  here?: boolean;
  another?: boolean;
}

/** R96: which card a Look-at-the-top effect may take (the first match from the top is taken). */
export interface LookTake {
  filter?: 'unit' | 'gear' | 'spell' | 'unitOrGear';
  reveal?: boolean;
  maxEnergy?: number;
  minEnergy?: number;
  maxPower?: number;
}

export type CardEffect =
  /** `perOtherBattlefield`: draw `amount` for each OTHER battlefield the controller controls (R44). */
  | {
      op: 'DRAW';
      amount: number;
      perOtherBattlefield?: boolean;
      /** R97: every player draws ("You and that player each draw 1", "Each player draws 1"). */
      eachPlayer?: boolean;
      /** R65: per battlefield the controller controls / per friendly [Mighty] unit (Might 5+). */
      per?: 'BATTLEFIELD' | 'MIGHTY_UNIT';
    }
  /**
   * R83: "Opponents can't play cards this turn" (OPPONENTS) / "Its controller can't play spells this turn"
   * (TARGET_CONTROLLER: the controller of the spell countered in `slot`).
   */
  /** R105: "the next spell you play this turn costs [N] less". */
  | { op: 'NEXT_PLAY_DISCOUNT'; amount: number; spellsOnly: boolean }
  /** R105: "Friendly units enter ready this turn" / "Units you play this turn enter ready". */
  | { op: 'ENTER_READY_THIS_TURN' }
  /** "The next unit you play this turn enters ready" (Sun Disc): consumed by the next unit card played. */
  | { op: 'ENTER_READY_NEXT' }
  | {
      op: 'LOCK_PLAYS';
      who: 'OPPONENTS' | 'TARGET_CONTROLLER';
      what: 'CARDS' | 'SPELLS';
      slot?: number;
    }
  /** R82: every unit with at most `maxMight` Might returns to its owner's hand (tokens cease to exist). */
  | { op: 'RETURN_ALL_UNITS'; maxMight: number }
  /** R65: every unit and gear on the board returns to its owner's hand ("Downwell"). */
  | { op: 'RETURN_ALL_BOARD' }
  /** R44: put the top `amount` cards of the controller's Main Deck into their Trash ([Burn N]). */
  | { op: 'BURN'; amount: number }
  /** R44: the controller wins the game. */
  | { op: 'WIN_GAME' }
  /** R45: "give me +N [M] this turn" (the source unit; nothing if it left the board). */
  | { op: 'BUFF_SELF'; amount: number; /** R54: [Buff] me. */ buff?: boolean }
  /**
   * R55: Predict N / Vision: look at the top N cards of the Main Deck, recycle those that cost too much
   * and put the rest back in order. A deterministic policy until choices exist (see ASSUMPTIONS R55).
   */
  | { op: 'PREDICT'; count: number }
  /** R53: "gain N XP" (optionally per friendly unit on the board). */
  | { op: 'GAIN_XP'; amount: number; perFriendlyUnit?: boolean }
  /** R62: "return me / this to its owner's hand": the source permanent returns to hand (tokens cease to exist). */
  | { op: 'RETURN_SELF' }
  /** R72: ready up to `count` of the controller's exhausted runes (lowest object id first). */
  | { op: 'READY_RUNES'; count: number }
  /** R72: recycle every rune the controller has in play (they go to the bottom of the Rune Deck, ready). */
  | { op: 'RECYCLE_RUNES' }
  /** R72: put `count` cards from the controller's Trash (oldest first) on the bottom of their Main Deck. */
  | { op: 'RECYCLE_TRASH'; count: number }
  /** R52: "Empower me": the source becomes Empowered (nothing if it is not on the board or already is). */
  | { op: 'EMPOWER_SELF' }
  /** R49: "ready me": the source permanent becomes ready (nothing when it left the board). */
  | { op: 'READY_SELF' }
  /** R45: "ready your legend". */
  | { op: 'READY_LEGEND' }
  | { op: 'GAIN_POINT'; amount: number; forOpponent?: boolean }
  /** Deal damage to the target unit(s); Cleanup kills a unit if lethal. */
  | ({
      op: 'DAMAGE_TARGET';
      amount: number;
      /** X1 (559.3.d): the damage is split among all the chosen units (each gets at least 1; the split is made on resolution). */
      split?: boolean;
      /** X1: all chosen units must be at the same battlefield ("units at a single battlefield"). */
      sameBattlefield?: boolean;
      /** R74: "damage equal to my Might / [Assault] / [Shield]": read from the source when the effect runs (amount is 0). */
      amountFrom?: 'MY_MIGHT' | 'MY_ASSAULT' | 'MY_SHIELD' | 'EXCESS' | 'SLOT_MIGHT';
      /** R94: with `amountFrom: 'SLOT_MIGHT'`: the chosen unit (target slot) whose Might is dealt ("It deals damage equal to its Might"). */
      amountSlot?: number;
      amountSlotSide?: TargetSide;
      /** R81: "... instead" when a condition holds. */
      alt?: AltAmount;
      side?: TargetSide;
      atBattlefield?: boolean;
      /** R84: "a unit in a base" (either player's Base). */
      inBase?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Give the target unit(s) +amount Might (mightBonus). */
  | ({
      op: 'BUFF_TARGET';
      amount: number;
      /** R54: [Buff] the target: a +1 Might buff if it has none (amount is 1). */
      buff?: boolean;
      /** R93: the amount is multiplied by the number of enemy units at the target's battlefield. */
      timesEnemiesThere?: boolean;
      atBattlefield?: boolean;
      /** "Buff a friendly unit in your base": the unit stands in a Base. */
      inBase?: boolean;
      /** R81: "... instead" when a condition holds. */
      alt?: AltAmount;
      side?: TargetSide;
      duration?: 'TURN';
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Kill the target unit (it is dealt lethal damage; Cleanup trashes it). */
  | ({
      op: 'KILL_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      /** Only units whose current Might is at most this. */
      maxMight?: number;
      /** R46: "kill a unit or gear": the target may also be a gear (killed like KILL_GEAR). */
      orGear?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Ready the target unit. */
  | ({
      op: 'READY_TARGET';
      side?: TargetSide;
      slot?: number;
      count?: TargetCount;
      /** R106: only units with this subtype ("ready another friendly Mech"). */
      subtype?: string;
    } & TargetScope)
  /** R57: "It can't move this turn": the target cannot be moved until the Ending step. */
  | ({
      op: 'LOCK_MOVE_TARGET';
      side?: TargetSide;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Stun the target unit: it deals no combat damage this turn (expires in the Ending step). */
  /** R98: "Give it [Temporary]" (permanent until it leaves): killed at its controller's next Beginning Phase. */
  | ({
      op: 'GRANT_TEMPORARY_TARGET';
      side?: TargetSide;
      kind?: 'unit' | 'gear' | 'unitOrGear';
      atBattlefield?: boolean;
      slot?: number;
    } & TargetScope)
  /** X7 (573): damage replacement markers on the target unit this turn: prevent the next damage, prevent the next N damage, or double all damage. */
  | ({
      op: 'DAMAGE_MOD_TARGET';
      mod: 'PREVENT_NEXT' | 'PREVENT_AMOUNT' | 'DOUBLE';
      amount?: number;
      side?: TargetSide;
      slot?: number;
    } & TargetScope)
  /** X7: prevent all damage that spells and abilities would deal this turn (Unyielding Spirit). */
  | { op: 'PREVENT_EFFECT_DAMAGE_TURN' }
  /** X7 (573): "The next time it would die this turn, heal it, exhaust it, and recall it instead" / "... banish it instead". */
  | ({
      op: 'DEATH_REPLACE_TARGET';
      mode: 'RECALL' | 'BANISH';
      /** "you may pay ... to": the replacement is offered to the unit's controller instead of applied. */
      offer?: OptionalCost;
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
    } & TargetScope)
  /** R98: "Double a unit's Might this turn". */
  | ({ op: 'DOUBLE_MIGHT_TARGET'; side?: TargetSide; slot?: number } & TargetScope)
  /** R97: the target unit's base Might becomes `amount` this turn (a temporary change, other bonuses stay). */
  | ({ op: 'SET_BASE_MIGHT'; amount: number; side?: TargetSide; slot?: number } & TargetScope)
  | ({
      op: 'STUN_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      /** R95: only a unit that is attacking in the combat being fought. */
      attacking?: boolean;
      /** "If it's already stunned, return it to its owner's hand instead" (Existential Dread). */
      orReturn?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /**
   * Give the target unit -amount Might this turn, but never below `minMight` (e.g. 1) when set.
   */
  | ({
      op: 'DEBUFF_TARGET';
      amount: number;
      /** R93: the amount is multiplied by the number of exhausted units the controller controls. */
      timesExhausted?: boolean;
      minMight?: number;
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Two chosen units each deal damage equal to their Might to the other (simultaneously). */
  | {
      op: 'MUTUAL_DAMAGE';
      slots: [number, number];
      sides: [TargetSide, TargetSide];
      atBattlefield?: boolean;
    }
  /** Kill the target gear (it goes to its owner's Trash; Equipment detaches). */
  | ({
      op: 'KILL_GEAR';
      side?: TargetSide;
      slot?: number;
      count?: TargetCount;
      /** Only gear whose Energy cost is at most this ("a gear with Energy cost 2 or less"). */
      maxEnergy?: number;
      /** R107: "no more than my Might": the limit is the source unit's current Might. */
      maxEnergyMyMight?: boolean;
    } & TargetScope)
  /** Kill every gear on the board. */
  | { op: 'KILL_ALL_GEAR' }
  /** Bomb: "kill your other <subtype> gear there" (at the source's battlefield, last known if it is gone). */
  | { op: 'KILL_GEARS_HERE'; subtype: string }
  /** Counter the target spell on the Chain (it is removed and trashed without resolving). */
  /**
   * R80: `minPower` = "with Power cost [A][A] or more"; `maxEnergy` / `maxPower` = "that costs no more than [4] and no
   * more than [A]" (printed costs of the countered spell).
   */
  | { op: 'COUNTER_SPELL'; slot?: number; minPower?: number; maxEnergy?: number; maxPower?: number }
  /** The controller of the target unit/gear draws `amount` ("Its controller draws N"). */
  | { op: 'TARGET_CONTROLLER_DRAW'; amount: number; slot?: number }
  /** R90: "Its owner channels N rune(s) exhausted" after a unit was returned (the owner of the returned unit). */
  | { op: 'TARGET_OWNER_CHANNEL'; amount: number; slot?: number }
  /** Give every unit of `side` on the board +amount Might (no target). */
  | {
      op: 'BUFF_ALL';
      amount: number;
      side: TargetSide;
      duration?: 'TURN';
      /** R83: a negative amount never takes a unit below this Might ("to a minimum of 1 [M]"). */
      minMight?: number;
      /** R93: [Buff] each unit instead (a +1 buff if it has none). */
      buff?: boolean;
      /** Only units with this subtype ("Give your Mechs +1 [M]"). */
      subtype?: string;
      /** R93: only the units at the source's battlefield ("all units here"), skipping the source with `others`. */
      here?: boolean;
      others?: boolean;
    }
  /** Deal damage to every unit of `side` in `scope` (no target). */
  | {
      op: 'DAMAGE_ALL';
      amount: number;
      side: TargetSide;
      /** R86: "here" = the source's battlefield; `amountFrom` reads the damage from the source (amount is 0). */
      scope: 'battlefields' | 'bases' | 'combat' | 'here' | 'chosen';
      /** `chosen`: the slot that holds the chosen battlefield ("Deal 3 to all enemy units at a battlefield"). */
      slot?: number;
      amountFrom?: 'MY_MIGHT' | 'MY_ASSAULT' | 'MY_SHIELD';
    }
  /** Ready or exhaust every unit of `side` (no target). */
  | { op: 'READY_ALL'; side: TargetSide }
  | { op: 'EXHAUST_ALL'; side: TargetSide }
  /**
   * Channel runes (431), optionally exhausted. If fewer than `amount` runes could be channeled,
   * draw `elseDraw` ("If you can't, draw 1"). `eachPlayer` (R44): every player channels, the controller first.
   */
  | { op: 'CHANNEL'; amount: number; exhausted?: boolean; elseDraw?: number; eachPlayer?: boolean }
  /**
   * Play `count` tokens (R3 round 2): `token` is a TOKEN_CARDS id (tokens.ts). They enter exhausted
   * unless `ready`, in the controller's Base, or at the source's location with `here`.
   */
  | {
      op: 'PLAY_TOKEN';
      token: string;
      count: number;
      ready?: boolean;
      here?: boolean;
      /** X-loc: the tokens are played to the battlefield chosen in this slot ("to a battlefield"). */
      atSlot?: number;
      /** R97: the (only) opponent plays the token(s) ("choose an opponent. They play ..."). */
      forOpponent?: boolean;
    }
  /** Return the target unit (or gear with `gear`) to its owner's hand; a token ceases to exist. */
  | ({
      op: 'RETURN_TARGET';
      side?: TargetSide;
      /** R106: "a non-Dragon unit": units with this subtype are not allowed. */
      notSubtype?: string;
      atBattlefield?: boolean;
      maxMight?: number;
      gear?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /**
   * R75: return the chosen card from the controller's Trash to their hand ("Return a unit from your trash
   * to your hand"). `what` limits the card type; `subtypes` ("a Bird, Cat, Dog, or Poro") need any one.
   */
  | {
      op: 'RETURN_FROM_TRASH';
      what: 'unit' | 'gear' | 'unitOrGear' | 'spell';
      subtypes?: string[];
      slot?: number;
      count?: TargetCount;
    }
  /**
   * X5: "Play a unit from your trash, ignoring its cost". The chosen Trash unit is played to its owner's
   * Base (the location choice is not modelled, UNCLEAR) with its whole cost set to zero (560.1.a); it
   * fires its own "When you play me" and counts for Legion. `maxEnergy` / `maxPower` are the printed-cost limits.
   */
  | {
      op: 'PLAY_FROM_TRASH';
      maxEnergy?: number;
      maxPower?: number;
      subtypes?: string[];
      slot?: number;
      count?: TargetCount;
    }
  /**
   * X5: "Banish a friendly unit, then its owner plays it [to their base | to the same location], ignoring its
   * cost": the unit leaves the Board and is played again (a new object that enters exhausted and fires its
   * "when you play me" triggers; a token ceases to exist).
   */
  | ({
      op: 'BLINK_TARGET';
      to: 'BASE' | 'SAME';
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
    } & TargetScope)
  /** X9: "play me" - the source card is played from the Trash to its owner's Base (costs already paid by the trigger). */
  | { op: 'PLAY_SELF' }
  /** Each player discards their whole hand (Invert Timelines); no choice is needed. */
  | { op: 'DISCARD_HAND'; eachPlayer?: boolean }
  /** "Take a turn after this one" (Time Warp): the controller's next turn is followed by another of theirs. */
  | { op: 'EXTRA_TURN' }
  /** "Kill this": the source permanent (a gear is killed; a unit takes lethal damage and dies in the next Cleanup). */
  | { op: 'KILL_SELF' }
  /** X5: "Banish this." - the spell is banished instead of going to the Trash. */
  | { op: 'BANISH_THIS_SPELL' }
  /** Move the target unit(s) to their controller's Base (an effect move, not a standard move). */
  | ({
      op: 'MOVE_BASE_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /**
   * R79: move the target unit to the source's battlefield ("move an enemy unit to that battlefield / to here /
   * to my battlefield"): an effect move that raises UNIT_MOVED (so `When I move` abilities see it).
   */
  | ({
      op: 'MOVE_HERE_TARGET';
      side?: TargetSide;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Kill every unit on the board. */
  | {
      op: 'KILL_ALL_UNITS';
      /** "Kill all damaged enemy units here" (Warwick): optional side / damaged / here filters. */
      side?: TargetSide;
      damaged?: boolean;
      here?: boolean;
    }
  /**
   * Look at the top `count` cards of the controller's Main Deck, take one into the hand (`take`;
   * "draw it" or "put it into your hand", optionally revealed and restricted to `filter`) and
   * recycle the rest to the bottom. The choice is deterministic until choices exist: the first
   * matching card from the top, or for an unrestricted take the one with the highest Energy cost.
   */
  | {
      op: 'LOOK_TOP';
      count: number;
      take?: LookTake;
      /** R96: what happens to the cards not taken: the bottom of the deck (default) or the Trash. */
      rest?: 'RECYCLE' | 'TRASH';
    }
  /** [Add] [N]: put `amount` Energy in the controller's Rune Pool (168, 166.1). */
  | { op: 'ADD_ENERGY'; amount: number }
  /**
   * [Add] [C] / [A]: put `amount` Power in the Rune Pool (168, 166.1). 'SOURCE' = [C], Power of the
   * source card's Domain (Universal [A] when it has none); 'ANY' = [A], Universal Power.
   */
  | { op: 'ADD_POWER'; amount: number; domain: 'SOURCE' | 'ANY' }
  /**
   * "Its controller plays a Gold gear token exhausted": the controller of the object that the
   * earlier KILL_GEAR / KILL_TARGET (same slot) removed plays tokens (like TARGET_CONTROLLER_DRAW).
   */
  | { op: 'TARGET_CONTROLLER_PLAY_TOKEN'; token: string; count: number; slot?: number }
  /**
   * Weaponmaster (821, R42): "you may Equip one of your Equipment to me for [A] less". The chosen
   * Equipment (an optional target: none = decline) is attached to the source unit and its Equip
   * cost, reduced by one Power ([A]), is paid at resolution from the Rune Pool and runes (auto plan).
   */
  | { op: 'WEAPONMASTER_EQUIP'; slot?: number; count?: TargetCount }
  /**
   * "Give a SIDE unit [Tank] this turn" (R43): the target unit(s) gain the keywords until the
   * Ending step (CardInstance.tempKeywords). Only Assault, Shield, Tank and Ganking are read.
   */
  | ({
      op: 'GRANT_KEYWORD_TARGET';
      keywords: KeywordInstance[];
      /** R93: "[Assault] equal to its Might": the keyword's value is the target's Might. */
      valueFromMight?: boolean;
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** "Give me [Ganking] this turn" / "Give your other units here [Shield] this turn" (R43). */
  | { op: 'GRANT_KEYWORDS'; keywords: KeywordInstance[]; to: 'SELF' | 'OTHERS_HERE' }
  /**
   * X-loc: "Choose a battlefield. Give friendly units there +1 [M] and enemy units there -1 [M] this turn, to a
   * minimum of 1 [M]" / "... friendly units there [Shield 2]" (Siphon Power, For Demacia!). `slot` holds the chosen
   * battlefield (a Target of kind 'battlefield').
   */
  | {
      op: 'BF_AREA';
      slot?: number;
      friendlyMight?: number;
      enemyMight?: number;
      minMight?: number;
      keywords?: KeywordInstance[];
    }
  /**
   * X-loc: an effect Move of the unit in `slot` to the location chosen in `destSlot` (a battlefield, or the
   * unit's own Base, written as the battlefield id 'base'). `ready` readies it afterwards.
   */
  | {
      op: 'MOVE_TARGET';
      slot?: number;
      /** The chosen location's slot, or -1 when `destFromSlot` gives the destination instead. */
      destSlot: number;
      /** "... to that enemy unit's battlefield": go to the battlefield where the unit in this slot stands. */
      destFromSlot?: number;
      /** "You may move ...": 0..1 units. */
      count?: TargetCount;
      side?: TargetSide;
      ready?: boolean;
      /** Which locations may be chosen: any (default), only battlefields, only open ones, ones you control, ... */
      dest?: 'ANY' | 'BATTLEFIELD' | 'OPEN' | 'CONTROLLED' | 'ENEMY_OCCUPIED' | 'TO_OR_FROM_BASE';
    };

/** Effects that choose one unit (or gear / spell) through `PLAY_CARD.targets`. */
export type TargetedEffect = Extract<
  CardEffect,
  {
    op:
      | 'DAMAGE_TARGET'
      | 'BUFF_TARGET'
      | 'KILL_TARGET'
      | 'READY_TARGET'
      | 'LOCK_MOVE_TARGET'
      | 'STUN_TARGET'
      | 'SET_BASE_MIGHT'
      | 'DEATH_REPLACE_TARGET'
      | 'DAMAGE_MOD_TARGET'
      | 'GRANT_TEMPORARY_TARGET'
      | 'DOUBLE_MIGHT_TARGET'
      | 'DEBUFF_TARGET'
      | 'KILL_GEAR'
      | 'RETURN_TARGET'
      | 'RETURN_FROM_TRASH'
      | 'PLAY_FROM_TRASH'
      | 'MOVE_BASE_TARGET'
      | 'BLINK_TARGET'
      | 'MOVE_HERE_TARGET'
      | 'COUNTER_SPELL'
      | 'WEAPONMASTER_EQUIP'
      | 'GRANT_KEYWORD_TARGET';
  }
>;

/**
 * Conditions (R43): "if you control a Poro", "if there is exactly one other unit you control here".
 * Pure predicates over public state (plus the controller's own hand SIZE), evaluated by
 * `evalCondition` (conditions.ts) for a source object and its controller.
 *  - COUNT: number of `what` ("unit" | "gear" | "rune" | "card" in hand) that `who` controls in
 *    `where` ('here' = at the source's battlefield, false when the source is not at one; 'base';
 *    'board' = base + battlefields; 'hand'; 'runeDeck' = the size of the Rune Deck (R44)), `other` excludes the source. Compared with `cmp` to `n`.
 *  - CONTROL_SUBTYPE: the controller controls a Unit with the subtype/tag (`other`: not the source).
 *  - AT_BATTLEFIELD: the source is at a battlefield ("while I'm at a battlefield").
 */
/**
 * R51: a static ability. `affects` picks the units / gear it applies to (SELF, FRIENDLY_UNITS,
 * FRIENDLY_GEAR, FRIENDLY_SUBTYPE + `subtype`, OTHER_FRIENDLY_HERE = my other friendly units at my
 * battlefield, UNITS_HERE = every unit at the source's battlefield); `when` is checked live from the
 * source's controller. It grants Might and / or keywords (only Assault, Shield, Tank, Ganking and
 * Deflect are read).
 */
/** R67: what a counted static counts (always from the source's point of view). */
export type StaticCount =
  | 'OTHER_EXHAUSTED_UNIT'
  | 'OTHER_SAME_NAME_HERE'
  | 'FRIENDLY_TOKEN_UNIT'
  | 'FRIENDLY_TEMPORARY_HERE'
  | 'FRIENDLY_GEAR'
  | 'BUFFED_FRIENDLY_HERE'
  | 'ENEMY_UNITS_HERE'
  | 'POINTS'
  /** R91: the number of cards in the controller's Trash ("My Might is increased by the number of cards in your trash"). */
  | 'TRASH_CARDS';

export interface StaticAbility {
  affects:
    | 'SELF'
    | 'FRIENDLY_UNITS'
    | 'FRIENDLY_GEAR'
    | 'FRIENDLY_SUBTYPE'
    | 'OTHER_FRIENDLY_HERE'
    | 'UNITS_HERE'
    | 'ALL_UNITS'
    /** R74: enemy / friendly units at the source's battlefield. */
    | 'ENEMY_UNITS_HERE'
    | 'FRIENDLY_UNITS_HERE'
    /** R88: every friendly unit except the source ("Other friendly units enter ready"). */
    | 'OTHER_FRIENDLY_UNITS';
  subtype?: string;
  /**
   * R67: "for each ...": `might` is multiplied by this count; with `perKeyword` the keyword is granted with the
   * count as its value ("I have [Assault] equal to the number of gear you control").
   */
  per?: StaticCount;
  perKeyword?: 'Assault' | 'Shield';
  /** R70: only units with this keyword / subtype are affected ("Units here with [Tank]", "Champion units here"). */
  onlyKeyword?: string;
  onlySubtype?: string;
  /** R57: a movement restriction instead of / besides a grant: units it affects cannot move to the Base. */
  restrict?:
    | 'NO_MOVE_TO_BASE'
    | 'NO_COMBAT_DAMAGE'
    | 'NO_ENEMY_CHOOSE'
    | 'NO_ENEMY_EFFECT_DAMAGE'
    | 'NO_DAMAGE';
  /**
   * R104: a cost modifier for the cards its controller plays: "the Energy costs for spells you play are reduced by [1],
   * to a minimum of [1]" / "Your Dragons' Energy costs are reduced by [2], to a minimum of [1]".
   */
  playCostMod?: { energy: number; min: number; spellsOnly?: boolean; subtype?: string };
  /** R88: only token units are affected ("Your token units have +1 [M]"). */
  onlyToken?: boolean;
  /** Karthus: the controller's Deathknell triggers happen an additional time. */
  doubleDeathknell?: boolean;
  /** Only buffed units are affected ("Friendly buffed units have [Deflect]"). */
  onlyBuffed?: boolean;
  /** R88: the affected units (or tokens) enter ready ("Your tokens enter ready"). */
  entersReady?: boolean;
  /** R74: the restriction (or grant) does NOT apply while this condition holds ("... unless <condition>"). */
  unless?: Condition;
  /**
   * X7 (573, 575): a standing replacement for the death of an affected unit: it is healed, exhausted and recalled
   * to its Base instead; `killSource` also kills the source ("kill this instead", Zhonya's Hourglass).
   */
  replaceDeath?: { killSource?: boolean; offer?: DeathOffer };
  /** R74: only units with LESS Might than the source (printed Might plus bonuses) are affected. */
  lessMight?: boolean;
  when?: Condition;
  might?: number;
  keywords?: KeywordInstance[];
}

/** R50: what "for each" counts in a self cost reduction (the player's own side, the card itself excluded). */
export type CostCount =
  | 'GEAR' // each gear you control (board)
  | 'EXHAUSTED_UNIT' // each exhausted unit you control
  | 'TRASH' // each card in your Trash
  | 'TRASH_SAME_NAME' // each card with my name in your Trash
  | 'MIGHTY_UNIT' // each of your [Mighty] units (Might 5+)
  | 'CARDS_PLAYED' // each card you have played this turn
  | 'RUNE' // R91: each rune you control
  | 'HIGHEST_MIGHT'; // R91: the highest Might among units you control (counted as that many)

export interface CostReduction {
  /** Energy discount: per counted item (`per`) or once (`when`, or unconditional). */
  energy: number;
  per?: CostCount;
  /** "if <condition>": the discount applies only while it holds (checked as the card is played / listed). */
  when?: Condition;
  /** "to a minimum of [N]": the discounted Energy cost never goes below this. */
  min?: number;
}

export type CountCmp = 'EQ' | 'GTE' | 'LTE';
export type Condition =
  | {
      kind: 'COUNT';
      what: 'unit' | 'gear' | 'rune' | 'card';
      where: 'here' | 'base' | 'board' | 'hand' | 'runeDeck';
      who: 'friendly' | 'enemy';
      other?: boolean;
      cmp: CountCmp;
      n: number;
    }
  | { kind: 'CONTROL_SUBTYPE'; subtype: string; other?: boolean }
  | { kind: 'AT_BATTLEFIELD' }
  /** R52: the source is Empowered. */
  | { kind: 'EMPOWERED' }
  /** R54: the source carries a Buff ("While I'm buffed"). */
  | { kind: 'BUFFED' }
  /** "I cost [N] less to play from anywhere other than your hand": the source is being played from another zone. */
  | { kind: 'NOT_IN_HAND' }
  /** "If I have moved twice this turn": the source has moved to a battlefield at least `n` times this turn. */
  | { kind: 'MOVES_AT_LEAST'; n: number }
  /** R62: `who` controls at least one battlefield. */
  | { kind: 'CONTROLS_BATTLEFIELD'; who: 'friendly' | 'enemy' }
  /** R62: `who`'s score is within 3 points of the Victory Score (`not` negates). */
  | { kind: 'SCORE_NEAR'; who: 'friendly' | 'enemy'; not?: boolean }
  /** R58: "if you paid the additional cost" (play triggers; read from the CARD_PLAYED event). */
  | { kind: 'PAID_ADDITIONAL' }
  /** R71: a Deathknell's "if I died alone" (no other friendly unit at its location); `not` = "didn't die alone". */
  | { kind: 'DIED_ALONE'; not?: boolean }
  /** R72: the controller has fewer / more runes in play than an opponent. */
  | { kind: 'RUNES_VS_OPPONENT'; cmp: 'FEWER' | 'MORE' }
  /** R72: the controller has a facedown card at a battlefield (`here` = the source's battlefield). */
  | { kind: 'FACEDOWN'; here?: boolean }
  /** R73: a unit or gear the controller played this turn now stands at a battlefield. */
  | { kind: 'PLAYED_TO_BATTLEFIELD' }
  /** R73: the controller controls an Empowered permanent. */
  | { kind: 'CONTROLS_EMPOWERED' }
  /** R73: an opponent controls a stunned unit. */
  | { kind: 'ENEMY_STUNNED' }
  /** R73: the controller's Trash holds a card with the source's name ("a card with my name"). */
  | { kind: 'NAME_IN_TRASH' }
  /** R74: the source is in the combat that is being fought. */
  | { kind: 'IN_COMBAT' }
  /** R85: the controller controls the battlefield the source stands at ("if you control this battlefield"). */
  | { kind: 'CONTROLS_HERE' }
  /** R107: your other units on the board have total Might of at least `n`. */
  | { kind: 'OTHER_UNITS_MIGHT'; n: number }
  /** R100: this card was just played from face down (read from the triggering CARD_PLAYED event). */
  | { kind: 'FROM_FACEDOWN' }
  /**
   * R95: the source is in the combat being fought as an attacker / defender (`role`), optionally `alone` (no other
   * friendly unit at the battlefield) or `withOther` (at least one other friendly unit there).
   */
  | {
      kind: 'COMBAT_ROLE';
      role: 'ATTACKING' | 'DEFENDING' | 'EITHER';
      alone?: boolean;
      withOther?: boolean;
    }
  /** R87: the controller assigned at least `n` excess combat damage to enemy units this turn. */
  | { kind: 'EXCESS_DAMAGE'; n: number }
  /** R56: a unit of `who` (friendly = the controller's, any = either side) died this turn. */
  | { kind: 'DIED_THIS_TURN'; who: 'friendly' | 'enemy' | 'any' }
  /** R53: Level N: the controller has at least `n` XP. */
  | { kind: 'XP'; n: number };

/**
 * The price of an optional effect (R45, "you may pay [1] to ..."). `energy` = [N], `power` = [C]
 * (Power of the source card's Domain, any Power when it has none), `anyPower` = [A] (any Power),
 * `burn` = [Burn N] (put the top N cards of the Main Deck into the Trash; payable with N cards).
 * Everything is paid through the Rune Pool / rune machinery (`payCost`) when the controller accepts.
 */
export interface OptionalCost {
  energy?: number;
  power?: number;
  anyPower?: number;
  burn?: number;
  /** R46: cards the controller picks and pays (discard / kill / exhaust / return / recycle). */
  card?: CostCardChoice;
  /**
   * R77: not a "you may": the controller MUST pay ("Discard 1, then draw 1"). The same prompt and intent
   * as an optional cost, without the decline answer; a hand with fewer cards than asked discards them all.
   */
  mandatory?: boolean;
}

/**
 * R46: a cost that needs the payer to CHOOSE cards ("discard 1", "kill a friendly unit", "exhaust a
 * unit you control", "return a unit you control here to its owner's hand", "recycle a unit from your
 * trash"). The choice is part of the intent (`DECIDE_OPTIONAL.costCards` / `ACTIVATE_ABILITY.costCards`),
 * validated by the engine and paid atomically with the rest of the cost.
 *  - DISCARD: cards from the payer's hand go to their Trash (the Trash is public, so the opponent only
 *    learns the card once it is discarded).
 *  - KILL: friendly units / gear on the board are killed (lethal damage / gear to the Trash; Deathknell
 *    and the Cleanup follow as for any kill).
 *  - EXHAUST: ready friendly units become exhausted.
 *  - RETURN: friendly units / gear return to their owner's hand (tokens cease to exist).
 *  - RECYCLE: cards from the payer's Trash go to the bottom of their Main Deck.
 */
export type CostCardKind = 'DISCARD' | 'KILL' | 'EXHAUST' | 'RETURN' | 'RECYCLE';

/**
 * X7 (575): an optional standing replacement for the death of an affected unit ("you may pay [C] ... to heal it,
 * exhaust it, and recall it instead"). The unit's controller is asked when it would die (flow.pendingChoice
 * DEATH_REPLACE) and may pay `cost` (plus the extras below) to have it recalled instead.
 */
export interface DeathOffer {
  cost: OptionalCost;
  /** "exhaust me": the source must be ready and becomes exhausted. */
  exhaustSource?: boolean;
  /** "spend its buff": the unit must carry a Buff, which is removed. */
  spendBuff?: boolean;
  /** "Once each turn". */
  oncePerTurn?: boolean;
  /** Only a death in combat ("would die during combat"). */
  combatOnly?: boolean;
  /** Only a buffed unit qualifies. */
  buffedOnly?: boolean;
}

export interface CostCardChoice {
  kind: CostCardKind;
  /** How many cards (default 1); all distinct. */
  count?: number;
  /** Which cards qualify: a card type for hand / Trash; unit, gear or either on the board. */
  what?: 'unit' | 'gear' | 'unitOrGear' | 'spell';
  /** Board kinds: at the source's battlefield ("a unit you control here"). */
  here?: boolean;
  /** Board kinds: not the ability's own source ("another friendly unit"). */
  another?: boolean;
  /** R47: only [Mighty] units qualify ("kill a friendly [Mighty] unit": Might 5 or more). */
  mighty?: boolean;
}

/** When a triggered ability fires (R5). */
export type TriggerKind =
  | 'PLAY'
  | 'HOLD'
  | 'CONQUER'
  | 'DEATH'
  | 'ATTACK'
  | 'DEFEND'
  | 'MOVE'
  /** R49: "When you play a <card>": fires for each of your permanents whose filter matches the played card. */
  | 'YOU_PLAY'
  /** R71: "When I win a combat" (the winner's units standing at the battlefield when it ends). */
  | 'WIN_COMBAT'
  /** R71: "When a combat that I was in ends" (any unit still standing there). */
  | 'COMBAT_END'
  /** R71: "When a friendly / an enemy unit dies" (see `CardTrigger.dies`). */
  | 'UNIT_DIES'
  /** R72: "At the start of your Beginning Phase" (resolved inline, no Chain). */
  | 'TURN_START'
  /** R72: "At the end of your turn" (resolved inline in the Ending step, no Chain). */
  | 'TURN_END'
  /** R78: "When I become exhausted" / "When I become ready" / "When I become [Empowered]". */
  | 'BECOME_EXHAUSTED'
  | 'BECOME_READY'
  | 'BECOME_EMPOWERED'
  /** R92: "When an opponent scores" (a point from any source). */
  | 'OPP_SCORES'
  /** R100: "When you hide a card". */
  | 'YOU_HIDE'
  /** R108: "When I move from a battlefield". */
  | 'MOVE_FROM'
  /** R108: "When you use an activated ability of a gear". */
  | 'USE_GEAR_ABILITY'
  /** X9: "When you stun an enemy unit" (a unit that was already stunned is not stunned again, 599.1.a.1). */
  | 'YOU_STUN_ENEMY'
  /** X9: "When you discard one or more cards" (598.1.b; discards happen as card-choice costs / discard effects). */
  | 'YOU_DISCARD'
  /** X9: "When you discard me": fires for the discarded card itself (now in its owner's Trash). */
  | 'DISCARD_SELF'
  /** X9 (709): "When a unit you control becomes [Mighty]". */
  | 'UNIT_BECOMES_MIGHTY'
  /** "When this is killed / leaves the board" for a gear: fires for the gear itself, now in its owner's Trash. */
  | 'GEAR_LEAVES'
  /** "When a friendly unit attacks or defends alone" / "When an enemy unit attacks a battlefield you control" (see `CardTrigger.unitFilter`); the unit is the ability's target ("give it"). */
  | 'UNIT_ATTACKS';

/** R71: which deaths a UNIT_DIES trigger reacts to. */
export interface DeathFilter {
  side: 'friendly' | 'enemy';
  /** "enemy unit here": it died at the source's battlefield. */
  here?: boolean;
  /** "another non-Recruit unit": units with this subtype (case-insensitive) do not trigger it. */
  exceptSubtype?: string;
  /** "When one or more ... die": once per batch of deaths, not once per unit. */
  batch?: boolean;
}

/**
 * R49: which played card a YOU_PLAY trigger reacts to. Absent fields match anything. The source's own
 * play never triggers its own YOU_PLAY ability ("When you play me" is the PLAY form; UNCLEAR).
 */
export interface PlayFilter {
  /** Card type of the played card (a token is a Unit / Gear by its own stats). */
  type?: 'SPELL' | 'UNIT' | 'GEAR';
  /** "another": any source permanent other than the played card (always true here, kept for text fidelity). */
  other?: boolean;
  /** "that costs [N] or more" / "with Energy cost [N] or more": the printed Energy cost. */
  minEnergy?: number;
  /** R100: "When you play a card from face down". */
  fromFacedown?: boolean;
  /** R99: "with Power cost [A][A] or more": the printed generic Power cost. */
  minPower?: number;
  /** R99: "a token unit": fires when a token unit is played by an effect (never for cards). */
  token?: boolean;
  /** R99: "your second card in a turn": this is the Nth card its player played this turn. */
  nth?: number;
  /** "on an opponent's turn". */
  onOpponentTurn?: boolean;
  /** "during a showdown". */
  inShowdown?: boolean;
}

/**
 * A triggered ability: "When you play me / When I hold / When I conquer / When I attack / When I
 * defend / Deathknell: <effects>". Effects may choose targets (R41); ATTACK and DEFEND (R42) fire
 * for each of the attacker's / defender's units when a combat Showdown begins (466.2.c).
 */
export interface CardTrigger {
  on: TriggerKind;
  effects: CardEffect[];
  /**
   * X-modes: "..., choose one —": the controller picks one of these effect lists as the ability is put on the Chain
   * (`effects` is then empty). `modeTexts` are the printed bullets, for the client. `modeOnce`: "choose one that
   * hasn't been chosen this turn" (a mode already chosen this turn for this source cannot be chosen again).
   */
  modes?: CardEffect[][];
  modeTexts?: string[];
  modeOnce?: boolean;
  /** A mode that is "pay <cost> to <effect>": the cost is asked as the ability resolves (like `optional`). */
  modeOptional?: (OptionalCost | undefined)[];
  /** R49: only for `on: 'YOU_PLAY'`. */
  playFilter?: PlayFilter;
  /** R71: only for `on: 'UNIT_DIES'`. */
  dies?: DeathFilter;
  /** `on: 'UNIT_ATTACKS'`: which unit in a combat triggers it. */
  unitFilter?: { side: 'friendly' | 'enemy'; alone?: boolean; attacking?: boolean; atMine?: boolean };
  /** "The third time I move in a turn": fires only on the unit's n-th move to a battlefield this turn. */
  moveNth?: number;
  /** "When I die in combat": only a death while a combat was being fought at the unit's battlefield. */
  inCombat?: boolean;
  /** R71: "Once each turn, when ...": the ability triggers at most once per turn. */
  oncePerTurn?: boolean;
  /**
   * R45: "you may [pay COST to] <effects>". When the ability resolves its controller is asked to
   * accept or decline (flow.pendingChoice OPTIONAL_EFFECT, DECIDE_OPTIONAL); the cost is paid only on
   * accept and the effects run only on accept. `{}` = a free "you may". Targets are still chosen when
   * the ability is put on the Chain (R41).
   */
  optional?: OptionalCost;
  /**
   * Dependent keyword condition (812): "LEGION" = the controller has played another card this
   * turn when the ability triggers. Absent = unconditional.
   */
  condition?: 'LEGION';
  /**
   * General condition (R43), "When I hold, if <condition>, ...". Checked when the ability triggers
   * (no Chain item otherwise) and again as it resolves (intervening-if; UNCLEAR, docs/ASSUMPTIONS.md R43).
   */
  when?: Condition;
}

/** Costs of an activated ability (145.1, 151.1): the part before the colon. */
export interface AbilityCost {
  /** [E]: exhaust the source (needs it ready). */
  exhaust?: boolean;
  /** Energy to pay ([N]). */
  energy?: number;
  /** "Kill this": the source (Gear / token Gear) is killed as a cost. */
  killSelf?: boolean;
  /** R46: [C] (Power of the source's Domain) and [A] (any Power) in the cost, e.g. "[1][C], [E]:". */
  power?: number;
  anyPower?: number;
  /** R46: a card-choice cost ("Discard a gear", "Recycle 1 from your trash"). */
  card?: CostCardChoice;
  /** R60: "Spend N XP": the controller's XP drops by N. */
  xp?: number;
}

/**
 * An activated ability of a permanent ("[Reaction][>] Kill this, [E]: [Add] [A]."). Abilities
 * whose effects are all [Add] effects resolve at once without the Chain (168); the others go on
 * the Chain as an ABILITY item (`activatedIndex`). Target-free effects only.
 */
export interface ActivatedAbility {
  cost: AbilityCost;
  /** R91: "This ability costs [N] less for each rune you control / if you control 4 or fewer runes." */
  costReduction?: CostReduction;
  /** R74: "Use this ability only while I'm at a battlefield." */
  atBattlefield?: boolean;
  /** Reaction speed (usable in a Closed state / Showdown). */
  reaction?: boolean;
  /** "[Legion] —" before the effect: usable only while the controller has played another card this turn. */
  legion?: boolean;
  effects: CardEffect[];
}

/**
 * Structured Equip cost (rule 818), parsed from the card text by the converter.
 * `power` is [C] (Power of the Equipment's own domain(s)); `anyPower` is [A] (any domain).
 */
export interface EquipCost {
  energy: number;
  power: number;
  anyPower: number;
  /** "[3][A]. This ability's Energy cost is reduced by the Might of the unit you choose." */
  energyReducedByMight?: boolean;
  /** Printed non-resource cost part (kill a unit, recycle, spend XP, ...); NOT enforced yet. */
  nonResource?: string;
}

export interface CardDef {
  /** Stable catalog id, shared by all copies. */
  cardId: string;
  name: string;
  subtitle?: string;
  type: CardType;
  /** card_type_labels / tags, e.g. Champion, Equipment, Signature. */
  subtypes: string[];
  cost: CardCost;
  /** Empty array = colorless. */
  domains: Domain[];
  stats: CardStats;
  keywords: KeywordInstance[];
  /** Rules text as printed. */
  text: string;
  /** 'full' = no prose effects beyond MVP keywords; 'partial' = has unimplemented effects. */
  supportLevel: 'full' | 'partial';
  /** Executable effects, resolved when the card's Chain item resolves (spells only for now). */
  effects?: CardEffect[];
  /** Triggered abilities of a unit or gear. */
  triggers?: CardTrigger[];
  /** Activated abilities of a permanent, indexed by `ACTIVATE_ABILITY.abilityIndex`. */
  abilities?: ActivatedAbility[];
  /** "I enter ready.": the permanent enters ready instead of exhausted (359.2.c). */
  entersReady?: boolean;
  /** "I enter ready if <condition>." (R43): checked as the permanent enters. */
  entersReadyWhen?: Condition;
  /** "This enters exhausted." (R42): Gear that would enter ready (359.2.d) enters exhausted. */
  entersExhausted?: boolean;
  /** "[Legion] - I cost [N] less.": Energy discount while Legion is active (812). */
  legionCostReduction?: number;
  /** R51: static abilities ("Your gear have [Deflect]", "While ..., I have +1 [M]"); see statics.ts. */
  statics?: StaticAbility[];
  /** R61: Flow cost: the spell may be played from its owner's Trash for this cost instead, then it is banished. */
  flowCost?: { energy: number; power?: number; anyPower?: number };
  /** R59: a modal spell ("Choose one — ..."): the effects of each mode; the player picks one (PLAY_CARD.mode). */
  modes?: CardEffect[][];
  /** R58: "You may pay [N] as an additional cost to play me": the optional extra (`additionalCosts.extra`). */
  /**
   * R76: extra places a Unit may be played to, besides a battlefield you control: "OPEN" = a battlefield with
   * no units on it, "ENEMY" = a battlefield an opponent controls with their units on it.
   */
  playTo?: ('OPEN' | 'ENEMY')[];
  optionalAdditionalCost?: {
    energy: number;
    power?: number;
    anyPower?: number;
    /** R63: "You may discard 1 / kill a friendly unit ... as an additional cost": cards chosen with the play. */
    card?: CostCardChoice;
    /** R63: "You may spend N XP as an additional cost". */
    xp?: number;
    /** R63: "If you do, I cost [N] less": Energy knocked off when the extra is paid. */
    reduceEnergy?: number;
  };
  /** R50: "I cost [N] less for each ..." / "This costs [N] less if ...": a discount on this card's own Energy cost. */
  costReduction?: CostReduction;
  /**
   * Repeat cost of a spell (820, R42): an optional additional cost; paying it runs the spell's
   * effects one more time on resolution. `energy` is [N]; `power` counts [C] (Power of the spell's Domain).
   */
  repeatCost?: { energy: number; power: number; card?: CostCardChoice };
  /**
   * R47: "As an additional cost to play this/me, <card-choice cost>." A REQUIRED additional cost: the
   * player picks the cards in `PLAY_CARD.costCards`; a card whose cost cannot be met is not playable.
   */
  additionalCost?: { card: CostCardChoice };
  /** Equip cost of Equipment (rule 818); absent = free (no parsable cost). */
  equipCost?: EquipCost;
  imageUrl?: string;
}

export type CardDatabase = Record<string, CardDef>;
