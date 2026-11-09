/**
 * MVP keywords owned by E10: Temporary, Hidden, Deflect, Equip, Quick-Draw, Legion (+ keyword helpers).
 * (Tank, Backline, Assault, Shield live in combat.ts; Ganking in movement.ts; Accelerate in play.ts;
 * Unique in deckValidation.ts.)
 *
 * Pure and isomorphic: every state-changing function structuredClones its input (or, where the
 * name says "working", mutates the state the caller already owns).
 *
 * Decisions:
 *  - Temporary (glossary): killed at the start of its controller's Beginning Phase, before Scoring.
 *    Killed = moved to the OWNER's trash, UNIT_KILLED emitted, attached Equipment is detached.
 *    TOKEN objects with Temporary are removed from the game instead (186.1).
 *  - Hidden (811, 422.2.a): HIDE_CARD has no payment field, so the 1 Power (any domain) is paid with
 *    `autoPlan`. A hidden card records `enteredTurn = turn.number`; it is playable only on a LATER
 *    turn. From then it has Reaction and base cost 0 (additional costs such as Accelerate / Deflect
 *    still apply). A unit played from the facedown zone enters at that battlefield.
 *  - PRIVACY: hiding emits CARD_PLAYED with visibleTo:[controller] (the cardId stays private) and a
 *    public CARD_HIDDEN {player, battlefieldId} with no card id, so both players' logs can say that
 *    a card was hidden there.
 *  - Deflect (809, 356.2.a.2): the surcharge is Power. `CostMod.power` is "generic Power of the
 *    played card's domains", so it cannot yet express "any domain" (see report).
 *  - Equip cost (818): `CardDef.equipCost` (Energy, [C] domain Power, [A] any Power) via computeTotalCost;
 *    no parsed cost = free. Equip has no payment field either: autoPlan.
 *    Equip is an activated ability: your turn, Neutral Open, Main phase, with priority (145.2).
 *  - Equipment Might bonus (137.3) = sum of attached Equipment `stats.might`; see attachedMightBonus.
 *  - Quick-Draw: `quickDrawAttach` attaches (free) after the gear is in play; the Reaction speed
 *    comes from the card's own Reaction keyword in CardDef.keywords. playCard requires the unit as
 *    an object Target (ILLEGAL_TARGET if missing / not a unit you control on the board) unless the
 *    controller has no unit, in which case the gear is played unattached. makePlayHooks().onEnter
 *    performs the attach from the chain item's first object target.
 */
import { baseMight } from './baseMight.js';
import { fork } from './workingCopy.js';
import { canPlayNow, deriveTurnState, finalizeAndSettle, pushPendingItem } from './chain.js';
import type { ChainResolver } from './chain.js';
import { playCard } from './play.js';
import type { PlayHooks } from './play.js';
import { autoPlan, computeTotalCost, payCost } from './resources.js';
import type { CostMod, TotalCost } from './resources.js';
import { allocObjectId, stampEvents } from './setup.js';
import { defWithGrants } from './statics.js';
import { evalCondition, recordDeath } from './conditions.js';
import { DEFERRED_KEYWORDS, MVP_KEYWORDS, playerIndex, ruleError } from './types/index.js';
import type {
  ChainItem,
  CardDatabase,
  CardDef,
  CardInstance,
  EquipIntent,
  GameEventInput,
  GameState,
  HideCardIntent,
  KeywordName,
  PlayCardIntent,
  PlayerId,
  ReduceResult,
  Target,
} from './types/index.js';
import { clearBoardState } from './zoneReset.js';

// ---------------------------------------------------------------- helpers

/** Which keywords the engine implements (consistent with MVP_KEYWORDS / DEFERRED_KEYWORDS). */
export const KEYWORD_IMPLEMENTED: Record<KeywordName, boolean> = Object.fromEntries([
  ...MVP_KEYWORDS.map((k) => [k, true]),
  ...DEFERRED_KEYWORDS.map((k) => [k, false]),
]) as Record<KeywordName, boolean>;

export function hasKeyword(def: CardDef, name: KeywordName): boolean {
  return def.keywords.some((k) => k.name === name);
}

