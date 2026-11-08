/**
 * Combat (Core Rules 461-468, 142-143, 316.7, 467.2.c). Combat keywords Tank, Backline, Assault N,
 * Shield N live here (other keywords: keywords.ts).
 *
 * Pure: exported state-returning functions structuredClone first. `killLethalUnits` is the one
 * exception (documented): it MUTATES a working state so the cleanup loop (E9) can reuse it.
 *
 * Flow (CombatState.step):
 *  1. SHOWDOWN (466): startCombat sets flow.combat {battlefieldId, attacker, defender} and opens a
 *     combat Showdown with showdown.startShowdown(..., true). attacker = the battlefield's
 *     contestedBy (fallback: the turn player), defender = the opponent. The designation applies to
 *     the units there (a unit is an Attacker iff its controller is the attacker, 466.2.c). Start of
 *     combat effects: none in the MVP (extension point: startCombat). When the Showdown closes,
 *     showdown.closeShowdown calls continueCombat (348.1).
 *  2. DAMAGE (467): sides with total Might 0 skip assigning. Otherwise the Attacker assigns first
 *     (awaitingAssignmentFrom), then the Defender; assignment is not dealing (467.2.c.1). When both
 *     are in, damage is dealt simultaneously (467.2.d) and the step becomes RESOLUTION. Nobody has
 *     Focus or Priority during DAMAGE/RESOLUTION (priority = null). If a side has no units when
 *     the damage step is entered, the step goes straight to RESOLUTION (no damage). No chain (467.3).
 *  3. RESOLUTION (468): the cleanup loop (E9) kills units with lethal damage (killLethalUnits) and then
 *     calls resolveCombat: heal survivors at the battlefield (468.1.a.1), compute the Result from the
 *     survivors (468.3), recall the Attackers if Defenders remain (468.1.a.2, 456: to base, not a
 *     Move), establish control (468.5; Conquer through deps.onConquer when the player does not
 *     control it and has not scored it this turn, same test as showdown.closeShowdown), or make the
 *     battlefield Uncontrolled if empty, then end combat (468.7): designations, flow.combat and
 *     flow.showdown cleared, Neutral Open, Priority to the turn player.
 *
 * Decisions:
 *  - Effective Might = stats.might + mightBonus + (Assault N if Attacker) + (Shield N if Defender).
 *    Negative Might counts as 0 in the side sum (143.2.c). Assault without a value counts as 1.
 *  - Lethal damage for a unit = max(1, effective Might) - damage already marked (142.4), min 0.
 *  - Assignment legality: units are ordered by tier (TANK < NORMAL < BACKLINE). A unit with BOTH
 *    Tank and Backline (467.2.c.8) lets the assigner choose which applies: it is listed as TANK
 *    (the default order, used by autoAssign) and flagged `dual`; checkAssignment accepts the
 *    assignment if it is legal for ANY choice of Tank/Backline for each dual unit (so such a unit
 *    may be assigned first OR last). A unit may receive damage only if every unit of an earlier tier already
 *    has lethal (467.2.c.3/6). At most one unit may be short of lethal (the last one funded), and
 *    nobody may receive more than lethal while some unit still lacks lethal (467.2.c.4). Excess is
 *    only allowed on the unit assigned LAST: at most one unit may exceed lethal, and none of a
 *    strictly later tier may exist (equal-tier ties are the assigner's choice, so the excess unit
 *    simply goes last among its tier).
 *    Units that are already lethal need 0 and count as satisfied. Total assigned must equal the
 *    assigner's total Might exactly.
 *  - Errors: wrong step WRONG_PHASE, wrong player NOT_YOUR_PRIORITY, unknown unit NOT_FOUND, unit not
 *    an enemy at this battlefield ILLEGAL_TARGET, everything else INVALID_DAMAGE_ASSIGNMENT.
 *  - Combat has no event of its own for its Result; resolveCombatWithResult also returns it.
 *  - killLethalUnits applies to UNIT/TOKEN objects with Might in base or at a battlefield. A killed
 *    unit goes to its owner's trash with damage and mightBonus reset; attached equipment is detached
 *    (attachedTo cleared) and stays where it is. A killed TOKEN ceases to exist instead (186.1):
 *    it is deleted from the game and UNIT_KILLED is still emitted.
 */
