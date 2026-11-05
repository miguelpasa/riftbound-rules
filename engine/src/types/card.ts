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
  | 'QuickDraw';

/** Keywords typed but deferred (not implemented; cards using them are 'partial'). */
export type DeferredKeywordName =
  | 'Deathknell'
  | 'Legion'
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
];

/** Keywords that are typed but not yet implemented. */
export const DEFERRED_KEYWORDS: readonly DeferredKeywordName[] = [
  'Deathknell',
  'Legion',
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

export type CardEffect =
  | { op: 'DRAW'; amount: number }
  | { op: 'GAIN_POINT'; amount: number }
  /** Deal damage to the first object target (a unit on the board); Cleanup kills it if lethal. */
  | { op: 'DAMAGE_TARGET'; amount: number; side?: TargetSide; atBattlefield?: boolean }
  /** Give the first object target +amount Might (mightBonus). */
  | { op: 'BUFF_TARGET'; amount: number; side?: TargetSide; duration?: 'TURN' }
  /** Kill the target unit (it is dealt lethal damage; Cleanup trashes it). */
  | {
      op: 'KILL_TARGET';
      side?: TargetSide;
      atBattlefield?: boolean;
      /** Only units whose current Might is at most this. */
      maxMight?: number;
    }
  /** Ready the target unit. */
  | { op: 'READY_TARGET'; side?: TargetSide }
  /** Give every unit of `side` on the board +amount Might (no target). */
  | { op: 'BUFF_ALL'; amount: number; side: TargetSide; duration?: 'TURN' };

/** Effects that need one chosen unit. */
export type TargetedEffect = Extract<
  CardEffect,
  { op: 'DAMAGE_TARGET' | 'BUFF_TARGET' | 'KILL_TARGET' | 'READY_TARGET' }
>;

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
  imageUrl?: string;
}

export type CardDatabase = Record<string, CardDef>;
