/**
 * Effect interpreter (R1, R3). Mutates the working state (caller's clone) and returns events.
 * Rule 359.3 (a spell's effects happen as it resolves, then it goes to the Trash).
 *
 * Targets: a spell's chosen objects are the `object` entries of `PLAY_CARD.targets`, in order.
 * Each targeted effect reads one slot (`slot`, default 0); an effect with `count` takes all of
 * them. `targetRequirements` derives the slots a spell needs, `spellTargetsLegal` validates a
 * choice (play.ts) and `enumerateSpellTargets` lists choices for `getLegalActions` (capped).
 */
import { countMove } from './moveCount.js';
import { applyDamageMods } from './damageMod.js';
import { fork } from './workingCopy.js';
import { burnOutIfEmpty, drawWithBurnOut } from './burnout.js';
import { effectiveMight } from './combat.js';
import { equipTotalCost, hasKeyword, removeTokenFromGame } from './keywords.js';
import { startHandChoice } from './handChoiceStart.js';
import { autoPlan, computeTotalCost, payCost } from './resources.js';
import { allocObjectId } from './setup.js';
import { hereOfSource } from './sources.js';
import { isGearDef, isUnitDef } from './tokens.js';
import { defWithGrants, staticBonus } from './statics.js';
import { evalCondition } from './conditions.js';
import { playerIndex } from './types/constants.js';
import type {
  LookTake,
  AltAmount,
  CardDatabase,
  CardDef,
  CardEffect,
  CardInstance,
  GameEventInput,
  GameState,
  PlayerId,
  Target,
  TargetedEffect,
  TargetSide,
} from './types/index.js';
import { clearBoardState } from './zoneReset.js';

/** Maximum number of target combinations offered to the AI / UI per spell. */
export const MAX_TARGET_COMBOS = 48;

type TargetKind =
  | 'unit'
  | 'gear'
  | 'unitOrGear'
  | 'spell'
  | 'equipment'
  | 'trash'
  /** X-loc: a battlefield (Target kind 'battlefield'). */
  | 'battlefield'
  /** X-loc: where a moved unit goes: a battlefield or (as 'base') its own Base. */
  | 'location';

/** The Base as a chosen location. */
export const BASE_LOCATION = 'base';

/** What a slot may hold. */
interface Spec {
  kind: TargetKind;
  side: TargetSide;
  /** Location slots: the earlier slot that holds the unit being moved, and which locations are allowed. */
  forSlot?: number;
  dest?: 'ANY' | 'BATTLEFIELD' | 'OPEN' | 'CONTROLLED' | 'ENEMY_OCCUPIED' | 'TO_OR_FROM_BASE';
  atBattlefield?: boolean;
  /** R84: the unit stands in a Base. */
  inBase?: boolean;
  /** R95: the unit is attacking in the current combat. */
  attacking?: boolean;
  /** R107: Energy limit read from the source unit's Might. */
  maxEnergyMyMight?: boolean;
  /** R106: required / forbidden subtype of the chosen unit. */
  subtype?: string;
  notSubtype?: string;
  maxMight?: number;
  /** X1: every pick must be at one battlefield. */
  sameBattlefield?: boolean;
  /** Gear only: Energy cost at most this. */
  maxEnergy?: number;
  /** R80: a countered spell's printed cost limits. */
  counterMinPower?: number;
  counterMaxEnergy?: number;
  counterMaxPower?: number;
  /** R75: a card in the controller's Trash: which kind(s) and subtype(s) qualify. */
  trashWhat?: 'unit' | 'gear' | 'unitOrGear' | 'spell';
  trashSubtypes?: string[];
  /** X5: printed-cost limits of a Trash card played by an effect. */
  trashMaxEnergy?: number;
  trashMaxPower?: number;
  /** The card is in the controller's hand instead of the Trash. */
  trashFromHand?: boolean;
  /** The Power cost of the Trash card must be payable now ("ignoring its Energy cost"). */
  trashPayPower?: boolean;
  /** R42: at the source's battlefield / not the source itself (needs the source object). */
  here?: boolean;
  another?: boolean;
}

export interface TargetReq extends Spec {
  slot: number;
  /** Count slot: takes all object targets from `slot` on (min..max). */
  count?: { min: number; max: number };
}

const num = (id: string): number => Number(id.slice(1));

const isTargeted = (e: CardEffect): e is TargetedEffect =>
  e.op === 'DAMAGE_TARGET' ||
  e.op === 'BUFF_TARGET' ||
  e.op === 'KILL_TARGET' ||
  e.op === 'READY_TARGET' ||
  e.op === 'LOCK_MOVE_TARGET' ||
  e.op === 'STUN_TARGET' ||
  e.op === 'SET_BASE_MIGHT' ||
  e.op === 'DEATH_REPLACE_TARGET' ||
  e.op === 'DAMAGE_MOD_TARGET' ||
  e.op === 'GRANT_TEMPORARY_TARGET' ||
  e.op === 'DOUBLE_MIGHT_TARGET' ||
  e.op === 'DEBUFF_TARGET' ||
  e.op === 'KILL_GEAR' ||
  e.op === 'RETURN_TARGET' ||
  e.op === 'RETURN_FROM_TRASH' ||
  e.op === 'PLAY_FROM_TRASH' ||
  e.op === 'MOVE_BASE_TARGET' ||
  e.op === 'BLINK_TARGET' ||
  e.op === 'MOVE_HERE_TARGET' ||
  e.op === 'COUNTER_SPELL' ||
  e.op === 'WEAPONMASTER_EQUIP' ||
  e.op === 'GRANT_KEYWORD_TARGET';

/** The first targeted effect of a spell, if any. */
export function targetedEffect(
  effects: readonly CardEffect[] | undefined,
): TargetedEffect | undefined {
  return effects?.find(isTargeted);
}

function specOf(e: TargetedEffect): Spec {
  const kind: TargetKind =
    e.op === 'WEAPONMASTER_EQUIP'
      ? 'equipment'
      : e.op === 'RETURN_FROM_TRASH' || e.op === 'PLAY_FROM_TRASH'
        ? 'trash'
        : e.op === 'KILL_GEAR' || (e.op === 'RETURN_TARGET' && e.gear)
          ? 'gear'
          : e.op === 'KILL_TARGET' && e.orGear
            ? 'unitOrGear'
            : e.op === 'COUNTER_SPELL'
              ? 'spell'
              : 'unit';
  const spec: Spec = {
    kind,
    side: e.op === 'WEAPONMASTER_EQUIP' ? 'friendly' : 'side' in e && e.side ? e.side : 'any',
  };
  if (e.op === 'COUNTER_SPELL') {
    if (e.minPower !== undefined) spec.counterMinPower = e.minPower;
    if (e.maxEnergy !== undefined) spec.counterMaxEnergy = e.maxEnergy;
    if (e.maxPower !== undefined) spec.counterMaxPower = e.maxPower;
  }
  if (e.op === 'GRANT_TEMPORARY_TARGET' && e.kind) spec.kind = e.kind;
  if (e.op === 'RETURN_FROM_TRASH') {
    spec.side = 'friendly';
    spec.trashWhat = e.what;
    if (e.subtypes) spec.trashSubtypes = e.subtypes;
  }
  if (e.op === 'PLAY_FROM_TRASH') {
    spec.side = 'friendly';
    spec.trashWhat = e.what ?? 'unit';
    if (e.from === 'hand') spec.trashFromHand = true;
    if (e.subtypes) spec.trashSubtypes = e.subtypes;
    if (e.maxEnergy !== undefined) spec.trashMaxEnergy = e.maxEnergy;
    if (e.maxPower !== undefined) spec.trashMaxPower = e.maxPower;
    if (e.payPower) spec.trashPayPower = true;
  }
  if ('atBattlefield' in e && e.atBattlefield) spec.atBattlefield = true;
  if ((e.op === 'DAMAGE_TARGET' || e.op === 'BUFF_TARGET') && e.inBase) spec.inBase = true;
  if (e.op === 'STUN_TARGET' && e.attacking) spec.attacking = true;
  if (e.op === 'DAMAGE_TARGET' && e.sameBattlefield) spec.sameBattlefield = true;
  if (e.op === 'KILL_GEAR' && e.maxEnergyMyMight) spec.maxEnergyMyMight = true;
  if (e.op === 'READY_TARGET' && e.subtype) spec.subtype = e.subtype;
  if (e.op === 'RETURN_TARGET' && e.notSubtype) spec.notSubtype = e.notSubtype;
  if ('here' in e && e.here) spec.here = true;
  if ('another' in e && e.another) spec.another = true;
  if (e.op === 'KILL_GEAR' && e.maxEnergy !== undefined) spec.maxEnergy = e.maxEnergy;
  if ((e.op === 'KILL_TARGET' || e.op === 'RETURN_TARGET') && e.maxMight !== undefined) {
    spec.maxMight = e.maxMight;
  }
  return spec;
}