import { baseMight } from './baseMight.js';
import { fork } from './workingCopy.js';
import { killGear } from './effects.js';
import { defWithGrants, staticBonus } from './statics.js';
import { recordDeath, tracksCombatEnd, tracksExcess } from './conditions.js';
import { attachedMightBonus, removeTokenFromGame } from './keywords.js';
import { syncTurnState } from './chain.js';
import { onConquer as scoringOnConquer } from './scoring.js';
import { stampEvents } from './setup.js';
import { establishControl, playersWithUnitsAt, startShowdown, unitsAt } from './showdown.js';
import type { ShowdownDeps, ShowdownHookResult } from './showdown.js';
import { opponentOf, playerIndex } from './types/constants.js';
import { ruleError } from './types/errors.js';
import type {
  AssignCombatDamageIntent,
  CardDatabase,
  CardDef,
  CardInstance,
  CombatState,
  GameEventInput,
  GameState,
  PlayerId,
  ReduceResult,
  RuleError,
} from './types/index.js';
import { clearBoardState } from './zoneReset.js';

export type CombatRole = 'ATTACKER' | 'DEFENDER';
export type AssignmentTier = 'TANK' | 'NORMAL' | 'BACKLINE';
export type CombatResultKind = 'ATTACKER_WINS' | 'DEFENDER_WINS' | 'NO_RESULT';

export interface UnitAssignment {
  unitId: string;
  amount: number;
}

export interface AssignmentConstraints {
  /** The assigner's total Might (the exact total that must be assigned). */
  total: number;
  /** Opponent's units in required assignment order (by tier; ties are the assigner's choice). */
  ordered: { unitId: string; lethal: number; tier: AssignmentTier; dual?: true }[];
}

export interface CombatDeps {
  onConquer?: ShowdownDeps['onConquer'];
}

const TIER_RANK: Record<AssignmentTier, number> = { TANK: 0, NORMAL: 1, BACKLINE: 2 };

// ---------------------------------------------------------------- might

function objNum(id: string): number {
  return Number(id.slice(1));
}

/** Role of `unit` in the ongoing combat (null outside combat or away from its battlefield). */
function roleOf(state: GameState, unit: CardInstance): CombatRole | null {
  const c = state.flow.combat;
  if (!c) return null;
  if (unit.zone.kind !== 'battlefield' || unit.zone.battlefieldId !== c.battlefieldId) return null;
  if (unit.controller === c.attacker) return 'ATTACKER';
  if (unit.controller === c.defender) return 'DEFENDER';
  return null;
}

function keywordBonus(def: CardDef | undefined, role: CombatRole | null): number {
  if (!def || role === null) return 0;
  const name = role === 'ATTACKER' ? 'Assault' : 'Shield';
  return def.keywords.filter((k) => k.name === name).reduce((sum, k) => sum + (k.value ?? 1), 0);
}

/**
 * Might of a unit including mightBonus and combat keyword bonuses. `ctx.role` overrides the role
 * derived from flow.combat (pass null to ignore keywords). May be negative (143.2.c is applied by
 * the side sums, not here).
 */
export function effectiveMight(
  state: GameState,
  cards: CardDatabase,
  unitId: string,
  ctx?: { role?: CombatRole | null },
): number {
  const o = state.objects[unitId];
  if (!o) return 0;
  const def = defWithGrants(state, cards, o);
  const role = ctx && 'role' in ctx ? (ctx.role ?? null) : roleOf(state, o);
  return (
    baseMight(def, o) +
    o.mightBonus +
    keywordBonus(def, role) +
    staticBonus(state, cards, o).might +
    (o.buffed ? 1 : 0) +
    attachedMightBonus(state, cards, unitId)
  );
}