/** Sum of the numeric values of every instance of `name` (stacking); 0 if absent or valueless. */
export function keywordValue(def: CardDef, name: KeywordName): number {
  return def.keywords.reduce((n, k) => (k.name === name ? n + (k.value ?? 0) : n), 0);
}

const isOnBoard = (o: CardInstance): boolean =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield';

function isUnitOnBoard(state: GameState, cards: CardDatabase, id: string): CardInstance | null {
  const o = state.objects[id];
  const d = o ? cards[o.cardId] : undefined;
  return o &&
    isOnBoard(o) &&
    (d?.type === 'UNIT' || (d?.type === 'TOKEN' && d.stats.might !== undefined))
    ? o
    : null;
}

/** A Unit, Gear or Token on the board (Deflect, 809, applies to any Permanent). */
function permanentOnBoard(state: GameState, cards: CardDatabase, id: string): CardInstance | null {
  const o = state.objects[id];
  const t = o ? cards[o.cardId]?.type : undefined;
  return o && isOnBoard(o) && (t === 'UNIT' || t === 'GEAR' || t === 'TOKEN') ? o : null;
}

/** Detach every Equipment attached to `unitId` (mutates the working state). */
function detachAll(state: GameState, unitId: string): void {
  for (const o of Object.values(state.objects)) if (o.attachedTo === unitId) delete o.attachedTo;
}

/**
 * Rule 186.1: a token in any zone other than the Board or the Chain ceases to exist. Removes the
 * object from the game entirely (objects map and every zone array) and detaches its Equipment.
 * Mutates the working state.
 */
/** Tokens whose "when it dies" ability still resolves after the token ceased to exist (Bomb). */
const GHOST_TOKENS = new Set(['tok-bomb']);

export function removeTokenFromGame(state: GameState, id: string): void {
  const gone = state.objects[id];
  if (gone && GHOST_TOKENS.has(gone.cardId)) {
    state.lki = {
      ...(state.lki ?? {}),
      [id]: {
        cardId: gone.cardId,
        controller: gone.controller,
        at: gone.zone.kind === 'battlefield' ? gone.zone.battlefieldId : null,
      },
    };
  }
  for (const p of state.players) {
    p.base = p.base.filter((x) => x !== id);
    p.trash = p.trash.filter((x) => x !== id);
    p.hand = p.hand.filter((x) => x !== id);
    p.banishment = p.banishment.filter((x) => x !== id);
  }
  detachAll(state, id);
  delete state.objects[id];
}

// ---------------------------------------------------------------- Temporary

/**
 * PhaseHooks.onBeginning: kill the active player's Temporary units before Scoring.
 * Order: ascending object number (deterministic).
 */
export function temporaryOnBeginning(
  state: GameState,
  cards: CardDatabase,
): { state: GameState; events: GameEventInput[] } {
  const s = fork(state);
  const events: GameEventInput[] = [];
  const player = s.turn.activePlayer;
  const doomed = Object.values(s.objects)
    .filter((o) => {
      const def = cards[o.cardId];
      return (
        o.controller === player &&
        isOnBoard(o) &&
        (def?.type === 'UNIT' || def?.type === 'TOKEN' || def?.type === 'GEAR') &&
        (hasKeyword(def, 'Temporary') ||
          (o.temporaryOf !== undefined && o.temporaryOf === o.enteredTurn))
      );
    })
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const crowd = new Map<string, number>();
  for (const u of Object.values(s.objects)) {
    if (isOnBoard(u) && (cards[u.cardId]?.type === 'UNIT' || cards[u.cardId]?.type === 'TOKEN')) {
      const k =
        u.controller + '|' + (u.zone.kind === 'battlefield' ? u.zone.battlefieldId : 'base');
      crowd.set(k, (crowd.get(k) ?? 0) + 1);
    }
  }
  for (const o of doomed) {
    const at = o.zone.kind === 'battlefield' ? o.zone.battlefieldId : 'base';
    const death = {
      type: 'UNIT_KILLED' as const,
      unitId: o.id,
      controller: o.controller,
      cardId: o.cardId,
      at,
      alone: (crowd.get(o.controller + '|' + at) ?? 1) <= 1,
      ...(o.stunned ? { stunned: true } : {}),
      ...(o.buffed ? { buffed: true } : {}),
      ...(evalCondition(s, cards, { kind: 'MIGHTY' }, o.controller, o.id) ? { mighty: true } : {}),
    };
    const from = s.players[playerIndex(o.zone.player)];
    from.base = from.base.filter((id) => id !== o.id);
    recordDeath(s, cards, o.controller); // R56
    if (cards[o.cardId]?.type === 'TOKEN') {
      removeTokenFromGame(s, o.id); // 186.1: tokens cease to exist outside the Board
      events.push(death);
      continue;
    }
    s.players[playerIndex(o.owner)].trash.push(o.id);
    o.zone = { kind: 'trash', player: o.owner };
    clearBoardState(o);
    delete o.attachedTo; // Temporary Gear: it leaves its unit too
    detachAll(s, o.id);
    events.push(death);
  }
  return { state: s, events };
}

