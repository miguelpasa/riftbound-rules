/**
 * Static abilities (R51): "Your gear have [Deflect]", "Other friendly units here have [Assault]",
 * "While you have another unit here, I have +1 [M]". They are not triggers and use no Chain: they are
 * read whenever a unit's Might or keywords are asked for (`effectiveMight`, combat tiers, Ganking,
 * Deflect). A source is a permanent on the board, a Legend in its zone or a Battlefield card; the
 * `when` condition is evaluated from the source's controller. Only public information is read.
 */
import { evalCondition } from './conditions.js';
import { defWithTemp } from './tempKeywords.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  GameState,
  KeywordInstance,
  PlayerId,
  StaticAbility,
} from './types/index.js';

const withStatics = new WeakMap<CardDatabase, Set<string>>();

/** Card ids that carry static abilities (cached per card database). */
function staticIds(cards: CardDatabase): Set<string> {
  let s = withStatics.get(cards);
  if (!s) {
    s = new Set(
      Object.values(cards)
        .filter((d) => d.statics && d.statics.length > 0)
        .map((d) => d.cardId),
    );
    withStatics.set(cards, s);
  }
  return s;
}

function targetBattlefield(o: CardInstance): string | null {
  return o.zone.kind === 'battlefield' ? o.zone.battlefieldId : null;
}

function isUnit(def: CardDef | undefined): boolean {
  return def?.type === 'UNIT' || (def?.type === 'TOKEN' && def.stats.might !== undefined);
}

function applies(
  s: StaticAbility,
  sourceId: string,
  sourceController: PlayerId,
  sourceHere: string | null,
  target: CardInstance,
  targetDef: CardDef,
): boolean {
  const friendly = target.controller === sourceController;
  const at = targetBattlefield(target);
  switch (s.affects) {
    case 'SELF':
      return target.id === sourceId;
    case 'ALL_UNITS':
      return isUnit(targetDef);
    case 'FRIENDLY_UNITS':
      return friendly && isUnit(targetDef);
    case 'FRIENDLY_GEAR':
      return friendly && targetDef.type === 'GEAR';
    case 'FRIENDLY_SUBTYPE':
      return (
        friendly &&
        isUnit(targetDef) &&
        targetDef.subtypes.some((x) => x.toLowerCase() === (s.subtype ?? '').toLowerCase())
      );
    case 'OTHER_FRIENDLY_HERE':
      return (
        friendly &&
        isUnit(targetDef) &&
        target.id !== sourceId &&
        sourceHere !== null &&
        at === sourceHere
      );
    case 'UNITS_HERE':
      return isUnit(targetDef) && sourceHere !== null && at === sourceHere;
  }
}

export interface StaticBonus {
  might: number;
  keywords: KeywordInstance[];
  /** R57: movement restrictions that apply to the target. */
  noMoveToBase?: boolean;
}

const NONE: StaticBonus = { might: 0, keywords: [] };

/** Static Might and keywords that currently apply to `target` (zero when no card has statics). */
export function staticBonus(
  state: GameState,
  cards: CardDatabase,
  target: CardInstance | undefined,
): StaticBonus {
  if (!target) return NONE;
  const ids = staticIds(cards);
  if (ids.size === 0) return NONE;
  const targetDef = cards[target.cardId];
  if (!targetDef) return NONE;
  let might = 0;
  const keywords: KeywordInstance[] = [];
  let noMoveToBase = false;
  const apply = (
    def: CardDef | undefined,
    sourceId: string,
    controller: PlayerId,
    here: string | null,
    when: (cond: NonNullable<StaticAbility['when']>) => boolean,
  ): void => {
    for (const s of def?.statics ?? []) {
      if (!applies(s, sourceId, controller, here, target, targetDef)) continue;
      if (s.when && !when(s.when)) continue;
      might += s.might ?? 0;
      if (s.restrict === 'NO_MOVE_TO_BASE') noMoveToBase = true;
      for (const k of s.keywords ?? []) keywords.push({ ...k });
    }
  };
  for (const o of Object.values(state.objects)) {
    if (!ids.has(o.cardId)) continue;
    const z = o.zone.kind;
    if (z !== 'base' && z !== 'battlefield' && z !== 'legend') continue;
    apply(cards[o.cardId], o.id, o.controller, targetBattlefield(o), (c) =>
      evalCondition(state, cards, c, o.controller, o.id),
    );
  }
  for (const bf of state.battlefields) {
    if (!ids.has(bf.cardId)) continue;
    apply(cards[bf.cardId], bf.id, target.controller, bf.id, (c) =>
      evalCondition(state, cards, c, target.controller, bf.id),
    );
  }
  return might === 0 && keywords.length === 0 && !noMoveToBase
    ? NONE
    : { might, keywords, ...(noMoveToBase ? { noMoveToBase } : {}) };
}

/** The printed definition plus temporary and static keyword grants (the same object if none). */
export function defWithGrants(
  state: GameState,
  cards: CardDatabase,
  obj: CardInstance | undefined,
): CardDef | undefined {
  if (!obj) return undefined;
  const def = defWithTemp(cards[obj.cardId], obj);
  const extra = staticBonus(state, cards, obj).keywords;
  if (!def || extra.length === 0) return def;
  return { ...def, keywords: [...def.keywords, ...extra] };
}