function sideTotal(state: GameState, cards: CardDatabase, bfId: string, player: PlayerId): number {
  return unitsAt(state, bfId, player).reduce(
    // 143.2.c negative Might counts as 0; a Stunned unit contributes no Might to combat damage.
    (sum, u) =>
      sum +
      (u.stunned || staticBonus(state, cards, u).noCombatDamage === true
        ? 0
        : Math.max(0, effectiveMight(state, cards, u.id))),
    0,
  );
}

/** 467.2.c.8: the unit has both Tank and Backline, so its assigner chooses which applies. */
function isDualTier(def: CardDef | undefined): boolean {
  return (
    def?.keywords.some((k) => k.name === 'Tank') === true &&
    def.keywords.some((k) => k.name === 'Backline')
  );
}

function tierOf(def: CardDef | undefined): AssignmentTier {
  if (def?.keywords.some((k) => k.name === 'Tank')) return 'TANK';
  if (def?.keywords.some((k) => k.name === 'Backline')) return 'BACKLINE';
  return 'NORMAL';
}

function lethalNeeded(state: GameState, cards: CardDatabase, o: CardInstance): number {
  return Math.max(0, Math.max(1, effectiveMight(state, cards, o.id)) - o.damage); // 142.4
}

// ---------------------------------------------------------------- assignment helpers

/** Required assignment order and total for `assigner` (467.2.c). Empty when no combat. */
export function computeAssignmentConstraints(
  state: GameState,
  cards: CardDatabase,
  assigner: PlayerId,
  /** Tank/Backline choice for dual-keyword units (467.2.c.8); default: Tank. */
  tierOverrides: Record<string, AssignmentTier> = {},
): AssignmentConstraints {
  const c = state.flow.combat;
  if (!c) return { total: 0, ordered: [] };
  const ordered = unitsAt(state, c.battlefieldId, opponentOf(assigner))
    .map((o) => ({
      unitId: o.id,
      lethal: lethalNeeded(state, cards, o),
      tier: tierOverrides[o.id] ?? tierOf(defWithGrants(state, cards, o)),
      ...(isDualTier(defWithGrants(state, cards, o)) ? { dual: true as const } : {}),
    }))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || objNum(a.unitId) - objNum(b.unitId));
  return { total: sideTotal(state, cards, c.battlefieldId, assigner), ordered };
}

/** A valid default assignment: lethal in tier order, any remainder on the last unit. */
export function autoAssign(
  state: GameState,
  cards: CardDatabase,
  assigner: PlayerId,
): UnitAssignment[] {
  const { total, ordered } = computeAssignmentConstraints(state, cards, assigner);
  const out: UnitAssignment[] = [];
  let left = total;
  for (const u of ordered) {
    if (left <= 0) break;
    const amount = Math.min(left, u.lethal);
    if (amount > 0) {
      out.push({ unitId: u.unitId, amount });
      left -= amount;
    }
  }
  if (left > 0 && ordered.length > 0) {
    const last = ordered[ordered.length - 1] as AssignmentConstraints['ordered'][number];
    const existing = out.find((a) => a.unitId === last.unitId);
    if (existing) existing.amount += left;
    else out.push({ unitId: last.unitId, amount: left });
  }
  return out;
}

type Checked = { ok: true; assignments: UnitAssignment[] } | { ok: false; result: ReduceResult };