// ---------------------------------------------------------------- Hidden

/** Stub def used to check "Neutral Open, my turn, Main, with priority" regardless of keywords. */
const PLAIN_TIMING_DEF = { keywords: [] } as unknown as CardDef;

/** HIDE_CARD (811, 422.2.a): pay 1 Power (any domain), hide a Hidden card from hand facedown. */
export function hideCard(
  state: GameState,
  cards: CardDatabase,
  intent: HideCardIntent,
): ReduceResult {
  const pid = intent.playerId;
  const timing = canPlayNow(state, cards, pid, PLAIN_TIMING_DEF);
  if (!timing.ok) return timing;
  const ts = deriveTurnState(state);
  if (ts.kind !== 'NEUTRAL' || !ts.open) {
    return ruleError('WRONG_PHASE', 'hide only in a Neutral Open state');
  }

  const obj = state.objects[intent.cardInstanceId];
  if (!obj) return ruleError('NOT_FOUND', `card ${intent.cardInstanceId}`);
  const ps = state.players[playerIndex(pid)];
  if (obj.zone.kind !== 'hand' || obj.zone.player !== pid || !ps.hand.includes(obj.id)) {
    return ruleError('NOT_IN_HAND', `card ${obj.id}`);
  }
  const def = cards[obj.cardId];
  if (!def) return ruleError('NOT_FOUND', `card definition ${obj.cardId}`);
  if (!hasKeyword(def, 'Hidden')) return ruleError('HIDDEN_NOT_ALLOWED', 'card lacks Hidden');
  const bf = state.battlefields.find((b) => b.id === intent.battlefieldId);
  if (!bf) return ruleError('HIDDEN_NOT_ALLOWED', `battlefield ${intent.battlefieldId} not found`);
  if (bf.controller !== pid) {
    return ruleError('HIDDEN_NOT_ALLOWED', 'you do not control that battlefield');
  }
  if (bf.facedownSlotId !== null) {
    return ruleError('HIDDEN_NOT_ALLOWED', 'that battlefield already has a facedown card');
  }

  const cost: TotalCost = { energy: 0, power: [{ domain: 'ANY', amount: 1 }] };
  const plan = autoPlan(state, cards, pid, cost);
  if (!plan) return ruleError('INSUFFICIENT_RESOURCES', 'hiding costs 1 Power');
  const paid = payCost(state, cards, pid, cost, plan);
  if (!paid.ok) return paid;

  const s = paid.state;
  const w = s.objects[obj.id] as CardInstance;
  const p = s.players[playerIndex(pid)];
  p.hand = p.hand.filter((id) => id !== w.id);
  w.zone = { kind: 'facedown', player: pid, battlefieldId: bf.id };
  w.facedown = true;
  w.hidden = true;
  w.enteredTurn = s.turn.number;
  const sbf = s.battlefields.find((b) => b.id === bf.id);
  if (sbf) sbf.facedownSlotId = w.id;
  // Private to the controller: a public CARD_PLAYED would leak the cardId (see ASSUMPTIONS.md).
  // The public CARD_HIDDEN carries no card id: the opponent learns that a card was hidden there.
  const events = stampEvents(s, [
    {
      type: 'CARD_PLAYED',
      player: pid,
      cardInstanceId: w.id,
      cardId: w.cardId,
      visibleTo: [pid],
    } as GameEventInput,
    { type: 'CARD_HIDDEN', player: pid, battlefieldId: bf.id } as GameEventInput,
  ]);
  return { ok: true, state: s, events };
}