/** The target slots a list of effects needs, ordered by slot. Empty = no targets. */
export function targetRequirements(effects: readonly CardEffect[] | undefined): TargetReq[] {
  const reqs = new Map<number, TargetReq>();
  for (const e of effects ?? []) {
    if (isTargeted(e)) {
      const slot = e.slot ?? 0;
      if (reqs.has(slot)) continue;
      const count = 'count' in e && e.count ? { count: e.count } : {};
      reqs.set(slot, { slot, ...specOf(e), ...count });
    } else if (e.op === 'PLAY_TOKEN' && e.atSlot !== undefined) {
      if (!reqs.has(e.atSlot))
        reqs.set(e.atSlot, { slot: e.atSlot, kind: 'battlefield', side: 'any' });
    } else if (e.op === 'BF_AREA') {
      const slot = e.slot ?? 0;
      if (!reqs.has(slot)) reqs.set(slot, { slot, kind: 'battlefield', side: 'any' });
    } else if (e.op === 'DAMAGE_ALL' && e.scope === 'chosen') {
      const slot = e.slot ?? 0;
      if (!reqs.has(slot)) reqs.set(slot, { slot, kind: 'battlefield', side: 'any' });
    } else if (e.op === 'MOVE_TARGET') {
      const slot = e.slot ?? 0;
      if (!reqs.has(slot)) {
        reqs.set(slot, {
          slot,
          kind: 'unit',
          side: e.side ?? 'any',
          ...(e.count ? { count: e.count } : {}),
        });
      }
      if (e.destSlot >= 0 && !reqs.has(e.destSlot)) {
        reqs.set(e.destSlot, {
          slot: e.destSlot,
          kind: 'location',
          side: 'any',
          forSlot: slot,
          dest: e.dest ?? 'ANY',
        });
      }
    } else if (e.op === 'MUTUAL_DAMAGE') {
      e.slots.forEach((slot, i) => {
        if (reqs.has(slot)) return;
        reqs.set(slot, {
          slot,
          kind: 'unit',
          side: e.sides[i] ?? 'any',
          ...(e.atBattlefield ? { atBattlefield: true } : {}),
        });
      });
    }
  }
  // R94: "It deals damage equal to its Might to ..." also needs the unit that deals the damage.
  for (const ef of effects ?? []) {
    if (ef.op === 'DAMAGE_TARGET' && ef.amountSlot !== undefined && !reqs.has(ef.amountSlot)) {
      reqs.set(ef.amountSlot, {
        slot: ef.amountSlot,
        kind: 'unit',
        side: ef.amountSlotSide ?? 'any',
      });
    }
  }
  return [...reqs.values()].sort((a, b) => a.slot - b.slot);
}

/** Weaponmaster (821): the Equip cost of `equipment` for `unit`, reduced by one Power ([A]). */
function weaponmasterCost(
  state: GameState,
  cards: CardDatabase,
  equipment: CardInstance,
  unit: CardInstance,
): ReturnType<typeof equipTotalCost> {
  return equipTotalCost(state, cards, cards[equipment.cardId] as CardDef, unit, { power: 1 });
}

function legalForSpec(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  spec: Spec,
  u: CardInstance | undefined,
  sourceId = '',
  hiddenAt?: string,
): boolean {
  if (!u) return false;
  const type = cards[u.cardId]?.type;
  // X4 (723.1.d, 563.2.c.4): a card played from face down chooses only among things at its battlefield.
  const hb =
    hiddenAt ??
    state.flow.chain.find((i) => i.sourceObjectId === sourceId && sourceId !== '')?.hiddenAt;
  if (
    hb &&
    spec.kind !== 'spell' &&
    (u.zone.kind !== 'battlefield' || u.zone.battlefieldId !== hb)
  ) {
    return false;
  }
  if (spec.kind === 'equipment') {
    // Weaponmaster: an Equipment you control, and its reduced Equip cost must be payable.
    const def = cards[u.cardId];
    const src = state.objects[sourceId];
    if (
      !def ||
      def.type !== 'GEAR' ||
      !def.subtypes.includes('Equipment') ||
      !hasKeyword(def, 'Equip') ||
      u.zone.kind !== 'base' ||
      u.controller !== controller ||
      !src ||
      src.controller !== controller ||
      !isUnitDef(cards[src.cardId]) ||
      (src.zone.kind !== 'base' && src.zone.kind !== 'battlefield')
    ) {
      return false;
    }
    return autoPlan(state, cards, controller, weaponmasterCost(state, cards, u, src)) !== null;
  }
  if (spec.kind === 'trash') {
    // R75: a card of the right kind in the controller's own Trash (tokens never reach the Trash).
    if (u.zone.kind !== (spec.trashFromHand ? 'hand' : 'trash') || u.owner !== controller)
      return false;
    const d = cards[u.cardId];
    if (!d) return false;
    const what = spec.trashWhat;
    const ok =
      what === 'spell'
        ? d.type === 'SPELL'
        : what === 'gear'
          ? d.type === 'GEAR'
          : what === 'unit'
            ? d.type === 'UNIT'
            : d.type === 'UNIT' || d.type === 'GEAR';
    if (!ok) return false;
    if (spec.trashMaxEnergy !== undefined && d.cost.energy > spec.trashMaxEnergy) return false;
    if (spec.trashMaxPower !== undefined) {
      const pw = Object.values(d.cost.power ?? {}).reduce((n, v) => n + (v ?? 0), 0);
      if (pw > spec.trashMaxPower) return false;
    }
    if (
      spec.trashPayPower &&
      autoPlan(state, cards, controller, { energy: 0, power: computeTotalCost(d).power }) === null
    ) {
      return false;
    }
    const subs = spec.trashSubtypes;
    return !subs || subs.some((s) => d.subtypes.some((x) => x.toLowerCase() === s.toLowerCase()));
  }
  if (spec.kind === 'spell') {
    const cost = cards[u.cardId]?.cost;
    const power = cost?.power ?? 0;
    return (
      type === 'SPELL' &&
      u.zone.kind === 'chain' &&
      state.flow.chain.some((i) => i.kind === 'CARD' && i.sourceObjectId === u.id) &&
      (spec.counterMinPower === undefined || power >= spec.counterMinPower) &&
      (spec.counterMaxPower === undefined || power <= spec.counterMaxPower) &&
      (spec.counterMaxEnergy === undefined || (cost?.energy ?? 0) <= spec.counterMaxEnergy)
    );
  }
  const onBoard = u.zone.kind === 'base' || u.zone.kind === 'battlefield';
  if (!onBoard) return false;
  // R74: "can't be chosen by enemy spells and abilities".
  if (u.controller !== controller && staticBonus(state, cards, u).noEnemyChoose === true) {
    return false;
  }
  if (spec.kind === 'gear') {
    if (!isGearDef(cards[u.cardId])) return false;
    if (spec.maxEnergyMyMight) {
      const src = state.objects[sourceId];
      const limit = src ? effectiveMight(state, cards, src.id, { role: null }) : 0;
      if ((cards[u.cardId]?.cost.energy ?? 0) > limit) return false;
    }
    if (spec.maxEnergy !== undefined && (cards[u.cardId]?.cost.energy ?? 0) > spec.maxEnergy) {
      return false;
    }
  } else {
    // R46: "kill a unit or gear": a gear passes the location checks of a unit, not the Might ones.
    const gearOk = spec.kind === 'unitOrGear' && isGearDef(cards[u.cardId]);
    if (!gearOk && !isUnitDef(cards[u.cardId])) return false;
    if (spec.atBattlefield && u.zone.kind !== 'battlefield') return false;
    if (spec.inBase && u.zone.kind !== 'base') return false;
    {
      const subs = (cards[u.cardId]?.subtypes ?? []).map((x) => x.toLowerCase());
      if (spec.subtype && !subs.includes(spec.subtype.toLowerCase())) return false;
      if (spec.notSubtype && subs.includes(spec.notSubtype.toLowerCase())) return false;
    }
    if (spec.attacking) {
      const cb = state.flow.combat;
      if (
        !cb ||
        u.controller !== cb.attacker ||
        u.zone.kind !== 'battlefield' ||
        u.zone.battlefieldId !== cb.battlefieldId
      ) {
        return false;
      }
    }
    if (
      !gearOk &&
      spec.maxMight !== undefined &&
      effectiveMight(state, cards, u.id, { role: null }) > spec.maxMight
    ) {
      return false;
    }
    if (spec.here) {
      // R44: "here" is the source's battlefield, or the Battlefield card's own battlefield.
      const here = hereOfSource(state, sourceId);
      if (here === null || u.zone.kind !== 'battlefield' || u.zone.battlefieldId !== here) {
        return false;
      }
    }
    if (spec.another && u.id === sourceId) return false;
  }
  if (spec.side === 'friendly') return u.controller === controller;
  if (spec.side === 'enemy') return u.controller !== controller;
  return true;
}

/** Is `u` a legal target for `e` when `controller` plays the spell? */
export function isLegalEffectTarget(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  e: TargetedEffect,
  u: CardInstance | undefined,
  sourceId = '',
): boolean {
  return legalForSpec(state, cards, controller, specOf(e), u, sourceId);
}

/**
 * X1 (559.3.d): split `total` damage among the chosen units, in the order they were chosen. Every unit needs at
 * least 1 (559.3.d.6-7), so with fewer damage than targets the units chosen last stop being targets (559.3.d.8,
 * the controller decides: here the later picks). The rest goes lethal-first in pick order; any overflow lands on
 * the last unit. UNCLEAR: a human-chosen split is not modelled (the pick order is the player's lever).
 */
function splitDamage(
  units: readonly CardInstance[],
  total: number,
  mightOf: (u: CardInstance) => number,
  damage: (u: CardInstance, amount: number) => void,
): void {
  const used = units.slice(0, Math.max(0, total));
  if (used.length === 0) return;
  const give = used.map(() => 1);
  let left = total - used.length;
  used.forEach((u, i) => {
    const room = Math.max(0, Math.max(1, mightOf(u)) - u.damage - 1);
    const extra = Math.min(left, room);
    give[i] = (give[i] as number) + extra;
    left -= extra;
  });
  if (left > 0) give[used.length - 1] = (give[used.length - 1] as number) + left;
  used.forEach((u, i) => damage(u, give[i] as number));
}

/** X1: do all of these objects stand at one and the same battlefield? */
function oneBattlefield(state: GameState, ids: readonly string[]): boolean {
  let bf: string | null = null;
  for (const id of ids) {
    const z = state.objects[id]?.zone;
    if (!z || z.kind !== 'battlefield') return false;
    if (bf !== null && bf !== z.battlefieldId) return false;
    bf = z.battlefieldId;
  }
  return true;
}

/**
 * The chosen targets as positional keys: an object id, or 'bf:<id>' for a chosen battlefield / location
 * ('bf:base' = the moved unit's own Base). Players are not slots.
 */