/** 467.2.c.8: legal if it is legal for some Tank/Backline choice per dual unit (default Tank errors). */
function checkAssignment(
  state: GameState,
  cards: CardDatabase,
  assigner: PlayerId,
  raw: UnitAssignment[],
): Checked {
  const duals = computeAssignmentConstraints(state, cards, assigner).ordered.filter((u) => u.dual);
  const first = checkAssignmentWith(state, cards, assigner, raw, {});
  if (first.ok || duals.length === 0 || duals.length > 6) return first;
  for (let mask = 1; mask < 1 << duals.length; mask++) {
    const overrides: Record<string, AssignmentTier> = {};
    duals.forEach((u, i) => {
      if (mask & (1 << i)) overrides[u.unitId] = 'BACKLINE';
    });
    const r = checkAssignmentWith(state, cards, assigner, raw, overrides);
    if (r.ok) return r;
  }
  return first;
}

function checkAssignmentWith(
  state: GameState,
  cards: CardDatabase,
  assigner: PlayerId,
  raw: UnitAssignment[],
  overrides: Record<string, AssignmentTier>,
): Checked {
  const fail = (code: Parameters<typeof ruleError>[0], detail: string): Checked => ({
    ok: false,
    result: ruleError(code, detail),
  });
  const { total, ordered } = computeAssignmentConstraints(state, cards, assigner, overrides);
  const byId = new Map(ordered.map((u) => [u.unitId, u]));
  const amounts = new Map<string, number>();
  for (const a of raw) {
    if (!state.objects[a.unitId]) return fail('NOT_FOUND', `unit ${a.unitId}`);
    if (!byId.has(a.unitId)) {
      return fail('ILLEGAL_TARGET', `${a.unitId} is not an enemy unit at this battlefield`);
    }
    if (!Number.isInteger(a.amount) || a.amount < 0) {
      return fail(
        'INVALID_DAMAGE_ASSIGNMENT',
        `amount for ${a.unitId} must be a whole number >= 0`,
      );
    }
    if (amounts.has(a.unitId)) {
      return fail('INVALID_DAMAGE_ASSIGNMENT', `${a.unitId} appears more than once`);
    }
    amounts.set(a.unitId, a.amount);
  }
  const sum = [...amounts.values()].reduce((x, y) => x + y, 0);
  if (sum !== total) {
    return fail(
      'INVALID_DAMAGE_ASSIGNMENT',
      `assign exactly ${total} damage (got ${sum}) (467.2.c)`,
    );
  }
  const got = (id: string): number => amounts.get(id) ?? 0;
  const unmet = ordered.filter((u) => got(u.unitId) < u.lethal);
  const partial = ordered.filter((u) => got(u.unitId) > 0 && got(u.unitId) < u.lethal);
  if (partial.length > 1) {
    return fail(
      'INVALID_DAMAGE_ASSIGNMENT',
      'a unit must receive lethal damage before the next gets any (467.2.c.3)',
    );
  }
  const excessUnits = ordered.filter((u) => got(u.unitId) > u.lethal);
  if (excessUnits.length > 1) {
    // Only the unit assigned LAST may exceed lethal (467.2.c.4); two excesses cannot both be last.
    return fail(
      'INVALID_DAMAGE_ASSIGNMENT',
      `${excessUnits[0]?.unitId} and ${excessUnits[1]?.unitId} both exceed lethal; only the last unit assigned may (467.2.c.4)`,
    );
  }
  for (const u of ordered) {
    const a = got(u.unitId);
    if (a === 0) continue;
    if (a > u.lethal && unmet.some((v) => v.unitId !== u.unitId)) {
      return fail(
        'INVALID_DAMAGE_ASSIGNMENT',
        `${u.unitId} would get more than lethal while another unit lacks lethal (467.2.c.4)`,
      );
    }
    if (a > u.lethal && ordered.some((v) => TIER_RANK[v.tier] > TIER_RANK[u.tier])) {
      return fail(
        'INVALID_DAMAGE_ASSIGNMENT',
        `${u.unitId} would get more than lethal while a unit of a later tier remains (467.2.c.4)`,
      );
    }
    const blocker = ordered.find(
      (v) => TIER_RANK[v.tier] < TIER_RANK[u.tier] && got(v.unitId) < v.lethal,
    );
    if (blocker) {
      const rule = blocker.tier === 'TANK' ? '467.2.c' : '467.2.c.6';
      return fail(
        'INVALID_DAMAGE_ASSIGNMENT',
        `${blocker.unitId} (${blocker.tier}) must be assigned lethal damage before ${u.unitId} (${u.tier}) (${rule})`,
      );
    }
  }
  const assignments = ordered
    .filter((u) => got(u.unitId) > 0)
    .map((u) => ({ unitId: u.unitId, amount: got(u.unitId) }));
  return { ok: true, assignments };
}