/**
 * Play a facedown Hidden card (PLAY_CARD with its id; payment normally empty). Legal only on a turn
 * later than the one it was hidden on; it has Reaction and base cost 0. Reuses `playCard`.
 */
export function playHiddenCard(
  state: GameState,
  cards: CardDatabase,
  intent: PlayCardIntent,
  resolver?: ChainResolver,
  hooks: PlayHooks = makePlayHooks(),
): ReduceResult {
  const pid = intent.playerId;
  const obj = state.objects[intent.cardInstanceId];
  if (!obj) return ruleError('NOT_FOUND', `card ${intent.cardInstanceId}`);
  if (obj.zone.kind !== 'facedown') return ruleError('NOT_IN_HAND', 'card is not facedown');
  if (obj.controller !== pid || obj.zone.player !== pid) return ruleError('NOT_OWNED', obj.id);
  const def = cards[obj.cardId];
  if (!def || !hasKeyword(def, 'Hidden')) {
    return ruleError('HIDDEN_NOT_ALLOWED', 'card lacks Hidden');
  }
  if ((obj.enteredTurn ?? Infinity) >= state.turn.number) {
    return ruleError('HIDDEN_NOT_ALLOWED', 'a hidden card is usable only on a later turn');
  }
  const bfId = obj.zone.battlefieldId;

  const work = fork(state);
  const w = work.objects[obj.id] as CardInstance;
  const bf = work.battlefields.find((b) => b.id === bfId);
  if (bf?.facedownSlotId === w.id) bf.facedownSlotId = null;
  w.zone = { kind: 'hand', player: pid };
  delete w.facedown;
  delete w.hidden;
  w.faceDownPlay = true; // R100: read (and cleared) by playCard
  work.players[playerIndex(pid)].hand.push(w.id);

  // Gains Reaction; base cost reduced to 0 (additional costs still apply).
  const patched: CardDatabase = {
    ...cards,
    [def.cardId]: {
      ...def,
      cost: { energy: 0 },
      keywords: hasKeyword(def, 'Reaction')
        ? def.keywords
        : [...def.keywords, { name: 'Reaction' as const }],
    },
  };
  // 811: Hidden permanents (Gear included) are played to the battlefield they were hidden at.
  const location: PlayCardIntent['location'] =
    def.type === 'UNIT' || def.type === 'GEAR'
      ? { kind: 'battlefield', battlefieldId: bfId }
      : intent.location;
  const adjusted: PlayCardIntent = { ...intent, ...(location ? { location } : {}) };
  return playCard(work, patched, adjusted, resolver, { ...hooks, hiddenAt: bfId });
}

/**
 * Cleanup helper for E9 (107.3.d, 318): facedown cards whose controller no longer controls their
 * battlefield go to their owner's trash. Mutates the WORKING state; returns events (none exist
 * for this yet, so always empty).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function removeOrphanedFacedown(state: GameState, _cards: CardDatabase): GameEventInput[] {
  for (const bf of state.battlefields) {
    if (bf.facedownSlotId === null) continue;
    const o = state.objects[bf.facedownSlotId];
    if (o && o.zone.kind === 'facedown' && bf.controller === o.controller) continue;
    bf.facedownSlotId = null;
    if (!o) continue;
    state.players[playerIndex(o.owner)].trash.push(o.id);
    o.zone = { kind: 'trash', player: o.owner };
    delete o.facedown;
    delete o.hidden;
  }
  return [];
}

// ---------------------------------------------------------------- Deflect

/**
 * Deflect N (809, 356.2.a.2): +N Power per Deflect instance on each targeted unit (on the board)
 * controlled by an opponent of `playerId`. Instances and targets stack. Null if none apply.
 * A Deflect keyword without a value counts as 1.
 */
export function deflectExtraCost(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
  targets: Target[],
): CostMod | null {
  let total = 0;
  // 809: charged for each time a Deflect permanent is chosen as a target (no per-object dedupe).
  for (const t of targets) {
    if (t.kind !== 'object') continue;
    const o = permanentOnBoard(state, cards, t.id);
    if (!o || o.controller === playerId) continue;
    const def = defWithGrants(state, cards, o) as CardDef;
    for (const k of def.keywords) if (k.name === 'Deflect') total += k.value ?? 1;
  }
  return total > 0 ? { anyPower: total } : null;
}

