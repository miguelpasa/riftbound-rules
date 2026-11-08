/**
 * Static abilities (R51): "Your gear have [Deflect]", "Other friendly units here have [Assault]",
 * "While you have another unit here, I have +1 [M]". They are not triggers and use no Chain: they are
 * read whenever a unit's Might or keywords are asked for (`effectiveMight`, combat tiers, Ganking,
 * Deflect). A source is a permanent on the board, a Legend in its zone or a Battlefield card; the
 * `when` condition is evaluated from the source's controller. Only public information is read.
 */
import { baseMight } from './baseMight.js';
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

function isTempDef(def: CardDef | undefined): boolean {
  return def?.keywords.some((k) => k.name === 'Temporary') === true;
}

/** R67: the number a counted static multiplies by. */
function countStatic(
  state: GameState,
  cards: CardDatabase,
  src: CardInstance,
  what: NonNullable<StaticAbility['per']>,
): number {
  if (what === 'POINTS') return state.players[src.controller === 'p0' ? 0 : 1]?.points ?? 0;
  if (what === 'TRASH_CARDS') {
    return state.players[src.controller === 'p0' ? 0 : 1]?.trash.length ?? 0;
  }
  const here = targetBattlefield(src);
  let n = 0;
  for (const o of Object.values(state.objects)) {
    if (o.id === src.id) continue;
    const z = o.zone.kind;
    if (z !== 'base' && z !== 'battlefield') continue;
    const d = cards[o.cardId];
    const friendly = o.controller === src.controller;
    const at = targetBattlefield(o);
    switch (what) {
      case 'OTHER_EXHAUSTED_UNIT':
        if (friendly && isUnit(d) && !o.ready) n++;
        break;
      case 'OTHER_SAME_NAME_HERE':
        if (
          friendly &&
          isUnit(d) &&
          here !== null &&
          at === here &&
          d?.name === cards[src.cardId]?.name
        )
          n++;
        break;
      case 'FRIENDLY_TOKEN_UNIT':
        if (friendly && d?.type === 'TOKEN' && isUnit(d)) n++;
        break;
      case 'FRIENDLY_TEMPORARY_HERE':
        if (friendly && isUnit(d) && here !== null && at === here && isTempDef(d)) n++;
        break;
      case 'FRIENDLY_GEAR':
        if (friendly && (d?.type === 'GEAR' || (d?.type === 'TOKEN' && !isUnit(d)))) n++;
        break;
      case 'BUFFED_FRIENDLY_HERE':
        if (friendly && isUnit(d) && here !== null && at === here && o.buffed) n++;
        break;
      case 'ENEMY_UNITS_HERE':
        if (!friendly && isUnit(d) && here !== null && at === here) n++;
        break;
    }
  }
  return n;
}