// ---------------------------------------------------------------- hook adapters

/** Convert a stamped ReduceResult into an unstamped ShowdownHookResult (state unchanged on error). */
function toHook(before: GameState, r: ReduceResult): ShowdownHookResult {
  if (!r.ok) return { state: before, events: [] };
  const state = fork(r.state);
  state.nextEventSeq -= r.events.length; // the caller restamps
  const events = r.events.map((e) => {
    const copy: Record<string, unknown> = { ...e };
    delete copy.seq;
    return copy as GameEventInput;
  });
  return { state, events };
}

// ---------------------------------------------------------------- step 1: start

/** Begin combat at `bfId` with a combat Showdown (462, 466). Call with no Showdown/combat ongoing. */
export function startCombat(state: GameState, cards: CardDatabase, bfId: string): ReduceResult {
  void cards; // start-of-combat effects: none in the MVP (466.1)
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  const bf = state.battlefields.find((b) => b.id === bfId);
  if (!bf) return ruleError('NOT_FOUND', `battlefield ${bfId}`);
  if (state.flow.combat || state.flow.showdown) {
    return ruleError('WRONG_PHASE', 'a Showdown or combat is already ongoing (462)');
  }
  const attacker = bf.contestedBy ?? state.turn.activePlayer; // 466.2.c
  const next = fork(state);
  next.flow.combat = {
    battlefieldId: bfId,
    attacker,
    defender: opponentOf(attacker),
    step: 'SHOWDOWN',
  };
  return startShowdown(next, bfId, attacker, true);
}

/** ShowdownDeps.startCombat-compatible form of startCombat. */
export function startCombatHook(
  state: GameState,
  cards: CardDatabase,
  bfId: string,
): ShowdownHookResult {
  return toHook(state, startCombat(state, cards, bfId));
}

// ---------------------------------------------------------------- step 2: damage

function enterDamage(s: GameState, cards: CardDatabase): void {
  const c = s.flow.combat as CombatState;
  s.flow.focus = null;
  s.flow.priority = null;
  delete c.damageAssignment;
  const present = playersWithUnitsAt(s, c.battlefieldId);
  if (present.length < 2) {
    c.step = 'RESOLUTION'; // 467.1: damage needs units on both sides
    c.awaitingAssignmentFrom = null;
    return;
  }
  c.step = 'DAMAGE';
  advanceAssignment(s, cards);
}

/** After the damage step starts or a side assigned: pick the next assigner or deal. */
function advanceAssignment(s: GameState, cards: CardDatabase): GameEventInput[] {
  const c = s.flow.combat as CombatState;
  const done = c.damageAssignment ?? {};
  for (const p of [c.attacker, c.defender]) {
    if (done[p] === undefined && sideTotal(s, cards, c.battlefieldId, p) > 0) {
      c.awaitingAssignmentFrom = p;
      return [];
    }
  }
  c.awaitingAssignmentFrom = null;
  return dealDamage(s);
}