function objectIds(targets: readonly Target[]): string[] {
  return targets.flatMap((t) =>
    t.kind === 'object' ? [t.id] : t.kind === 'battlefield' ? ['bf:' + t.battlefieldId] : [],
  );
}

/** X-loc: is the chosen battlefield / location key legal for this slot, given the other picks? */
function legalLocation(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  spec: Spec,
  key: string | undefined,
  ids: readonly string[],
): boolean {
  if (key === undefined || !key.startsWith('bf:')) return false;
  const loc = key.slice(3);
  if (spec.kind === 'battlefield') return state.battlefields.some((b) => b.id === loc);
  const unit = spec.forSlot === undefined ? undefined : state.objects[ids[spec.forSlot] ?? ''];
  if (!unit || (unit.zone.kind !== 'base' && unit.zone.kind !== 'battlefield')) return false;
  if (loc === BASE_LOCATION) {
    return (
      unit.zone.kind === 'battlefield' && (spec.dest === 'ANY' || spec.dest === 'TO_OR_FROM_BASE')
    );
  }
  const bf = state.battlefields.find((b) => b.id === loc);
  if (!bf) return false;
  if (unit.zone.kind === 'battlefield' && unit.zone.battlefieldId === loc) return false;
  // Unforgiven: "to or from its base": a unit at a battlefield can only go to its Base.
  if (spec.dest === 'TO_OR_FROM_BASE' && unit.zone.kind === 'battlefield') return false;
  const there = Object.values(state.objects).filter(
    (o) =>
      o.zone.kind === 'battlefield' &&
      o.zone.battlefieldId === loc &&
      isUnitDef(cards[o.cardId]) &&
      o.id !== unit.id,
  );
  switch (spec.dest) {
    case 'OPEN':
      return there.length === 0;
    case 'CONTROLLED':
      return bf.controller === controller;
    case 'ENEMY_OCCUPIED':
      return there.some((o) => o.controller !== unit.controller);
    default:
      return true;
  }
}

/** Are the chosen targets a legal choice for this list of effects (355.10)? */
export function spellTargetsLegal(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  effects: readonly CardEffect[] | undefined,
  targets: readonly Target[],
  sourceId = '',
  hiddenAt?: string,
): boolean {
  const reqs = targetRequirements(effects);
  if (reqs.length === 0) return true;
  const ids = objectIds(targets);
  const seen = new Set<string>();
  for (const r of reqs) {
    if (r.kind === 'battlefield' || r.kind === 'location') {
      if (!legalLocation(state, cards, controller, r, ids[r.slot], ids)) return false;
      continue;
    }
    const picks = r.count ? ids.slice(r.slot) : ids.slice(r.slot, r.slot + 1);
    const min = r.count ? r.count.min : 1;
    const max = r.count ? r.count.max : 1;
    if (picks.length < min || picks.length > max) return false;
    if (r.sameBattlefield && !oneBattlefield(state, picks)) return false;
    for (const id of picks) {
      if (
        seen.has(id) ||
        !legalForSpec(state, cards, controller, r, state.objects[id], sourceId, hiddenAt)
      ) {
        return false;
      }
      seen.add(id);
    }
  }
  return true;
}

/**
 * Are these the targets of a triggered or activated ability (R41)? Like `spellTargetsLegal`, and no
 * more targets than the effects take, all of them objects.
 */
export function abilityTargetsLegal(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  effects: readonly CardEffect[] | undefined,
  targets: readonly Target[],
  sourceId = '',
): boolean {
  const max = targetRequirements(effects).reduce((n, r) => n + (r.count ? r.count.max : 1), 0);
  if (targets.length > max || targets.some((t) => t.kind === 'player')) return false;
  return spellTargetsLegal(state, cards, controller, effects, targets, sourceId);
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  const rec = (start: number, acc: T[]): void => {
    if (out.length >= MAX_TARGET_COMBOS) return;
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i] as T);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}

/**
 * Target choices for `getLegalActions`: null when the effects need no target; otherwise a list
 * (possibly empty = unplayable) capped at MAX_TARGET_COMBOS. "Up to N" slots enumerate 1..N
 * targets (choosing none is legal but never useful).
 */
export function enumerateSpellTargets(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  effects: readonly CardEffect[] | undefined,
  sourceId = '',
  opts: { allowNone?: boolean; hiddenAt?: string } = {},
): Target[][] | null {
  const reqs = targetRequirements(effects);
  if (reqs.length === 0) return null;
  const all = Object.values(state.objects).sort((a, b) => num(a.id) - num(b.id));
  const options = reqs.map((r) => {
    if (r.kind === 'battlefield' || r.kind === 'location') {
      const keys = state.battlefields.map((b) => ['bf:' + b.id]);
      return r.kind === 'location' ? [...keys, ['bf:' + BASE_LOCATION]] : keys;
    }
    const cand = all
      .filter((o) => legalForSpec(state, cards, controller, r, o, sourceId, opts.hiddenAt))
      .map((o) => o.id);
    if (!r.count) return cand.map((id) => [id]);
    const out: string[][] = [];
    for (let k = Math.max(1, r.count.min); k <= r.count.max; k++) {
      if (cand.length >= k) {
        out.push(
          ...combinations(cand, k).filter((c) => !r.sameBattlefield || oneBattlefield(state, c)),
        );
      }
    }
    return out;
  });
  let acc: string[][] = [[]];
  for (const [oi, opt] of options.entries()) {
    const next: string[][] = [];
    const req = reqs[oi] as TargetReq;
    for (const prefix of acc) {
      for (const choice of opt) {
        if (choice.some((id) => prefix.includes(id))) continue;
        if (
          req.kind === 'location' &&
          !legalLocation(state, cards, controller, req, choice[0], prefix)
        ) {
          continue;
        }
        next.push([...prefix, ...choice]);
        if (next.length >= MAX_TARGET_COMBOS) break;
      }
      if (next.length >= MAX_TARGET_COMBOS) break;
    }
    acc = next;
  }
  // R42 "you may": when every slot is optional, choosing nothing (declining) is a legal answer. With
  // no legal target at all the ability is skipped, so there is nothing to decline.
  if (opts.allowNone && reqs.every((r) => r.count !== undefined && r.count.min === 0)) {
    if (acc.length === 0) {
      // Nothing to choose: the ability still resolves when it has effects that need no target (Bomb).
      return (effects ?? []).some((x) => !isTargeted(x)) ? [[]] : [];
    }
    acc.push([]);
  }
  return acc.map((ids) =>
    ids.map((id): Target =>
      id.startsWith('bf:')
        ? { kind: 'battlefield', battlefieldId: id.slice(3) }
        : { kind: 'object', id },
    ),
  );
}

/** Units (and tokens) on the board, in object order. */
function boardUnits(state: GameState, cards: CardDatabase): CardInstance[] {
  return Object.values(state.objects)
    .filter(
      (o) =>
        (o.zone.kind === 'base' || o.zone.kind === 'battlefield') && isUnitDef(cards[o.cardId]),
    )
    .sort((a, b) => num(a.id) - num(b.id));
}

const sideMatches = (side: TargetSide, controller: PlayerId, o: CardInstance): boolean =>
  side === 'any' ||
  (side === 'friendly' ? o.controller === controller : o.controller !== controller);

/** Channel up to `n` runes (431); exhausted when asked. Returns events and how many were channeled. */
function channelRunes(
  state: GameState,
  player: PlayerId,
  n: number,
  exhausted: boolean,
): { events: GameEventInput[]; channeled: number } {
  const ps = state.players[playerIndex(player)];
  const events: GameEventInput[] = [];
  let channeled = 0;
  for (let i = 0; i < n; i++) {
    const id = ps.runeDeck.shift();
    if (id === undefined) break;
    const rune = state.objects[id] as CardInstance;
    rune.zone = { kind: 'base', player };
    rune.ready = !exhausted;
    rune.enteredTurn = state.turn.number;
    ps.base.push(id);
    events.push({ type: 'RUNE_CHANNELED', player, runeId: id });
    channeled++;
  }
  return { events, channeled };
}

/** Remove a countered spell from the Chain and put it in its owner's Trash. */
function counterSpell(state: GameState, spell: CardInstance): void {
  state.flow.chain = state.flow.chain.filter(
    (i) => !(i.kind === 'CARD' && i.sourceObjectId === spell.id),
  );
  const owner = state.players[playerIndex(spell.owner)];
  if (!owner.trash.includes(spell.id)) owner.trash.push(spell.id);
  spell.zone = { kind: 'trash', player: spell.owner };
}

/** Kill a gear: to its owner's Trash, Equipment detached (mutates). */
export function killGear(state: GameState, g: CardInstance): void {
  const ps = state.players[playerIndex(g.controller)];
  ps.base = ps.base.filter((x) => x !== g.id);
  if (isTokenInstance(g)) {
    removeTokenFromGame(state, g.id); // 186.1
    return;
  }
  const owner = state.players[playerIndex(g.owner)];
  owner.trash.push(g.id);
  g.zone = { kind: 'trash', player: g.owner };
  g.controller = g.owner;
  g.ready = false;
  clearBoardState(g);
}

/** Return a unit or gear to its owner's hand (a token ceases to exist, 186.1). Mutates. */
export function returnToHand(state: GameState, o: CardInstance, out: GameEventInput[]): void {
  const player = o.owner;
  const cardId = o.cardId;
  const ps = state.players[playerIndex(o.controller)];
  ps.base = ps.base.filter((x) => x !== o.id);
  for (const g of Object.values(state.objects)) if (g.attachedTo === o.id) delete g.attachedTo;
  out.push({ type: 'UNIT_RETURNED', player, unitId: o.id, cardId });
  if (state.objects[o.id] && isTokenInstance(o)) {
    removeTokenFromGame(state, o.id);
    return;
  }
  o.zone = { kind: 'hand', player };
  o.controller = o.owner;
  o.ready = false;
  o.damage = 0;
  o.mightBonus = 0;
  delete o.tempMight;
  delete o.tempKeywords;
  delete o.stunned;
  delete o.empowered;
  delete o.buffed;
  delete o.attachedTo;
  state.players[playerIndex(player)].hand.push(o.id);
}