function applies(
  s: StaticAbility,
  sourceId: string,
  sourceController: PlayerId,
  sourceHere: string | null,
  target: CardInstance,
  targetDef: CardDef,
  mights?: { source: number; target: number },
): boolean {
  const friendly = target.controller === sourceController;
  const at = targetBattlefield(target);
  if (s.onlyKeyword && !targetDef.keywords.some((k) => k.name === s.onlyKeyword)) return false;
  if (
    s.onlySubtype &&
    !targetDef.subtypes.some((x) => x.toLowerCase() === (s.onlySubtype ?? '').toLowerCase())
  ) {
    return false;
  }
  if (s.onlyToken && targetDef.type !== 'TOKEN') return false;
  if (s.lessMight && (!mights || mights.target >= mights.source)) return false;
  switch (s.affects) {
    case 'OTHER_FRIENDLY_UNITS':
      return friendly && isUnit(targetDef) && target.id !== sourceId;
    case 'ENEMY_UNITS_HERE':
      return !friendly && isUnit(targetDef) && sourceHere !== null && at === sourceHere;
    case 'FRIENDLY_UNITS_HERE':
      return friendly && isUnit(targetDef) && sourceHere !== null && at === sourceHere;
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
  /** R74: the unit deals no combat damage. */
  noCombatDamage?: boolean;
  /** R74: enemy spells and abilities cannot choose the unit. */
  noEnemyChoose?: boolean;
  /** R88: the unit enters ready. */
  entersReady?: boolean;
  /** X7: enemy spells and abilities deal no damage to the unit. */
  noEnemyEffectDamage?: boolean;
  /** X7: a standing death replacement applies to the unit (first applicable source). */
  replaceDeath?: { sourceId: string; killSource: boolean };
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
  let noCombatDamage = false;
  let noEnemyChoose = false;
  let noEnemyEffectDamage = false;
  let entersReady = false;
  let replaceDeath: StaticBonus['replaceDeath'];
  const mightOfObj = (o: CardInstance | undefined): number =>
    baseMight(cards[o?.cardId ?? ''], o) + (o?.mightBonus ?? 0);
  const apply = (
    def: CardDef | undefined,
    sourceId: string,
    controller: PlayerId,
    here: string | null,
    when: (cond: NonNullable<StaticAbility['when']>) => boolean,
  ): void => {
    for (const s of def?.statics ?? []) {
      const mights = s.lessMight
        ? { source: mightOfObj(state.objects[sourceId]), target: mightOfObj(target) }
        : undefined;
      if (!applies(s, sourceId, controller, here, target, targetDef, mights)) continue;
      if (s.when && !when(s.when)) continue;
      if (s.unless && when(s.unless)) continue;
      if (s.per) {
        const src = state.objects[sourceId];
        const n = src ? countStatic(state, cards, src, s.per) : 0;
        might += (s.might ?? 0) * n;
        if (s.perKeyword && n > 0) keywords.push({ name: s.perKeyword, value: n });
      } else {
        might += s.might ?? 0;
      }
      if (s.restrict === 'NO_MOVE_TO_BASE') noMoveToBase = true;
      if (s.restrict === 'NO_COMBAT_DAMAGE') noCombatDamage = true;
      if (s.restrict === 'NO_ENEMY_CHOOSE') noEnemyChoose = true;
      if (s.restrict === 'NO_ENEMY_EFFECT_DAMAGE') noEnemyEffectDamage = true;
      if (s.entersReady) entersReady = true;
      if (s.replaceDeath && !s.replaceDeath.offer && !replaceDeath) {
        replaceDeath = { sourceId, killSource: s.replaceDeath.killSource === true };
      }
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
  return might === 0 &&
    keywords.length === 0 &&
    !noMoveToBase &&
    !noCombatDamage &&
    !noEnemyChoose &&
    !noEnemyEffectDamage &&
    !entersReady &&
    !replaceDeath
    ? NONE
    : {
        might,
        keywords,
        ...(noMoveToBase ? { noMoveToBase } : {}),
        ...(noCombatDamage ? { noCombatDamage } : {}),
        ...(noEnemyChoose ? { noEnemyChoose } : {}),
        ...(noEnemyEffectDamage ? { noEnemyEffectDamage } : {}),
        ...(entersReady ? { entersReady } : {}),
        ...(replaceDeath ? { replaceDeath } : {}),
      };
}

/** A standing death replacement that applies to a unit (X7). */
export interface ReplacementSource {
  sourceId: string;
  cardId: string;
  controller: PlayerId;
  ability: StaticAbility;
}

/** Every optional ("you may pay ...") standing death replacement that currently applies to `target`. */
export function optionalReplacements(
  state: GameState,
  cards: CardDatabase,
  target: CardInstance,
): ReplacementSource[] {
  const ids = staticIds(cards);
  const targetDef = cards[target.cardId];
  const found: ReplacementSource[] = [];
  if (ids.size === 0 || !targetDef) return found;
  const mightOfObj = (o: CardInstance | undefined): number =>
    baseMight(cards[o?.cardId ?? ''], o) + (o?.mightBonus ?? 0);
  const scan = (
    cardId: string,
    sourceId: string,
    controller: PlayerId,
    here: string | null,
    when: (c: NonNullable<StaticAbility['when']>) => boolean,
  ): void => {
    for (const s of cards[cardId]?.statics ?? []) {
      if (!s.replaceDeath?.offer) continue;
      const mights = s.lessMight
        ? { source: mightOfObj(state.objects[sourceId]), target: mightOfObj(target) }
        : undefined;
      if (!applies(s, sourceId, controller, here, target, targetDef, mights)) continue;
      if (s.when && !when(s.when)) continue;
      if (s.unless && when(s.unless)) continue;
      found.push({ sourceId, cardId, controller, ability: s });
    }
  };
  for (const o of Object.values(state.objects)) {
    if (!ids.has(o.cardId)) continue;
    const z = o.zone.kind;
    if (z !== 'base' && z !== 'battlefield' && z !== 'legend') continue;
    scan(o.cardId, o.id, o.controller, targetBattlefield(o), (c) =>
      evalCondition(state, cards, c, o.controller, o.id),
    );
  }
  for (const bf of state.battlefields) {
    if (!ids.has(bf.cardId)) continue;
    scan(bf.cardId, bf.id, target.controller, bf.id, (c) =>
      evalCondition(state, cards, c, target.controller, bf.id),
    );
  }
  return found;
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