/** Deal both stored assignments simultaneously (467.2.d); the step becomes RESOLUTION. */
function dealDamage(s: GameState): GameEventInput[] {
  const c = s.flow.combat as CombatState;
  const events: GameEventInput[] = [];
  for (const p of [c.attacker, c.defender]) {
    for (const a of c.damageAssignment?.[p] ?? []) {
      const o = s.objects[a.unitId];
      if (!o || a.amount <= 0) continue;
      o.damage += a.amount;
      events.push({
        type: 'COMBAT_DAMAGE_ASSIGNED',
        player: p,
        unitId: a.unitId,
        amount: a.amount,
      });
    }
  }
  delete c.damageAssignment;
  c.step = 'RESOLUTION';
  return events;
}

/** A combat Showdown closed (348.1): move to the damage step. Pure; no-op without flow.combat. */
export function continueCombat(state: GameState, cards: CardDatabase): ReduceResult {
  if (!state.flow.combat) return ruleError('NOT_FOUND', 'no combat in progress');
  const s = fork(state);
  enterDamage(s, cards);
  const synced = syncTurnState(s);
  return { ok: true, state: synced, events: [] };
}

/** ShowdownDeps.continueCombat-compatible form of continueCombat. */
export function continueCombatHook(state: GameState, cards: CardDatabase): ShowdownHookResult {
  return toHook(state, continueCombat(state, cards));
}

/** ASSIGN_COMBAT_DAMAGE (467.2.c). */
export function assignCombatDamage(
  state: GameState,
  cards: CardDatabase,
  intent: AssignCombatDamageIntent,
): ReduceResult {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  const c = state.flow.combat;
  if (!c || c.step !== 'DAMAGE') return ruleError('WRONG_PHASE', 'not in the combat damage step');
  if (c.awaitingAssignmentFrom !== intent.playerId) {
    return ruleError(
      'NOT_YOUR_PRIORITY',
      `waiting for ${String(c.awaitingAssignmentFrom)} to assign`,
    );
  }
  const checked = checkAssignment(state, cards, intent.playerId, intent.assignments);
  if (!checked.ok) return checked.result;

  const s = fork(state);
  const cc = s.flow.combat as CombatState;
  cc.damageAssignment = { ...(cc.damageAssignment ?? {}), [intent.playerId]: checked.assignments };
  // R87: excess = damage assigned beyond what is needed to kill each enemy unit.
  if (intent.playerId === cc.attacker && tracksExcess(cards)) {
    let excess = 0;
    for (const a of checked.assignments) {
      const u = s.objects[a.unitId];
      if (!u || u.controller === intent.playerId) continue;
      const need = Math.max(1, effectiveMight(s, cards, u.id)) - u.damage;
      excess += Math.max(0, a.amount - Math.max(0, need));
    }
    cc.excess = excess;
  }
  const events = advanceAssignment(s, cards);
  const synced = syncTurnState(s);
  return { ok: true, state: synced, events: stampEvents(synced, events) };
}

// ---------------------------------------------------------------- killing (cleanup 323.4)

/**
 * MUTATES the working state. Kills every UNIT/TOKEN in base or at a battlefield whose damage is at
 * least its lethal threshold max(1, effective Might) (142.4): to its owner's trash, equipment
 * detached. Returns UNIT_KILLED event inputs (object order).
 */