/** Tokens are the only objects whose card id is in the built-in token table (tokens.ts). */
const isTokenInstance = (o: CardInstance): boolean => o.cardId.startsWith('tok-');

/** Move a unit from a battlefield to its controller's Base (not a standard move). Mutates. */
function moveToBase(state: GameState, o: CardInstance, out: GameEventInput[]): void {
  if (o.zone.kind !== 'battlefield') return;
  const from = o.zone.battlefieldId;
  o.zone = { kind: 'base', player: o.controller };
  state.players[playerIndex(o.controller)].base.push(o.id);
  out.push({ type: 'UNIT_MOVED', unitId: o.id, from, to: 'base' });
}

/** R79: move a unit from wherever it stands to battlefield `dest` (an effect move, not a standard move). Mutates. */
function moveHere(
  state: GameState,
  cards: CardDatabase,
  o: CardInstance,
  dest: string,
  out: GameEventInput[],
): void {
  if (o.zone.kind === 'battlefield' && o.zone.battlefieldId === dest) return;
  const from = o.zone.kind === 'battlefield' ? o.zone.battlefieldId : 'base';
  const ps = state.players[playerIndex(o.controller)];
  ps.base = ps.base.filter((x) => x !== o.id);
  o.zone = { kind: 'battlefield', player: o.controller, battlefieldId: dest };
  countMove(state, cards, o);
  out.push({ type: 'UNIT_MOVED', unitId: o.id, from, to: dest });
}

/** "Look at the top N cards ... take one ... recycle the rest" (deterministic choice). Mutates. */
function lookAtTop(
  state: GameState,
  player: PlayerId,
  count: number,
  take: LookTake | undefined,
  cards: CardDatabase,
  rest: 'RECYCLE' | 'TRASH' = 'RECYCLE',
): GameEventInput[] {
  const out: GameEventInput[] = burnOutIfEmpty(state, player, cards);
  if (state.gameStatus !== 'IN_PROGRESS') return out;
  const ps = state.players[playerIndex(player)];
  const ids = ps.mainDeck.splice(0, count);
  out.push({ type: 'CARDS_LOOKED_AT', player, count: ids.length });
  let pick: string | undefined;
  if (take) {
    const wants: string[] | undefined =
      take.filter === 'unit'
        ? ['UNIT']
        : take.filter === 'gear'
          ? ['GEAR']
          : take.filter === 'spell'
            ? ['SPELL']
            : take.filter === 'unitOrGear'
              ? ['UNIT', 'GEAR']
              : undefined;
    const restricted =
      wants !== undefined ||
      take.maxEnergy !== undefined ||
      take.minEnergy !== undefined ||
      take.maxPower !== undefined;
    const cand = ids.filter((id) => {
      const d = cards[(state.objects[id] as CardInstance).cardId];
      if (!d) return false;
      if (wants && !wants.includes(d.type)) return false;
      if (take.maxEnergy !== undefined && d.cost.energy > take.maxEnergy) return false;
      if (take.minEnergy !== undefined && d.cost.energy < take.minEnergy) return false;
      if (take.maxPower !== undefined && (d.cost.power ?? 0) > take.maxPower) return false;
      return true;
    });
    // Unrestricted: the most expensive card (first on ties); restricted: the first match.
    const energy = (id: string): number =>
      cards[(state.objects[id] as CardInstance).cardId]?.cost.energy ?? 0;
    pick = restricted
      ? cand[0]
      : cand.reduce<string | undefined>(
          (b, id) => (b === undefined || energy(id) > energy(b) ? id : b),
          undefined,
        );
  }
  if (pick !== undefined) {
    const o = state.objects[pick] as CardInstance;
    if (take?.reveal)
      out.push({ type: 'CARD_REVEALED', player, cardInstanceId: pick, cardId: o.cardId });
    o.zone = { kind: 'hand', player };
    ps.hand.push(pick);
    out.push({ type: 'CARD_DRAWN', player, cardInstanceId: pick, visibleTo: [player] });
  }
  const others = ids.filter((id) => id !== pick);
  if (rest === 'TRASH') {
    for (const id of others) {
      ps.trash.push(id);
      (state.objects[id] as CardInstance).zone = { kind: 'trash', player };
    }
  } else {
    ps.mainDeck.push(...others);
    if (others.length > 0) out.push({ type: 'CARDS_RECYCLED', player, count: others.length });
  }
  return out;
}

/** Play `count` tokens for `controller` (Base, or the source's battlefield with `here`). Mutates. */
function playTokens(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  token: string,
  count: number,
  opts: { ready?: boolean; here?: boolean; at?: string },
  sourceObjectId: string,
  out: GameEventInput[],
): void {
  const here = opts.at ?? (opts.here ? hereOfSource(state, sourceObjectId) : null);
  for (let i = 0; i < count; i++) {
    const id = allocObjectId(state);
    const zone: CardInstance['zone'] =
      here !== null
        ? { kind: 'battlefield', player: controller, battlefieldId: here }
        : { kind: 'base', player: controller };
    state.objects[id] = {
      id,
      cardId: token,
      owner: controller,
      controller,
      zone,
      ready: opts.ready === true,
      damage: 0,
      mightBonus: 0,
      enteredTurn: state.turn.number,
    };
    if (zone.kind === 'base') state.players[playerIndex(controller)].base.push(id);
    // R88: "Your tokens enter ready".
    if (
      staticBonus(state, cards, state.objects[id]).entersReady === true ||
      state.players[playerIndex(controller)]?.enterReadyTurn === state.turn.number
    ) {
      (state.objects[id] as CardInstance).ready = true;
    }
    out.push({ type: 'TOKEN_PLAYED', player: controller, unitId: id, cardId: token });
  }
}

/** The effects a spell runs: the chosen mode of a modal spell (R59), else its plain effects. */
export function spellEffects(def: CardDef, mode?: number): CardEffect[] | undefined {
  if (def.modes) return mode === undefined ? undefined : def.modes[mode];
  return def.effects;
}