/** PlayHooks for `playCard` with the keyword surcharges (Deflect); `base` hooks are chained. */
export function makePlayHooks(base: PlayHooks = {}): PlayHooks {
  return {
    extraCosts(state, cards, playerId, def, intent) {
      const mine = def.ignoreDeflect
        ? null
        : deflectExtraCost(state, cards, playerId, intent.targets ?? []);
      const other = base.extraCosts?.(state, cards, playerId, def, intent) ?? null;
      if (!mine) return other;
      if (!other) return mine;
      return {
        energy: (mine.energy ?? 0) + (other.energy ?? 0),
        power: (mine.power ?? 0) + (other.power ?? 0),
        anyPower: (mine.anyPower ?? 0) + (other.anyPower ?? 0),
      };
    },
    onEnter(state, cards, objectId, item) {
      const events = base.onEnter?.(state, cards, objectId, item) ?? [];
      // Quick-Draw: attach to the unit chosen at play time (playCard validated it).
      const gear = state.objects[objectId];
      const def = gear ? cards[gear.cardId] : undefined;
      const pick = item?.targets.find((t) => t.kind === 'object');
      if (gear && def?.type === 'GEAR' && hasKeyword(def, 'QuickDraw') && pick?.kind === 'object') {
        const r = quickDrawAttach(state, cards, objectId, pick.id);
        if (r.ok) gear.attachedTo = pick.id;
      }
      return events;
    },
  };
}

// ---------------------------------------------------------------- Equip / Quick-Draw

/** EQUIP (818): attach (or move) Equipment you control to a unit you control. */
export function equip(state: GameState, cards: CardDatabase, intent: EquipIntent): ReduceResult {
  const pid = intent.playerId;
  const timing = canPlayNow(state, cards, pid, PLAIN_TIMING_DEF, { isAbility: true });
  if (!timing.ok) return timing;
  // 151.2: a Gear's activated ability is usable only in your Main Phase during an Open State,
  // never in a Showdown.
  if (state.turnState.kind !== 'NEUTRAL') {
    return ruleError('EQUIP_ILLEGAL', 'Equip cannot be activated during a Showdown (151.2)');
  }
  const eq = state.objects[intent.equipmentId];
  const eqDef = eq ? cards[eq.cardId] : undefined;
  if (!eq || !eqDef) return ruleError('NOT_FOUND', `equipment ${intent.equipmentId}`);
  if (eq.controller !== pid) return ruleError('NOT_OWNED', eq.id);
  if (
    eqDef.type !== 'GEAR' ||
    !eqDef.subtypes.includes('Equipment') ||
    !hasKeyword(eqDef, 'Equip') ||
    eq.zone.kind !== 'base'
  ) {
    return ruleError('EQUIP_ILLEGAL', 'not an Equipment with Equip on your board');
  }
  const unit = isUnitOnBoard(state, cards, intent.unitId);
  if (!unit) return ruleError('EQUIP_ILLEGAL', 'target is not a unit on the board');
  if (unit.controller !== pid) return ruleError('EQUIP_ILLEGAL', 'you do not control that unit');

  const xpCost = eqDef.equipCost?.xp ?? 0;
  if (xpCost > 0 && (state.players[playerIndex(pid)]?.xp ?? 0) < xpCost) {
    return ruleError('INSUFFICIENT_RESOURCES', `not enough XP (need ${xpCost})`);
  }
  const cost = equipTotalCost(state, cards, eqDef, unit);
  const plan = autoPlan(state, cards, pid, cost);
  if (!plan) return ruleError('INSUFFICIENT_RESOURCES', 'cannot pay Equip');
  const paid = payCost(state, cards, pid, cost, plan);
  if (!paid.ok) return paid;
  // 151.2.a / 402.1: activating puts the ability on the Chain; the opponent may respond with a
  // Reaction. The attachment happens when it resolves (see `playResolver`).
  const work = paid.state;
  if (xpCost > 0) {
    const seat = work.players[playerIndex(pid)] as GameState['players'][number];
    seat.xp = (seat.xp ?? 0) - xpCost;
  }
  const item: ChainItem = {
    id: allocObjectId(work),
    kind: 'ABILITY',
    sourceObjectId: eq.id,
    controller: pid,
    status: 'PENDING',
    targets: [{ kind: 'object', id: unit.id }],
    choices: {},
    abilityIndex: EQUIP_ABILITY_INDEX,
  };
  return finalizeAndSettle(pushPendingItem(work, item), cards, item.id);
}

