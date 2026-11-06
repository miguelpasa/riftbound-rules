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

export type CardEffect =
  /** `perOtherBattlefield`: draw `amount` for each OTHER battlefield the controller controls (R44). */
  | { op: 'DRAW'; amount: number; perOtherBattlefield?: boolean }
  /** R44: put the top `amount` cards of the controller's Main Deck into their Trash ([Burn N]). */
  | { op: 'BURN'; amount: number }
  /** R44: the controller wins the game. */
  | { op: 'WIN_GAME' }
  /** R45: "give me +N [M] this turn" (the source unit; nothing if it left the board). */
  | { op: 'BUFF_SELF'; amount: number }
  /** R45: "ready your legend". */
  | { op: 'READY_LEGEND' }
  | { op: 'GAIN_POINT'; amount: number }
  /** Deal damage to the target unit(s); Cleanup kills a unit if lethal. */
  | ({
      op: 'DAMAGE_TARGET';
      amount: number;
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Give the target unit(s) +amount Might (mightBonus). */
  | ({
      op: 'BUFF_TARGET';
      amount: number;
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
  | ({ op: 'READY_TARGET'; side?: TargetSide; slot?: number; count?: TargetCount } & TargetScope)
  /** Stun the target unit: it deals no combat damage this turn (expires in the Ending step). */
  | ({
      op: 'STUN_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /**
   * Give the target unit -amount Might this turn, but never below `minMight` (e.g. 1) when set.
   */
  | ({
      op: 'DEBUFF_TARGET';
      amount: number;
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
    } & TargetScope)
  /** Kill every gear on the board. */
  | { op: 'KILL_ALL_GEAR' }
  /** Counter the target spell on the Chain (it is removed and trashed without resolving). */
  | { op: 'COUNTER_SPELL'; slot?: number }
  /** The controller of the target unit/gear draws `amount` ("Its controller draws N"). */
  | { op: 'TARGET_CONTROLLER_DRAW'; amount: number; slot?: number }
  /** Give every unit of `side` on the board +amount Might (no target). */
  | { op: 'BUFF_ALL'; amount: number; side: TargetSide; duration?: 'TURN' }
  /** Deal damage to every unit of `side` in `scope` (no target). */
  | {
      op: 'DAMAGE_ALL';
      amount: number;
      side: TargetSide;
      scope: 'battlefields' | 'bases' | 'combat';
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
  | { op: 'PLAY_TOKEN'; token: string; count: number; ready?: boolean; here?: boolean }
  /** Return the target unit (or gear with `gear`) to its owner's hand; a token ceases to exist. */
  | ({
      op: 'RETURN_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      maxMight?: number;
      gear?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Move the target unit(s) to their controller's Base (an effect move, not a standard move). */
  | ({
      op: 'MOVE_BASE_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** Kill every unit on the board. */
  | { op: 'KILL_ALL_UNITS' }
  /**
   * Look at the top `count` cards of the controller's Main Deck, take one into the hand (`take`;
   * "draw it" or "put it into your hand", optionally revealed and restricted to `filter`) and
   * recycle the rest to the bottom. The choice is deterministic until choices exist: the first
   * matching card from the top, or for an unrestricted take the one with the highest Energy cost.
   */
  | {
      op: 'LOOK_TOP';
      count: number;
      take?: { filter?: 'unit' | 'gear'; reveal?: boolean };
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
      side?: TargetSide;
      atBattlefield?: boolean;
      slot?: number;
      count?: TargetCount;
    } & TargetScope)
  /** "Give me [Ganking] this turn" / "Give your other units here [Shield] this turn" (R43). */
  | { op: 'GRANT_KEYWORDS'; keywords: KeywordInstance[]; to: 'SELF' | 'OTHERS_HERE' };

/** Effects that choose one unit (or gear / spell) through `PLAY_CARD.targets`. */
export type TargetedEffect = Extract<
  CardEffect,
  {
    op:
      | 'DAMAGE_TARGET'
      | 'BUFF_TARGET'
      | 'KILL_TARGET'
      | 'READY_TARGET'
      | 'STUN_TARGET'
      | 'DEBUFF_TARGET'
      | 'KILL_GEAR'
      | 'RETURN_TARGET'
      | 'MOVE_BASE_TARGET'
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
  | { kind: 'AT_BATTLEFIELD' };

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
}

/** When a triggered ability fires (R5). */
export type TriggerKind = 'PLAY' | 'HOLD' | 'CONQUER' | 'DEATH' | 'ATTACK' | 'DEFEND' | 'MOVE';

/**
 * A triggered ability: "When you play me / When I hold / When I conquer / When I attack / When I
 * defend / Deathknell: <effects>". Effects may choose targets (R41); ATTACK and DEFEND (R42) fire
 * for each of the attacker's / defender's units when a combat Showdown begins (466.2.c).
 */
export interface CardTrigger {
  on: TriggerKind;
  effects: CardEffect[];
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
}

/**
 * An activated ability of a permanent ("[Reaction][>] Kill this, [E]: [Add] [A]."). Abilities
 * whose effects are all [Add] effects resolve at once without the Chain (168); the others go on
 * the Chain as an ABILITY item (`activatedIndex`). Target-free effects only.
 */
export interface ActivatedAbility {
  cost: AbilityCost;
  /** Reaction speed (usable in a Closed state / Showdown). */
  reaction?: boolean;
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
  /**
   * Repeat cost of a spell (820, R42): an optional additional cost; paying it runs the spell's
   * effects one more time on resolution. `energy` is [N]; `power` counts [C] (Power of the spell's Domain).
   */
  repeatCost?: { energy: number; power: number };
  /** Equip cost of Equipment (rule 818); absent = free (no parsable cost). */
  equipCost?: EquipCost;
  imageUrl?: string;
}

export type CardDatabase = Record<string, CardDef>;