export function runEffects(
  state: GameState,
  controller: PlayerId,
  effects: readonly CardEffect[],
  cards: CardDatabase,
  targets: readonly Target[] = [],
  sourceCardId = '',
  sourceObjectId = '',
): GameEventInput[] {
  const out: GameEventInput[] = [];
  const ids = objectIds(targets);
  /** Slots whose effect succeeded, with the controller the object had when it was killed. */
  const doneSlots = new Map<number, PlayerId>();
  const fizzle = (): void => {
    out.push({ type: 'EFFECT_FIZZLED', cardId: sourceCardId });
  };
  const damage = (u: CardInstance, amount: number): void => {
    const dealt = applyDamageMods(state, cards, u, amount, { kind: 'EFFECT', controller });
    if (dealt < amount)
      out.push({ type: 'DAMAGE_PREVENTED', unitId: u.id, amount: amount - dealt });
    if (dealt <= 0) return;
    u.damage += dealt;
    out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: dealt });
  };
  const mightOf = (u: CardInstance): number => effectiveMight(state, cards, u.id, { role: null });
  /** R74: damage that depends on the source ("equal to my Might"). */
  const damageAmount = (e: {
    amount: number;
    amountFrom?: string;
    amountSlot?: number;
  }): number => {
    if (!e.amountFrom) return e.amount;
    if (e.amountFrom === 'SLOT_MIGHT') {
      const id = e.amountSlot === undefined ? undefined : ids[e.amountSlot];
      // X3 (563.2.c.8): information about a target that is no longer on the Board reads zero.
      const tgt = id ? state.objects[id] : undefined;
      return id && tgt && (tgt.zone.kind === 'base' || tgt.zone.kind === 'battlefield')
        ? Math.max(0, effectiveMight(state, cards, id, { role: null }))
        : 0;
    }
    if (e.amountFrom === 'EXCESS') {
      const rec = state.players[playerIndex(controller)].excessRecord;
      return rec && rec.turn === state.turn.number ? rec.amount : 0;
    }
    const src = state.objects[sourceObjectId];
    if (!src) return 0;
    if (e.amountFrom === 'MY_MIGHT') {
      return Math.max(0, effectiveMight(state, cards, src.id, { role: null }));
    }
    const kw = defWithGrants(state, cards, src)?.keywords.filter(
      (k) => k.name === (e.amountFrom === 'MY_ASSAULT' ? 'Assault' : 'Shield'),
    );
    return (kw ?? []).reduce((n, k) => n + (k.value ?? 1), 0);
  };
  /** R81: does the "... instead" alternative of `e` apply to target `u`? */
  const altApplies = (alt: AltAmount | undefined, u: CardInstance): alt is AltAmount => {
    if (!alt) return false;
    if (alt.when && !evalCondition(state, cards, alt.when, controller, sourceObjectId))
      return false;
    if (alt.target === 'EMPOWERED' && !u.empowered) return false;
    if (alt.target === 'BUFFED' && !u.buffed) return false;
    if (alt.target === 'ATTACKING') {
      const c = state.flow.combat;
      if (
        !c ||
        c.attacker !== u.controller ||
        u.zone.kind !== 'battlefield' ||
        u.zone.battlefieldId !== c.battlefieldId
      ) {
        return false;
      }
    }
    return true;
  };
  const addTemp = (u: CardInstance, amount: number, temp: boolean): void => {
    u.mightBonus += amount;
    if (temp) u.tempMight = (u.tempMight ?? 0) + amount;
    out.push({ type: 'EFFECT_BUFF', unitId: u.id, amount });
  };

  for (const e of effects) {
    if (state.gameStatus !== 'IN_PROGRESS') break;
    switch (e.op) {
      case 'DRAW': {
        // R44: "draw 1 for each other battlefield you control" (the source's own battlefield is excluded).
        const here = hereOfSource(state, sourceObjectId);
        const n = e.per
          ? e.amount *
            (e.per === 'BATTLEFIELD'
              ? state.battlefields.filter((b) => b.controller === controller).length
              : Object.values(state.objects).filter(
                  (o) =>
                    o.controller === controller &&
                    (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
                    cards[o.cardId]?.type === 'UNIT' &&
                    mightOf(o) >= 5,
                ).length)
          : e.perOtherBattlefield
            ? e.amount *
              state.battlefields.filter((b) => b.controller === controller && b.id !== here).length
            : e.amount;
        if (n > 0) {
          const who: PlayerId[] = e.eachPlayer
            ? [controller, controller === 'p0' ? 'p1' : 'p0']
            : [controller];
          for (const p of who) out.push(...drawWithBurnOut(state, p, n, cards));
        }
        break;
      }
      case 'BURN': {
        // R44: the top cards of the Main Deck go to the Trash. X8: an EMPTY deck burns out first (607.1.c);
        // having fewer cards than asked for is not a Burn Out.
        out.push(...burnOutIfEmpty(state, controller, cards));
        if (state.gameStatus !== 'IN_PROGRESS') break;
        const ps = state.players[playerIndex(controller)];
        const milled = ps.mainDeck.splice(0, e.amount);
        for (const id of milled) {
          const o = state.objects[id];
          if (o) o.zone = { kind: 'trash', player: o.owner };
          ps.trash.push(id);
        }
        out.push({ type: 'CARDS_BURNED', player: controller, count: milled.length });
        break;
      }
      case 'BUFF_SELF': {
        // R45: the source unit gets +N Might this turn (nothing when it is no longer on the board).
        const src = state.objects[sourceObjectId];
        if (src && (src.zone.kind === 'base' || src.zone.kind === 'battlefield')) {
          if (e.buff) {
            if (!src.buffed) {
              src.buffed = true;
              out.push({ type: 'EFFECT_BUFF', unitId: src.id, amount: 1 });
            }
          } else addTemp(src, e.amount, true);
        }
        break;
      }
      case 'PREDICT': {
        // R55: keep a card on top only when it is playable soon: Energy cost at most (runes + 2).
        out.push(...burnOutIfEmpty(state, controller, cards));
        if (state.gameStatus !== 'IN_PROGRESS') break;
        const ps = state.players[playerIndex(controller)] as GameState['players'][number];
        const ids = ps.mainDeck.splice(0, e.count);
        out.push({ type: 'CARDS_LOOKED_AT', player: controller, count: ids.length });
        const runes = Object.values(state.objects).filter(
          (o) =>
            o.controller === controller &&
            o.zone.kind === 'base' &&
            cards[o.cardId]?.type === 'RUNE',
        ).length;
        const costOf = (id: string): number =>
          cards[(state.objects[id] as CardInstance).cardId]?.cost.energy ?? 0;
        const keep = ids.filter((id) => costOf(id) <= runes + 2);
        const recycle = ids.filter((id) => costOf(id) > runes + 2);
        ps.mainDeck.unshift(...keep);
        ps.mainDeck.push(...recycle);
        if (recycle.length > 0)
          out.push({ type: 'CARDS_RECYCLED', player: controller, count: recycle.length });
        break;
      }
      case 'GAIN_XP': {
        const n = e.perFriendlyUnit
          ? e.amount *
            Object.values(state.objects).filter(
              (o) =>
                o.controller === controller &&
                (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
                cards[o.cardId]?.type === 'UNIT',
            ).length
          : e.amount;
        if (n > 0) {
          const ps = state.players[playerIndex(controller)] as GameState['players'][number];
          ps.xp = (ps.xp ?? 0) + n;
          out.push({ type: 'XP_GAINED', player: controller, amount: n });
        }
        break;
      }
      case 'RETURN_SELF': {
        const src = state.objects[sourceObjectId];
        if (src && (src.zone.kind === 'base' || src.zone.kind === 'battlefield')) {
          returnToHand(state, src, out);
        }
        break;
      }
      case 'EMPOWER_SELF': {
        const src = state.objects[sourceObjectId];
        if (
          src &&
          !src.empowered &&
          (src.zone.kind === 'base' || src.zone.kind === 'battlefield')
        ) {
          src.empowered = true;
          out.push({ type: 'EFFECT_EMPOWERED', unitId: src.id });
        }
        break;
      }
      case 'READY_SELF': {
        const src = state.objects[sourceObjectId];
        if (src && !src.ready && (src.zone.kind === 'base' || src.zone.kind === 'battlefield')) {
          src.ready = true;
          out.push({ type: 'EFFECT_READIED', unitId: src.id });
        }
        break;
      }
      case 'READY_LEGEND': {
        const legend = state.players[playerIndex(controller)].legend;
        const lo = legend ? state.objects[legend] : undefined;
        if (lo && !lo.ready) {
          lo.ready = true;
          out.push({ type: 'EFFECT_READIED', unitId: lo.id });
        }
        break;
      }
      case 'EXTRA_TURN':
        state.extraTurnFor = controller;
        break;
      case 'DISCARD_HAND': {
        for (const p of e.eachPlayer ? (['p0', 'p1'] as const) : [controller]) {
          const ps = state.players[playerIndex(p)];
          const ids = [...ps.hand];
          for (const id of ids) {
            const o = state.objects[id];
            if (o) o.zone = { kind: 'trash', player: o.owner };
            ps.trash.push(id);
          }
          ps.hand = [];
          if (ids.length > 0) {
            out.push({
              type: 'HAND_DISCARDED',
              player: p,
              cardIds: ids,
              cardNames: ids.map((id) => cards[state.objects[id]?.cardId ?? '']?.name ?? 'a card'),
            });
          }
        }
        break;
      }
      case 'KILL_SELF': {
        const me = state.objects[sourceObjectId];
        if (!me || (me.zone.kind !== 'base' && me.zone.kind !== 'battlefield')) break;
        if (isUnitDef(cards[me.cardId])) {
          me.damage = Math.max(me.damage, 9999); // lethal: the next Cleanup kills it
        } else {
          killGear(state, me);
          out.push({ type: 'GEAR_KILLED', gearId: me.id });
        }
        break;
      }
      case 'PLAY_SELF': {
        const me = state.objects[sourceObjectId];
        if (!me || me.zone.kind !== 'trash') {
          fizzle();
          break;
        }
        const ps = state.players[playerIndex(me.owner)];
        ps.trash = ps.trash.filter((x) => x !== me.id);
        me.zone = { kind: 'base', player: me.owner };
        me.controller = me.owner;
        me.enteredTurn = state.turn.number;
        me.ready =
          staticBonus(state, cards, me).entersReady === true ||
          ps.enterReadyTurn === state.turn.number;
        ps.base.push(me.id);
        const same = ps.playedThisTurn?.turn === state.turn.number;
        ps.playedThisTurn = {
          turn: state.turn.number,
          objectIds: [...(same ? (ps.playedThisTurn?.objectIds ?? []) : []), me.id],
        };
        out.push({
          type: 'CARD_PLAYED',
          player: me.owner,
          cardInstanceId: me.id,
          cardId: me.cardId,
        });
        break;
      }
      case 'BANISH_THIS_SPELL':
        break; // applied when the spell finishes resolving (play.ts)
      case 'PREVENT_EFFECT_DAMAGE_TURN':
        state.noEffectDamageTurn = state.turn.number;
        break;
      case 'WIN_GAME':
        state.gameStatus = 'FINISHED';
        state.winner = controller;
        out.push({ type: 'GAME_ENDED', winner: controller });
        break;
      case 'BF_AREA': {
        const key = ids[e.slot ?? 0];
        const bfId = key?.startsWith('bf:') ? key.slice(3) : undefined;
        if (!bfId || !state.battlefields.some((b) => b.id === bfId)) {
          fizzle();
          break;
        }
        for (const u of boardUnits(state, cards)) {
          if (u.zone.kind !== 'battlefield' || u.zone.battlefieldId !== bfId) continue;
          if (u.controller === controller) {
            if (e.friendlyMight) addTemp(u, e.friendlyMight, true);
            if (e.keywords) {
              u.tempKeywords = [...(u.tempKeywords ?? []), ...e.keywords.map((k) => ({ ...k }))];
              out.push({ type: 'EFFECT_KEYWORD_GRANTED', unitId: u.id });
            }
          } else if (e.enemyMight) {
            const room = e.minMight === undefined ? e.enemyMight : mightOf(u) - e.minMight;
            const cut = Math.max(0, Math.min(e.enemyMight, room));
            if (cut > 0) addTemp(u, -cut, true);
          }
        }
        break;
      }
      case 'MOVE_TARGET': {
        const slot = e.slot ?? 0;
        if (e.count && e.count.min === 0 && ids[slot] === undefined) break; // "you may": chose no unit
        const unit = state.objects[ids[slot] ?? ''];
        // "... to that enemy unit's battlefield": where the unit in another slot stands now.
        const from =
          e.destFromSlot === undefined ? undefined : state.objects[ids[e.destFromSlot] ?? ''];
        const key =
          e.destFromSlot === undefined
            ? ids[e.destSlot]
            : from?.zone.kind === 'battlefield'
              ? 'bf:' + from.zone.battlefieldId
              : undefined;
        const spec: Spec = { kind: 'location', side: 'any', forSlot: slot, dest: e.dest ?? 'ANY' };
        if (
          !unit ||
          !isLegalEffectTarget(
            state,
            cards,
            controller,
            { op: 'KILL_TARGET', slot, ...(e.side ? { side: e.side } : {}) },
            unit,
            sourceObjectId,
          ) ||
          !legalLocation(state, cards, controller, spec, key, ids)
        ) {
          fizzle();
          break;
        }
        const loc = (key as string).slice(3);
        if (loc === BASE_LOCATION) {
          moveToBase(state, unit, out);
        } else {
          moveHere(state, cards, unit, loc, out);
          const bf = state.battlefields.find((b) => b.id === loc);
          // 190.3, 452: a unit arriving at a battlefield its owner does not control contests it.
          if (bf && bf.controller !== unit.controller) bf.contestedBy = unit.controller;
        }
        if (e.ready) {
          unit.ready = true;
        }
        break;
      }
      case 'DAMAGE_TARGET':
      case 'BUFF_TARGET':
      case 'KILL_TARGET':
      case 'READY_TARGET':
      case 'LOCK_MOVE_TARGET':
      case 'STUN_TARGET':
      case 'SET_BASE_MIGHT':
      case 'DEATH_REPLACE_TARGET':
      case 'DAMAGE_MOD_TARGET':
      case 'GRANT_TEMPORARY_TARGET':
      case 'DOUBLE_MIGHT_TARGET':
      case 'DEBUFF_TARGET':
      case 'KILL_GEAR':
      case 'RETURN_TARGET':
      case 'RETURN_FROM_TRASH':
      case 'PLAY_FROM_TRASH':
      case 'MOVE_BASE_TARGET':
      case 'BLINK_TARGET':
      case 'MOVE_HERE_TARGET':
      case 'COUNTER_SPELL':
      case 'GRANT_KEYWORD_TARGET': {
        const slot = e.slot ?? 0;
        const count = 'count' in e ? e.count : undefined;
        const picks = count ? ids.slice(slot) : ids.slice(slot, slot + 1);
        if (picks.length === 0 && count && count.min === 0) break; // "up to": chose none
        // Targets must still be legal; those that are not are skipped. If none is, fizzle.
        const legal = picks
          .map((id) => state.objects[id])
          .filter((u): u is CardInstance =>
            isLegalEffectTarget(state, cards, controller, e, u, sourceObjectId),
          );
        if (legal.length === 0) {
          fizzle();
          break;
        }
        if (e.op === 'DAMAGE_TARGET' && e.split) {
          splitDamage(legal, damageAmount(e), mightOf, damage);
          break;
        }
        for (const u of legal) {
          if (e.op === 'DAMAGE_TARGET') {
            damage(u, altApplies(e.alt, u) ? e.alt.amount : damageAmount(e));
          } else if (e.op === 'KILL_TARGET' && isGearDef(cards[u.cardId])) {
            // R46: "kill a unit or gear" chose a gear.
            doneSlots.set(slot, u.controller);
            killGear(state, u);
            out.push({ type: 'GEAR_KILLED', gearId: u.id });
          } else if (e.op === 'KILL_TARGET') {
            // Lethal damage: Cleanup (323) then moves it to the Trash.
            const lethal = Math.max(1, mightOf(u)) - u.damage;
            if (lethal > 0) u.damage += lethal;
            out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: Math.max(lethal, 0) });
            doneSlots.set(slot, u.controller);
          } else if (e.op === 'LOCK_MOVE_TARGET') {
            u.cantMove = true;
          } else if (e.op === 'READY_TARGET') {
            u.ready = true;
            out.push({ type: 'EFFECT_READIED', unitId: u.id });
          } else if (e.op === 'GRANT_TEMPORARY_TARGET') {
            u.temporaryOf = u.enteredTurn ?? state.turn.number;
            if (u.enteredTurn === undefined) u.enteredTurn = state.turn.number;
            out.push({ type: 'EFFECT_KEYWORD_GRANTED', unitId: u.id });
          } else if (e.op === 'DOUBLE_MIGHT_TARGET') {
            addTemp(u, Math.max(0, mightOf(u)), true);
          } else if (e.op === 'DAMAGE_MOD_TARGET') {
            const m = (u.dmgMod ??= {});
            if (e.mod === 'PREVENT_NEXT') m.preventNext = true;
            else if (e.mod === 'DOUBLE') m.double = true;
            else m.prevent = (m.prevent ?? 0) + (e.amount ?? 0);
          } else if (e.op === 'DEATH_REPLACE_TARGET') {
            // X7 (575): several replacements on one event are ordered by the unit's owner; Recall keeps the
            // unit, so it is the owner's better pick over Banish (assumption, ASSUMPTIONS.md X7).
            if (e.offer) u.deathOffer = { cost: e.offer, cardId: sourceCardId };
            else if (!(u.deathReplace === 'RECALL' && e.mode === 'BANISH')) u.deathReplace = e.mode;
          } else if (e.op === 'SET_BASE_MIGHT') {
            // X2 (637.1.a.1, 639.1): assigned in the first layer; the newest assignment replaces older ones
            // and later +/- arithmetic still applies on top.
            u.baseMightSet = e.amount;
          } else if (e.op === 'STUN_TARGET') {
            // X9 (599.1.a.1): a stunned unit cannot be stunned again, so nothing happens (and nothing triggers).
            if (u.stunned) {
              if (e.orReturn) {
                doneSlots.set(slot, u.owner);
                returnToHand(state, u, out);
              }
              continue;
            }
            u.stunned = true;
            out.push({ type: 'EFFECT_STUNNED', unitId: u.id, by: controller });
          } else if (e.op === 'DEBUFF_TARGET') {
            const total = e.timesExhausted
              ? e.amount *
                Object.values(state.objects).filter(
                  (o) =>
                    o.controller === controller &&
                    !o.ready &&
                    (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
                    isUnitDef(cards[o.cardId]),
                ).length
              : e.amount;
            const room = e.minMight === undefined ? total : mightOf(u) - e.minMight;
            const cut = Math.max(0, Math.min(total, room));
            if (cut > 0) addTemp(u, -cut, true);
          } else if (e.op === 'KILL_GEAR') {
            doneSlots.set(slot, u.controller);
            killGear(state, u);
            out.push({ type: 'GEAR_KILLED', gearId: u.id });
          } else if (e.op === 'RETURN_FROM_TRASH') {
            // R75: the Trash card goes to its owner's hand.
            const ps = state.players[playerIndex(u.owner)];
            ps.trash = ps.trash.filter((x) => x !== u.id);
            u.zone = { kind: 'hand', player: u.owner };
            ps.hand.push(u.id);
          } else if (e.op === 'PLAY_FROM_TRASH') {
            // X5 (560.1.a, 595.3): played by an effect with every cost set to zero ("ignoring its cost"), or with only the
            // Energy cost set to zero ("ignoring its Energy cost"): the Power cost is paid first, with the automatic plan.
            if (e.payPower) {
              const total = {
                energy: 0,
                power: computeTotalCost(cards[u.cardId] as CardDef).power,
              };
              const plan = autoPlan(state, cards, controller, total);
              const paid = plan === null ? null : payCost(state, cards, controller, total, plan);
              if (!paid || !paid.ok) {
                fizzle();
                continue;
              }
              if (paid.state !== state) {
                // Take over the payment's changes without replacing objects this loop already holds.
                state.players = paid.state.players;
                for (const r of plan ?? []) {
                  const rune = paid.state.objects[r.runeId];
                  if (rune) state.objects[r.runeId] = rune;
                }
              }
            }
            const ps = state.players[playerIndex(u.owner)];
            ps.trash = ps.trash.filter((x) => x !== u.id);
            ps.hand = ps.hand.filter((x) => x !== u.id);
            u.zone = { kind: 'base', player: u.owner };
            u.controller = u.owner;
            u.damage = 0;
            u.mightBonus = 0;
            u.enteredTurn = state.turn.number;
            u.ready =
              cards[u.cardId]?.type === 'GEAR'
                ? cards[u.cardId]?.entersExhausted !== true
                : staticBonus(state, cards, u).entersReady === true ||
                  ps.enterReadyTurn === state.turn.number;
            ps.base.push(u.id);
            const sameTurn = ps.playedThisTurn?.turn === state.turn.number;
            ps.playedThisTurn = {
              turn: state.turn.number,
              objectIds: [...(sameTurn ? (ps.playedThisTurn?.objectIds ?? []) : []), u.id],
            };
            out.push({
              type: 'CARD_PLAYED',
              player: u.owner,
              cardInstanceId: u.id,
              cardId: u.cardId,
            });
          } else if (e.op === 'RETURN_TARGET') {
            doneSlots.set(slot, u.owner);
            returnToHand(state, u, out);
          } else if (e.op === 'MOVE_HERE_TARGET') {
            const dest = hereOfSource(state, sourceObjectId);
            if (dest === null) {
              fizzle();
              break;
            }
            moveHere(state, cards, u, dest, out);
          } else if (e.op === 'BLINK_TARGET') {
            doneSlots.set(slot, u.owner);
            const was = u.zone;
            const holder = state.players[playerIndex(u.controller)];
            holder.base = holder.base.filter((x) => x !== u.id);
            for (const g of Object.values(state.objects))
              if (g.attachedTo === u.id) delete g.attachedTo;
            if (isTokenInstance(u)) {
              removeTokenFromGame(state, u.id); // 186.1: a token is not a card; it ceases to exist
              continue;
            }
            clearBoardState(u);
            u.controller = u.owner;
            const ps = state.players[playerIndex(u.owner)];
            u.zone =
              e.to === 'SAME' && was.kind === 'battlefield'
                ? { kind: 'battlefield', player: u.owner, battlefieldId: was.battlefieldId }
                : { kind: 'base', player: u.owner };
            if (u.zone.kind === 'base') ps.base.push(u.id);
            u.enteredTurn = state.turn.number;
            u.ready =
              staticBonus(state, cards, u).entersReady === true ||
              ps.enterReadyTurn === state.turn.number;
            const sameTurn = ps.playedThisTurn?.turn === state.turn.number;
            ps.playedThisTurn = {
              turn: state.turn.number,
              objectIds: [...(sameTurn ? (ps.playedThisTurn?.objectIds ?? []) : []), u.id],
            };
            out.push({
              type: 'CARD_PLAYED',
              player: u.owner,
              cardInstanceId: u.id,
              cardId: u.cardId,
            });
          } else if (e.op === 'MOVE_BASE_TARGET') {
            moveToBase(state, u, out);
          } else if (e.op === 'GRANT_KEYWORD_TARGET') {
            const given = e.valueFromMight
              ? e.keywords.map((k) => ({ ...k, value: Math.max(1, mightOf(u)) }))
              : e.keywords.map((k) => ({ ...k }));
            u.tempKeywords = [...(u.tempKeywords ?? []), ...given];
            out.push({ type: 'EFFECT_KEYWORD_GRANTED', unitId: u.id });
          } else if (e.op === 'COUNTER_SPELL') {
            doneSlots.set(slot, u.controller);
            counterSpell(state, u);
            out.push({ type: 'EFFECT_COUNTERED', cardId: u.cardId });
          } else if (e.alt && altApplies(e.alt, u)) {
            // R81: the stronger alternative replaces the whole effect.
            addTemp(u, e.alt.amount, true);
          } else if (e.buff) {
            // R54: [Buff]: a +1 Might buff if the unit does not have one.
            if (!u.buffed) {
              u.buffed = true;
              out.push({ type: 'EFFECT_BUFF', unitId: u.id, amount: 1 });
            }
          } else {
            const times =
              e.timesEnemiesThere && u.zone.kind === 'battlefield'
                ? Object.values(state.objects).filter(
                    (o) =>
                      o.controller !== u.controller &&
                      o.zone.kind === 'battlefield' &&
                      u.zone.kind === 'battlefield' &&
                      o.zone.battlefieldId === u.zone.battlefieldId &&
                      isUnitDef(cards[o.cardId]),
                  ).length
                : e.timesEnemiesThere
                  ? 0
                  : 1;
            if (times > 0) addTemp(u, e.amount * times, e.duration === 'TURN');
          }
        }
        break;
      }
      case 'GRANT_KEYWORDS': {
        const src = state.objects[sourceObjectId];
        if (!src || (src.zone.kind !== 'base' && src.zone.kind !== 'battlefield')) break;
        const recipients =
          e.to === 'SELF'
            ? [src]
            : Object.values(state.objects).filter(
                (o) =>
                  o.id !== src.id &&
                  o.controller === src.controller &&
                  o.zone.kind === 'battlefield' &&
                  src.zone.kind === 'battlefield' &&
                  o.zone.battlefieldId === src.zone.battlefieldId &&
                  isUnitDef(cards[o.cardId]),
              );
        for (const u of recipients) {
          u.tempKeywords = [...(u.tempKeywords ?? []), ...e.keywords.map((k) => ({ ...k }))];
          out.push({ type: 'EFFECT_KEYWORD_GRANTED', unitId: u.id });
        }
        break;
      }
      case 'WEAPONMASTER_EQUIP': {
        const id = ids[e.slot ?? 0];
        if (id === undefined) break; // declined ("you may")
        const gear = state.objects[id];
        const unit = state.objects[sourceObjectId];
        if (
          !gear ||
          !unit ||
          !legalForSpec(
            state,
            cards,
            controller,
            { kind: 'equipment', side: 'friendly' },
            gear,
            sourceObjectId,
          )
        ) {
          fizzle();
          break;
        }
        const cost = weaponmasterCost(state, cards, gear, unit);
        const plan = autoPlan(state, cards, controller, cost);
        const paid = plan ? payCost(state, cards, controller, cost, plan) : null;
        if (!paid || !paid.ok) {
          fizzle();
          break;
        }
        // Inside a reduce session the paid state IS `state`; elsewhere copy the changed parts back.
        if (paid.state !== state) {
          state.players = paid.state.players;
          state.objects = paid.state.objects;
        }
        (state.objects[id] as CardInstance).attachedTo = unit.id;
        out.push({ type: 'EQUIPPED', equipmentId: id, unitId: unit.id });
        break;
      }
      case 'MUTUAL_DAMAGE': {
        const a = state.objects[ids[e.slots[0]] ?? ''];
        const b = state.objects[ids[e.slots[1]] ?? ''];
        const okA = legalForSpec(state, cards, controller, { kind: 'unit', side: e.sides[0] }, a);
        const okB = legalForSpec(state, cards, controller, { kind: 'unit', side: e.sides[1] }, b);
        if (!a || !b || !okA || !okB || a.id === b.id) {
          fizzle();
          break;
        }
        // Simultaneous: both Mights are read before either damage is marked.
        const dealtByA = Math.max(0, mightOf(a));
        const dealtByB = Math.max(0, mightOf(b));
        damage(b, dealtByA);
        damage(a, dealtByB);
        break;
      }
      case 'TARGET_OWNER_CHANNEL': {
        const who = doneSlots.get(e.slot ?? 0);
        if (who === undefined) break; // the return fizzled
        out.push(...channelRunes(state, who, e.amount, true).events);
        break;
      }
      case 'TARGET_CONTROLLER_DRAW': {
        const id = ids[e.slot ?? 0];
        const o = id ? state.objects[id] : undefined;
        if (!o) break;
        const who = doneSlots.get(e.slot ?? 0);
        if (who === undefined) break; // the earlier effect fizzled
        out.push(...drawWithBurnOut(state, who, e.amount, cards));
        break;
      }
      case 'REVEAL_TOP': {
        out.push(...burnOutIfEmpty(state, controller, cards));
        if (state.gameStatus !== 'IN_PROGRESS') break;
        const ps = state.players[playerIndex(controller)];
        const topId = ps.mainDeck[0];
        const top = topId === undefined ? undefined : state.objects[topId];
        const def = top === undefined ? undefined : cards[top.cardId];
        if (!top || !def) break;
        out.push({
          type: 'CARD_REVEALED',
          player: controller,
          cardInstanceId: top.id,
          cardId: top.cardId,
        });
        const isUnit = def.type === 'UNIT';
        const hit =
          e.filter === undefined ||
          (e.filter === 'unit' && isUnit) ||
          (e.filter === 'gear' && def.type === 'GEAR') ||
          (e.filter === 'spell' && def.type === 'SPELL') ||
          (e.filter === 'mighty' && isUnit && (def.stats.might ?? 0) >= 5);
        if (hit) {
          if (e.hit === 'DRAW') {
            out.push(...drawWithBurnOut(state, controller, 1, cards));
          } else {
            ps.mainDeck.shift();
            top.zone = { kind: 'hand', player: controller };
            ps.hand.push(top.id);
            out.push({
              type: 'CARD_DRAWN',
              player: controller,
              cardInstanceId: top.id,
              visibleTo: [controller],
            });
          }
        } else if (e.miss === 'RECYCLE') {
          ps.mainDeck.shift();
          ps.mainDeck.push(top.id);
          out.push({ type: 'CARDS_RECYCLED', player: controller, count: 1 });
        } else if (e.miss === 'TRASH') {
          ps.mainDeck.shift();
          ps.trash.push(top.id);
          top.zone = { kind: 'trash', player: controller };
          const src = state.objects[sourceObjectId];
          if (e.missBuff && src && (src.zone.kind === 'base' || src.zone.kind === 'battlefield')) {
            addTemp(src, e.missBuff, true);
          }
        }
        break;
      }
      case 'HAND_DISCARD':
      case 'HAND_PICK': {
        const opp: PlayerId = controller === 'p0' ? 'p1' : 'p0';
        const turnFirst: PlayerId[] =
          state.turn.activePlayer === 'p0' ? ['p0', 'p1'] : ['p1', 'p0'];
        const rest = effects.slice(effects.indexOf(e) + 1);
        const waiting = startHandChoice(
          state,
          cards,
          {
            mode: e.op === 'HAND_DISCARD' ? 'SELF' : 'PICK',
            players: e.op === 'HAND_PICK' ? [opp] : e.who === 'EACH' ? turnFirst : [opp],
            count: e.op === 'HAND_DISCARD' ? e.count : 1,
            action: e.op === 'HAND_PICK' ? e.action : 'DISCARD',
            ...(e.op === 'HAND_PICK' && e.filter ? { filter: e.filter } : {}),
            controller,
            sourceObjectId,
            sourceCardId,
            rest,
          },
          out,
        );
        // A pending choice keeps the rest of the effect list; resolve it after the answer.
        if (waiting) return out;
        break;
      }
      case 'KILL_GEARS_HERE': {
        const here = hereOfSource(state, sourceObjectId);
        if (here === null) break;
        const gear = Object.values(state.objects)
          .filter(
            (o) =>
              o.id !== sourceObjectId &&
              o.controller === controller &&
              o.zone.kind === 'battlefield' &&
              o.zone.battlefieldId === here &&
              isGearDef(cards[o.cardId]) &&
              (cards[o.cardId]?.subtypes ?? []).some(
                (x) => x.toLowerCase() === e.subtype.toLowerCase(),
              ),
          )
          .sort((a, b) => num(a.id) - num(b.id));
        for (const g of gear) {
          killGear(state, g);
          out.push({ type: 'GEAR_KILLED', gearId: g.id });
        }
        break;
      }
      case 'KILL_ALL_GEAR': {
        const gear = Object.values(state.objects)
          .filter(
            (o) =>
              (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
              isGearDef(cards[o.cardId]),
          )
          .sort((a, b) => num(a.id) - num(b.id));
        for (const g of gear) {
          killGear(state, g);
          out.push({ type: 'GEAR_KILLED', gearId: g.id });
        }
        break;
      }
      case 'BUFF_ALL':
        for (const u of boardUnits(state, cards)) {
          if (!sideMatches(e.side, controller, u)) continue;
          if (
            e.subtype &&
            !cards[u.cardId]?.subtypes.some((x) => x.toLowerCase() === e.subtype?.toLowerCase())
          ) {
            continue;
          }
          if (e.here || e.others) {
            const hb = hereOfSource(state, sourceObjectId);
            if (
              e.here &&
              (hb === null || u.zone.kind !== 'battlefield' || u.zone.battlefieldId !== hb)
            ) {
              continue;
            }
            if (e.others && u.id === sourceObjectId) continue;
          }
          if (e.buff) {
            if (!u.buffed) {
              u.buffed = true;
              out.push({ type: 'EFFECT_BUFF', unitId: u.id, amount: 1 });
            }
            continue;
          }
          if (e.amount < 0 && e.minMight !== undefined) {
            const cut = Math.max(0, Math.min(-e.amount, mightOf(u) - e.minMight));
            if (cut > 0) addTemp(u, -cut, e.duration === 'TURN');
          } else {
            addTemp(u, e.amount, e.duration === 'TURN');
          }
        }
        break;
      case 'DAMAGE_ALL': {
        const bf = state.flow.combat?.battlefieldId;
        const pickedKey = e.scope === 'chosen' ? ids[e.slot ?? 0] : undefined;
        const here =
          e.scope === 'here'
            ? hereOfSource(state, sourceObjectId)
            : pickedKey?.startsWith('bf:')
              ? pickedKey.slice(3)
              : null;
        if ((e.scope === 'here' || e.scope === 'chosen') && here === null) {
          fizzle();
          break;
        }
        const dmgAmount = damageAmount(e);
        for (const u of boardUnits(state, cards)) {
          if (!sideMatches(e.side, controller, u)) continue;
          const inScope =
            e.scope === 'bases'
              ? u.zone.kind === 'base'
              : e.scope === 'battlefields'
                ? u.zone.kind === 'battlefield'
                : e.scope === 'here' || e.scope === 'chosen'
                  ? u.zone.kind === 'battlefield' && u.zone.battlefieldId === here
                  : u.zone.kind === 'battlefield' && u.zone.battlefieldId === bf;
          if (inScope) damage(u, dmgAmount);
        }
        break;
      }
      case 'READY_ALL':
      case 'EXHAUST_ALL':
        for (const u of boardUnits(state, cards)) {
          if (!sideMatches(e.side, controller, u)) continue;
          const wasReady = u.ready;
          u.ready = e.op === 'READY_ALL';
          if (u.ready && !wasReady) out.push({ type: 'EFFECT_READIED', unitId: u.id });
        }
        break;
      case 'CHANNEL': {
        const players: PlayerId[] = e.eachPlayer
          ? [controller, controller === 'p0' ? 'p1' : 'p0']
          : [controller];
        for (const who of players) {
          const r = channelRunes(state, who, e.amount, e.exhausted === true);
          out.push(...r.events);
          if (r.channeled < e.amount && e.elseDraw) {
            out.push(...drawWithBurnOut(state, who, e.elseDraw, cards));
          }
        }
        break;
      }
      case 'READY_RUNES': {
        const ps = state.players[playerIndex(controller)];
        let left = e.count;
        for (const id of [...ps.base].sort((a, b) => num(a) - num(b))) {
          const r = state.objects[id] as CardInstance;
          if (left <= 0) break;
          if (cards[r.cardId]?.type !== 'RUNE' || r.ready) continue;
          r.ready = true;
          left--;
        }
        break;
      }
      case 'RECYCLE_RUNES': {
        const ps = state.players[playerIndex(controller)];
        for (const id of [...ps.base].sort((a, b) => num(a) - num(b))) {
          const r = state.objects[id] as CardInstance;
          if (cards[r.cardId]?.type !== 'RUNE') continue;
          ps.base = ps.base.filter((x) => x !== id);
          state.players[playerIndex(r.owner)].runeDeck.push(id);
          r.zone = { kind: 'runeDeck', player: r.owner };
          r.ready = true;
        }
        break;
      }
      case 'RECYCLE_TRASH': {
        const ps = state.players[playerIndex(controller)];
        const take = ps.trash.slice(0, e.count);
        ps.trash = ps.trash.slice(take.length);
        for (const id of take) {
          ps.mainDeck.push(id);
          (state.objects[id] as CardInstance).zone = { kind: 'mainDeck', player: controller };
        }
        if (take.length > 0)
          out.push({ type: 'CARDS_RECYCLED', player: controller, count: take.length });
        break;
      }
      case 'NEXT_PLAY_DISCOUNT':
        state.players[playerIndex(controller)].nextPlayDiscount = {
          turn: state.turn.number,
          energy: e.amount,
          spellsOnly: e.spellsOnly,
        };
        break;
      case 'ENTER_READY_THIS_TURN':
        state.players[playerIndex(controller)].enterReadyTurn = state.turn.number;
        break;
      case 'ENTER_READY_NEXT':
        state.players[playerIndex(controller)].enterReadyNext = state.turn.number;
        break;
      case 'LOCK_PLAYS': {
        const who: PlayerId | undefined =
          e.who === 'OPPONENTS' ? (controller === 'p0' ? 'p1' : 'p0') : doneSlots.get(e.slot ?? 0);
        if (who === undefined) break; // the earlier effect fizzled
        const ps = state.players[playerIndex(who)];
        const cur = ps.playLock;
        // CARDS is the stronger lock; never weaken one already in force this turn.
        if (!(cur && cur.turn === state.turn.number && cur.what === 'CARDS')) {
          ps.playLock = { turn: state.turn.number, what: e.what };
        }
        break;
      }
      case 'RETURN_ALL_UNITS':
        for (const o of Object.values(state.objects).sort((a, b) => num(a.id) - num(b.id))) {
          if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
          if (!isUnitDef(cards[o.cardId])) continue;
          if (mightOf(o) > e.maxMight) continue;
          returnToHand(state, o, out);
        }
        break;
      case 'RETURN_ALL_BOARD':
        for (const o of Object.values(state.objects).sort((a, b) => num(a.id) - num(b.id))) {
          if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
          const t = cards[o.cardId]?.type;
          if (t === 'UNIT' || t === 'GEAR' || t === 'TOKEN') returnToHand(state, o, out);
        }
        break;
      case 'KILL_ALL_UNITS':
        for (const u of boardUnits(state, cards)) {
          if (e.side && !sideMatches(e.side, controller, u)) continue;
          if (e.damaged && u.damage <= 0) continue;
          if (e.here) {
            const hb = hereOfSource(state, sourceObjectId);
            if (hb === null || u.zone.kind !== 'battlefield' || u.zone.battlefieldId !== hb)
              continue;
          }
          const lethal = Math.max(1, mightOf(u)) - u.damage;
          if (lethal > 0) u.damage += lethal;
          out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: Math.max(lethal, 0) });
        }
        break;
      case 'PLAY_TOKEN': {
        const chosenAt =
          e.atSlot === undefined
            ? undefined
            : ids[e.atSlot]?.startsWith('bf:')
              ? ids[e.atSlot]?.slice(3)
              : undefined;
        if (!cards[e.token] || (e.atSlot !== undefined && chosenAt === undefined)) {
          fizzle();
          break;
        }
        playTokens(
          state,
          cards,
          e.forOpponent ? (controller === 'p0' ? 'p1' : 'p0') : controller,
          e.token,
          e.count,
          { ...e, ...(chosenAt !== undefined ? { at: chosenAt } : {}) },
          sourceObjectId,
          out,
        );
        break;
      }
      case 'TARGET_CONTROLLER_PLAY_TOKEN': {
        const who = doneSlots.get(e.slot ?? 0);
        if (who === undefined || !cards[e.token]) break; // the earlier effect fizzled
        playTokens(state, cards, who, e.token, e.count, {}, sourceObjectId, out);
        break;
      }
      case 'ADD_ENERGY': {
        state.players[playerIndex(controller)].runePool.energy += e.amount;
        out.push({ type: 'RESOURCES_ADDED', player: controller, energy: e.amount, power: 0 });
        break;
      }
      case 'ADD_POWER': {
        const pool = state.players[playerIndex(controller)].runePool;
        const domain = e.domain === 'SOURCE' ? cards[sourceCardId]?.domains[0] : undefined;
        if (domain) pool.power[domain] = (pool.power[domain] ?? 0) + e.amount;
        else pool.universal = (pool.universal ?? 0) + e.amount;
        out.push({ type: 'RESOURCES_ADDED', player: controller, energy: 0, power: e.amount });
        break;
      }
      case 'LOOK_TOP':
        out.push(...lookAtTop(state, controller, e.count, e.take, cards, e.rest));
        break;
      case 'GAIN_POINT':
        {
          const who = e.forOpponent ? (controller === 'p0' ? 'p1' : 'p0') : controller;
          state.players[playerIndex(who)].points += e.amount;
          out.push({ type: 'POINT_GAINED', player: who, amount: e.amount, source: 'EFFECT' });
        }
        break;
    }
  }
  return out;
}

/** Ending step (317): "this turn" Might bonuses and Stun expire. */
export function expireTurnEffects(
  state: GameState,
  _cards: CardDatabase,
): { state: GameState; events: GameEventInput[] } {
  void _cards;
  const s = fork(state);
  for (const o of Object.values(s.objects)) {
    if (o.tempMight) {
      o.mightBonus -= o.tempMight;
      delete o.tempMight;
    }
    if (o.baseMightSet !== undefined) delete o.baseMightSet;
    if (o.deathReplace) delete o.deathReplace;
    if (o.deathOffer) delete o.deathOffer;
    if (o.deathDeclined) delete o.deathDeclined;
    if (o.dmgMod) delete o.dmgMod;
    if (o.stunned) delete o.stunned;
    if (o.cantMove) delete o.cantMove;
    if (o.tempKeywords) delete o.tempKeywords;
  }
  return { state: s, events: [] };
}