/**
 * Rule 818: total Equip cost. Energy and Power come from `CardDef.equipCost` ([C] = Power of the
 * Equipment's domain(s), [A] = any domain). Without a parsed cost the legacy numeric keyword value
 * is an Energy cost (0 = free). Non-resource parts are not enforced (see ASSUMPTIONS.md).
 */
export function equipTotalCost(
  state: GameState,
  cards: CardDatabase,
  eqDef: CardDef,
  unit?: CardInstance,
  discount?: { power?: number },
): TotalCost {
  const ec = eqDef.equipCost;
  if (!ec) return { energy: keywordValue(eqDef, 'Equip'), power: [] };
  let energy = ec.energy;
  if (ec.energyReducedByMight && unit) {
    const udef = cards[unit.cardId];
    const might =
      baseMight(udef, unit) + unit.mightBonus + attachedMightBonus(state, cards, unit.id);
    energy = Math.max(0, energy - might);
  }
  return computeTotalCost(
    { ...eqDef, cost: { energy, power: ec.power } },
    {
      increases: ec.anyPower > 0 ? [{ anyPower: ec.anyPower }] : [],
      ...(discount ? { discounts: [discount] } : {}),
    },
  );
}

/** Index of the Equip activated ability on a piece of Equipment (the only ability modelled). */
export const EQUIP_ABILITY_INDEX = 0;

/** Quick-Draw: attach gear that just entered play to a unit you control, at no cost. */
export function quickDrawAttach(
  state: GameState,
  cards: CardDatabase,
  gearId: string,
  unitId: string,
): ReduceResult {
  const gear = state.objects[gearId];
  const def = gear ? cards[gear.cardId] : undefined;
  if (!gear || !def) return ruleError('NOT_FOUND', `gear ${gearId}`);
  if (def.type !== 'GEAR' || !hasKeyword(def, 'QuickDraw') || !isOnBoard(gear)) {
    return ruleError('EQUIP_ILLEGAL', 'not a Quick-Draw gear on the board');
  }
  const unit = isUnitOnBoard(state, cards, unitId);
  if (!unit || unit.controller !== gear.controller) {
    return ruleError('EQUIP_ILLEGAL', 'target must be a unit you control');
  }
  const next = fork(state);
  (next.objects[gearId] as CardInstance).attachedTo = unitId;
  return { ok: true, state: next, events: [] };
}

/** Might bonus (137.3) granted to `unitId` by attached Equipment that is on the board. */
export function attachedMightBonus(state: GameState, cards: CardDatabase, unitId: string): number {
  let bonus = 0;
  for (const o of Object.values(state.objects)) {
    if (o.attachedTo !== unitId || !isOnBoard(o)) continue;
    bonus += cards[o.cardId]?.stats.might ?? 0;
  }
  return bonus;
}

// ---------------------------------------------------------------- Legion (812)

/** The part of the state Legion reads; a `GameState` or a sanitised `ClientGameState` both fit (R40). */
export interface LegionState {
  turn: { number: number };
  players: readonly { playedThisTurn?: { turn: number; objectIds: string[] } }[];
}

/**
 * Legion (812, dependent keyword): the Legion effect is active while `playerId` has played another
 * card this turn, i.e. a card other than `sourceId` (the Legion card itself does not count). Plays
 * are recorded by playCard (Hidden plays included) and only count for the current turn number.
 * Pure read; the card effects that depend on it are not wired yet (see docs/progress/R6a).
 */
export function legionActive(state: LegionState, playerId: PlayerId, sourceId: string): boolean {
  const rec = state.players[playerIndex(playerId)]?.playedThisTurn;
  if (!rec || rec.turn !== state.turn.number) return false;
  return rec.objectIds.some((id) => id !== sourceId);
}