export function killLethalUnits(state: GameState, cards: CardDatabase): GameEventInput[] {
  const events: GameEventInput[] = [];
  const ids = Object.keys(state.objects).sort((a, b) => objNum(a) - objNum(b));
  // R71: "died alone" = no other friendly unit stood at its location when the batch of deaths began.
  const locOf = (o: CardInstance): string =>
    o.zone.kind === 'battlefield' ? o.zone.battlefieldId : 'base';
  const crowd = new Map<string, number>();
  for (const id of ids) {
    const o = state.objects[id] as CardInstance;
    const t = cards[o.cardId]?.type;
    if (
      (t !== 'UNIT' && t !== 'TOKEN') ||
      (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield')
    )
      continue;
    const key = o.controller + '|' + locOf(o);
    crowd.set(key, (crowd.get(key) ?? 0) + 1);
  }
  for (const id of ids) {
    const o = state.objects[id] as CardInstance;
    const def = cards[o.cardId];
    if (!def || (def.type !== 'UNIT' && def.type !== 'TOKEN')) continue;
    if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
    if (o.damage <= 0 || o.damage < Math.max(1, effectiveMight(state, cards, id))) continue;
    if (o.deathReplace) {
      events.push(replaceDeath(state, cards, o));
      continue;
    }
    const standing = staticBonus(state, cards, o).replaceDeath;
    if (standing) {
      const src = state.objects[standing.sourceId];
      if (standing.killSource && src && cards[src.cardId]?.type === 'GEAR') {
        killGear(state, src);
        events.push({ type: 'GEAR_KILLED', gearId: src.id });
      }
      o.deathReplace = 'RECALL';
      events.push(replaceDeath(state, cards, o));
      continue;
    }
    const death = {
      type: 'UNIT_KILLED' as const,
      unitId: id,
      controller: o.controller,
      cardId: o.cardId,
      at: locOf(o),
      alone: (crowd.get(o.controller + '|' + locOf(o)) ?? 1) <= 1,
    };
    const ps = state.players[playerIndex(o.controller)];
    ps.base = ps.base.filter((x) => x !== id);
    recordDeath(state, cards, o.controller); // R56
    if (def.type === 'TOKEN') {
      // 186.1: a token outside the Board ceases to exist; it does not go to the trash.
      removeTokenFromGame(state, id);
      events.push(death);
      continue;
    }
    const owner = state.players[playerIndex(o.owner)];
    owner.trash.push(id);
    o.zone = { kind: 'trash', player: o.owner };
    o.controller = o.owner;
    clearBoardState(o);
    o.ready = false;
    for (const g of Object.values(state.objects)) {
      if (g.attachedTo === id) delete g.attachedTo;
    }
    events.push(death);
  }
  return events;
}

/**
 * X7 (573, 575): a one-shot "the next time it would die this turn ... instead" replacement. RECALL heals,
 * exhausts and sends the unit to its controller's Base (a recall is not a move: no UNIT_MOVED, no move
 * triggers); BANISH exiles it (a token ceases to exist). The unit never dies, so no death trigger fires.
 * MUTATES the working state.
 */
function replaceDeath(state: GameState, cards: CardDatabase, o: CardInstance): GameEventInput {
  const mode = o.deathReplace as 'RECALL' | 'BANISH';
  const event = { type: 'UNIT_DEATH_REPLACED' as const, unitId: o.id, cardId: o.cardId, mode };
  delete o.deathReplace;
  if (mode === 'RECALL') {
    o.damage = 0;
    o.ready = false;
    if (o.zone.kind === 'battlefield') {
      o.zone = { kind: 'base', player: o.controller };
      state.players[playerIndex(o.controller)].base.push(o.id);
    }
    return event;
  }
  const ps = state.players[playerIndex(o.controller)];
  ps.base = ps.base.filter((x) => x !== o.id);
  if (cards[o.cardId]?.type === 'TOKEN') {
    removeTokenFromGame(state, o.id);
  } else {
    const owner = state.players[playerIndex(o.owner)];
    owner.banishment.push(o.id);
    o.zone = { kind: 'banishment', player: o.owner };
    o.controller = o.owner;
    clearBoardState(o);
    for (const g of Object.values(state.objects)) {
      if (g.attachedTo === o.id) delete g.attachedTo;
    }
  }
  return event;
}

// ---------------------------------------------------------------- step 3: resolution

/** Result of the combat from the surviving units (468.3). */
export function combatResult(state: GameState): CombatResultKind {
  const c = state.flow.combat;
  if (!c) return 'NO_RESULT';
  const att = unitsAt(state, c.battlefieldId, c.attacker).length > 0;
  const def = unitsAt(state, c.battlefieldId, c.defender).length > 0;
  if (att && !def) return 'ATTACKER_WINS';
  if (def && !att) return 'DEFENDER_WINS';
  return 'NO_RESULT';
}

export interface ResolveResult {
  state: GameState;
  events: ReturnType<typeof stampEvents>;
  result: CombatResultKind;
}

/**
 * Combat Resolution (468) after the cleanup loop has killed lethally damaged units. Requires
 * flow.combat in the RESOLUTION step. `deps.onConquer` defaults to scoring.onConquer.
 */
export function resolveCombatWithResult(
  state: GameState,
  cards: CardDatabase,
  deps: CombatDeps = {},
): ResolveResult | RuleError {
  const c0 = state.flow.combat;
  if (!c0 || c0.step !== 'RESOLUTION') {
    return ruleError('WRONG_PHASE', 'combat is not in the Resolution step');
  }
  let s = fork(state);
  const c = s.flow.combat as CombatState;
  const bfId = c.battlefieldId;
  const inputs: GameEventInput[] = [];

  // 468.1.a.1 (step 3c): heal ALL units, not only those at the combat battlefield.
  for (const o of Object.values(s.objects)) {
    if (o.zone.kind === 'base' || o.zone.kind === 'battlefield') o.damage = 0;
  }

  const result = combatResult(s); // 468.3
  // R71: the units standing at the battlefield when the combat ends (before the attackers are recalled).
  const participants = [...unitsAt(s, bfId, c.attacker), ...unitsAt(s, bfId, c.defender)].map(
    (u) => u.id,
  );
  if (tracksCombatEnd(cards)) {
    inputs.push({
      type: 'COMBAT_ENDED',
      battlefieldId: bfId,
      winner:
        result === 'ATTACKER_WINS' ? c.attacker : result === 'DEFENDER_WINS' ? c.defender : null,
      participants,
    });
  }

  if (unitsAt(s, bfId, c.defender).length > 0) {
    // 468.1.a.2: Recall the Attackers to their base (456); not a Move.
    for (const u of unitsAt(s, bfId, c.attacker)) {
      u.zone = { kind: 'base', player: u.controller };
      s.players[playerIndex(u.controller)].base.push(u.id);
      inputs.push({ type: 'UNIT_MOVED', unitId: u.id, from: bfId, to: 'base' });
    }
  }

  const present = playersWithUnitsAt(s, bfId); // 468.5
  const bf = s.battlefields.find((b) => b.id === bfId);
  let conquerer: PlayerId | null = null;
  if (bf && present.length === 1) {
    const p = present[0] as PlayerId;
    if (bf.controller !== p && !bf.scoredThisTurnBy.includes(p)) conquerer = p;
    inputs.push(...establishControl(s, bfId, p));
  } else if (bf && present.length === 0) {
    bf.contestedBy = null;
    if (bf.controller !== null) {
      bf.controller = null;
      inputs.push({ type: 'BATTLEFIELD_CONTROL_CHANGED', battlefieldId: bfId, controller: null });
    }
  }
  if (conquerer) {
    const onConquer = deps.onConquer ?? scoringOnConquer;
    const r = onConquer(s, conquerer, bfId, cards);
    s = fork(r.state);
    inputs.push(...r.events);
  }

  if (c.excess !== undefined) {
    s.players[playerIndex(c.attacker)].excessRecord = { turn: s.turn.number, amount: c.excess };
  }
  delete s.flow.combat; // 468.7
  delete s.flow.showdown;
  s.flow.focus = null;
  s.flow.priority = s.turn.activePlayer;
  s = syncTurnState(s);
  return { state: s, events: stampEvents(s, inputs), result };
}

/** resolveCombatWithResult as a plain ReduceResult. */
export function resolveCombat(
  state: GameState,
  cards: CardDatabase,
  deps: CombatDeps = {},
): ReduceResult {
  const r = resolveCombatWithResult(state, cards, deps);
  if ('ok' in r) return r;
  return { ok: true, state: r.state, events: r.events };
}
