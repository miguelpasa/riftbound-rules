/**
 * Effect interpreter (R1, R3). Mutates the working state (caller's clone) and returns events.
 * Rule 359.3 (a spell's effects happen as it resolves, then it goes to the Trash).
 *
 * Targets: a spell's chosen objects are the `object` entries of `PLAY_CARD.targets`, in order.
 * Each targeted effect reads one slot (`slot`, default 0); an effect with `count` takes all of
 * them. `targetRequirements` derives the slots a spell needs, `spellTargetsLegal` validates a
 * choice (play.ts) and `enumerateSpellTargets` lists choices for `getLegalActions` (capped).
 */
import { fork } from './workingCopy.js';
import { drawWithBurnOut } from './burnout.js';
import { effectiveMight } from './combat.js';
import { equipTotalCost, hasKeyword, removeTokenFromGame } from './keywords.js';
import { autoPlan, payCost } from './resources.js';
import { allocObjectId } from './setup.js';
import { hereOfSource } from './sources.js';
import { isGearDef, isUnitDef } from './tokens.js';
import { playerIndex } from './types/constants.js';
import type {
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

/** Maximum number of target combinations offered to the AI / UI per spell. */
export const MAX_TARGET_COMBOS = 48;

type TargetKind = 'unit' | 'gear' | 'unitOrGear' | 'spell' | 'equipment';

/** What a slot may hold. */
interface Spec {
  kind: TargetKind;
  side: TargetSide;
  atBattlefield?: boolean;
  maxMight?: number;
  /** Gear only: Energy cost at most this. */
  maxEnergy?: number;
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
  e.op === 'STUN_TARGET' ||
  e.op === 'DEBUFF_TARGET' ||
  e.op === 'KILL_GEAR' ||
  e.op === 'RETURN_TARGET' ||
  e.op === 'MOVE_BASE_TARGET' ||
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
  if ('atBattlefield' in e && e.atBattlefield) spec.atBattlefield = true;
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
): boolean {
  if (!u) return false;
  const type = cards[u.cardId]?.type;
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
  if (spec.kind === 'spell') {
    return (
      type === 'SPELL' &&
      u.zone.kind === 'chain' &&
      state.flow.chain.some((i) => i.kind === 'CARD' && i.sourceObjectId === u.id)
    );
  }
  const onBoard = u.zone.kind === 'base' || u.zone.kind === 'battlefield';
  if (!onBoard) return false;
  if (spec.kind === 'gear') {
    if (!isGearDef(cards[u.cardId])) return false;
    if (spec.maxEnergy !== undefined && (cards[u.cardId]?.cost.energy ?? 0) > spec.maxEnergy) {
      return false;
    }
  } else {
    // R46: "kill a unit or gear": a gear passes the location checks of a unit, not the Might ones.
    const gearOk = spec.kind === 'unitOrGear' && isGearDef(cards[u.cardId]);
    if (!gearOk && !isUnitDef(cards[u.cardId])) return false;
    if (spec.atBattlefield && u.zone.kind !== 'battlefield') return false;
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

function objectIds(targets: readonly Target[]): string[] {
  return targets.flatMap((t) => (t.kind === 'object' ? [t.id] : []));
}

/** Are the chosen targets a legal choice for this list of effects (355.10)? */
export function spellTargetsLegal(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  effects: readonly CardEffect[] | undefined,
  targets: readonly Target[],
  sourceId = '',
): boolean {
  const reqs = targetRequirements(effects);
  if (reqs.length === 0) return true;
  const ids = objectIds(targets);
  const seen = new Set<string>();
  for (const r of reqs) {
    const picks = r.count ? ids.slice(r.slot) : ids.slice(r.slot, r.slot + 1);
    const min = r.count ? r.count.min : 1;
    const max = r.count ? r.count.max : 1;
    if (picks.length < min || picks.length > max) return false;
    for (const id of picks) {
      if (seen.has(id) || !legalForSpec(state, cards, controller, r, state.objects[id], sourceId)) {
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
  if (targets.length > max || targets.some((t) => t.kind !== 'object')) return false;
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
  opts: { allowNone?: boolean } = {},
): Target[][] | null {
  const reqs = targetRequirements(effects);
  if (reqs.length === 0) return null;
  const all = Object.values(state.objects).sort((a, b) => num(a.id) - num(b.id));
  const options = reqs.map((r) => {
    const cand = all
      .filter((o) => legalForSpec(state, cards, controller, r, o, sourceId))
      .map((o) => o.id);
    if (!r.count) return cand.map((id) => [id]);
    const out: string[][] = [];
    for (let k = Math.max(1, r.count.min); k <= r.count.max; k++) {
      if (cand.length >= k) out.push(...combinations(cand, k));
    }
    return out;
  });
  let acc: string[][] = [[]];
  for (const opt of options) {
    const next: string[][] = [];
    for (const prefix of acc) {
      for (const choice of opt) {
        if (choice.some((id) => prefix.includes(id))) continue;
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
    if (acc.length === 0) return [];
    acc.push([]);
  }
  return acc.map((ids) => ids.map((id) => ({ kind: 'object' as const, id })));
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
  delete g.attachedTo;
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

/** "Look at the top N cards ... take one ... recycle the rest" (deterministic choice). Mutates. */
function lookAtTop(
  state: GameState,
  player: PlayerId,
  count: number,
  take: { filter?: 'unit' | 'gear'; reveal?: boolean } | undefined,
  cards: CardDatabase,
): GameEventInput[] {
  const out: GameEventInput[] = [];
  const ps = state.players[playerIndex(player)];
  const ids = ps.mainDeck.splice(0, count);
  out.push({ type: 'CARDS_LOOKED_AT', player, count: ids.length });
  let pick: string | undefined;
  if (take) {
    const want = take.filter === 'unit' ? 'UNIT' : take.filter === 'gear' ? 'GEAR' : undefined;
    const cand = ids.filter(
      (id) => !want || cards[(state.objects[id] as CardInstance).cardId]?.type === want,
    );
    // Unrestricted: the most expensive card (first on ties); restricted: the first match.
    const energy = (id: string): number =>
      cards[(state.objects[id] as CardInstance).cardId]?.cost.energy ?? 0;
    pick = want
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
  const rest = ids.filter((id) => id !== pick);
  ps.mainDeck.push(...rest);
  if (rest.length > 0) out.push({ type: 'CARDS_RECYCLED', player, count: rest.length });
  return out;
}

/** Play `count` tokens for `controller` (Base, or the source's battlefield with `here`). Mutates. */
function playTokens(
  state: GameState,
  controller: PlayerId,
  token: string,
  count: number,
  opts: { ready?: boolean; here?: boolean },
  sourceObjectId: string,
  out: GameEventInput[],
): void {
  const here = opts.here ? hereOfSource(state, sourceObjectId) : null;
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
    out.push({ type: 'TOKEN_PLAYED', player: controller, unitId: id, cardId: token });
  }
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
    u.damage += amount;
    out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount });
  };
  const mightOf = (u: CardInstance): number => effectiveMight(state, cards, u.id, { role: null });
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
        const n = e.perOtherBattlefield
          ? e.amount *
            state.battlefields.filter((b) => b.controller === controller && b.id !== here).length
          : e.amount;
        if (n > 0) out.push(...drawWithBurnOut(state, controller, n, cards));
        break;
      }
      case 'BURN': {
        // R44: the top cards of the Main Deck go to the Trash; running out of cards is not a Burn Out.
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
          addTemp(src, e.amount, true);
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
      case 'WIN_GAME':
        state.gameStatus = 'FINISHED';
        state.winner = controller;
        out.push({ type: 'GAME_ENDED', winner: controller });
        break;
      case 'DAMAGE_TARGET':
      case 'BUFF_TARGET':
      case 'KILL_TARGET':
      case 'READY_TARGET':
      case 'STUN_TARGET':
      case 'DEBUFF_TARGET':
      case 'KILL_GEAR':
      case 'RETURN_TARGET':
      case 'MOVE_BASE_TARGET':
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
        for (const u of legal) {
          if (e.op === 'DAMAGE_TARGET') {
            damage(u, e.amount);
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
          } else if (e.op === 'READY_TARGET') {
            u.ready = true;
            out.push({ type: 'EFFECT_READIED', unitId: u.id });
          } else if (e.op === 'STUN_TARGET') {
            u.stunned = true;
            out.push({ type: 'EFFECT_STUNNED', unitId: u.id });
          } else if (e.op === 'DEBUFF_TARGET') {
            const room = e.minMight === undefined ? e.amount : mightOf(u) - e.minMight;
            const cut = Math.max(0, Math.min(e.amount, room));
            if (cut > 0) addTemp(u, -cut, true);
          } else if (e.op === 'KILL_GEAR') {
            doneSlots.set(slot, u.controller);
            killGear(state, u);
            out.push({ type: 'GEAR_KILLED', gearId: u.id });
          } else if (e.op === 'RETURN_TARGET') {
            returnToHand(state, u, out);
          } else if (e.op === 'MOVE_BASE_TARGET') {
            moveToBase(state, u, out);
          } else if (e.op === 'GRANT_KEYWORD_TARGET') {
            u.tempKeywords = [...(u.tempKeywords ?? []), ...e.keywords.map((k) => ({ ...k }))];
            out.push({ type: 'EFFECT_KEYWORD_GRANTED', unitId: u.id });
          } else if (e.op === 'COUNTER_SPELL') {
            counterSpell(state, u);
            out.push({ type: 'EFFECT_COUNTERED', cardId: u.cardId });
          } else {
            addTemp(u, e.amount, e.duration === 'TURN');
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
      case 'TARGET_CONTROLLER_DRAW': {
        const id = ids[e.slot ?? 0];
        const o = id ? state.objects[id] : undefined;
        if (!o) break;
        const who = doneSlots.get(e.slot ?? 0);
        if (who === undefined) break; // the earlier effect fizzled
        out.push(...drawWithBurnOut(state, who, e.amount, cards));
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
          if (sideMatches(e.side, controller, u)) addTemp(u, e.amount, e.duration === 'TURN');
        }
        break;
      case 'DAMAGE_ALL': {
        const bf = state.flow.combat?.battlefieldId;
        for (const u of boardUnits(state, cards)) {
          if (!sideMatches(e.side, controller, u)) continue;
          const inScope =
            e.scope === 'bases'
              ? u.zone.kind === 'base'
              : e.scope === 'battlefields'
                ? u.zone.kind === 'battlefield'
                : u.zone.kind === 'battlefield' && u.zone.battlefieldId === bf;
          if (inScope) damage(u, e.amount);
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
      case 'KILL_ALL_UNITS':
        for (const u of boardUnits(state, cards)) {
          const lethal = Math.max(1, mightOf(u)) - u.damage;
          if (lethal > 0) u.damage += lethal;
          out.push({ type: 'EFFECT_DAMAGE', unitId: u.id, amount: Math.max(lethal, 0) });
        }
        break;
      case 'PLAY_TOKEN': {
        if (!cards[e.token]) {
          fizzle();
          break;
        }
        playTokens(state, controller, e.token, e.count, e, sourceObjectId, out);
        break;
      }
      case 'TARGET_CONTROLLER_PLAY_TOKEN': {
        const who = doneSlots.get(e.slot ?? 0);
        if (who === undefined || !cards[e.token]) break; // the earlier effect fizzled
        playTokens(state, who, e.token, e.count, {}, sourceObjectId, out);
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
        out.push(...lookAtTop(state, controller, e.count, e.take, cards));
        break;
      case 'GAIN_POINT':
        state.players[playerIndex(controller)].points += e.amount;
        out.push({ type: 'POINT_GAINED', player: controller, amount: e.amount, source: 'EFFECT' });
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
    if (o.stunned) delete o.stunned;
    if (o.tempKeywords) delete o.tempKeywords;
  }
  return { state: s, events: [] };
}
