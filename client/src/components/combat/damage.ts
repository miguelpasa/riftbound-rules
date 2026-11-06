/**
 * Pure helpers for the combat damage assignment dialog. They mirror engine/src/combat.ts
 * (effectiveMight, computeAssignmentConstraints, checkAssignment) but work over the sanitised
 * ClientGameState, because the engine functions need a full GameState. Unit tests compare them
 * against the engine on real states.
 */
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  ClientGameState,
  PlayerId,
} from '@riftbound/engine';
import { defWithTemp, opponentOf } from '@riftbound/engine';
import { visibleObject } from '../viewObjects';

export type CombatRole = 'ATTACKER' | 'DEFENDER';
export type AssignmentTier = 'TANK' | 'NORMAL' | 'BACKLINE';

export interface OrderedUnit {
  unitId: string;
  name: string;
  /** Damage still needed to kill it (142.4). */
  lethal: number;
  tier: AssignmentTier;
  /** Effective Might of the unit (for display). */
  might: number;
  /** Damage already marked. */
  damage: number;
  /** Has both Tank and Backline: its assigner picks which applies (467.2.c.8). Listed as Tank. */
  dual?: boolean;
}

export interface ViewConstraints {
  /** The assigner's total Might (the exact total that must be assigned). */
  total: number;
  /** Opponent's units at the battlefield in required order (ties: object id order). */
  ordered: OrderedUnit[];
}

export const TIER_RANK: Record<AssignmentTier, number> = { TANK: 0, NORMAL: 1, BACKLINE: 2 };
export const TIER_LABEL: Record<AssignmentTier, string> = {
  TANK: 'Tank',
  NORMAL: 'Normal',
  BACKLINE: 'Backline',
};

const objNum = (id: string): number => Number(id.slice(1));

/** Units (any controller unless `player` is given) located at the battlefield, by object id. */
export function unitsAtFromView(
  view: ClientGameState,
  bfId: string,
  player?: PlayerId,
): CardInstance[] {
  const out: CardInstance[] = [];
  for (const id of Object.keys(view.objects)) {
    const o = visibleObject(view, id);
    if (!o || o.zone.kind !== 'battlefield' || o.zone.battlefieldId !== bfId) continue;
    if (player !== undefined && o.controller !== player) continue;
    out.push(o);
  }
  return out.sort((a, b) => objNum(a.id) - objNum(b.id));
}

function roleOf(view: ClientGameState, unit: CardInstance): CombatRole | null {
  const c = view.flow.combat;
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

function attachedMightBonus(view: ClientGameState, cards: CardDatabase, unitId: string): number {
  let bonus = 0;
  for (const id of Object.keys(view.objects)) {
    const o = visibleObject(view, id);
    if (!o || o.attachedTo !== unitId || o.zone.kind !== 'base') continue;
    bonus += cards[o.cardId]?.stats.might ?? 0;
  }
  return bonus;
}

/**
 * Might of a unit incl. mightBonus, Assault N (attacker), Shield N (defender) and attached
 * equipment. Same as the engine's effectiveMight; may be negative. `ctx.role` overrides the role
 * derived from view.flow.combat (null ignores keywords).
 */
export function effectiveMightFromView(
  view: ClientGameState,
  cards: CardDatabase,
  unitId: string,
  ctx?: { role?: CombatRole | null },
): number {
  const o = visibleObject(view, unitId);
  if (!o) return 0;
  const def = defWithTemp(cards[o.cardId], o);
  const role = ctx && 'role' in ctx ? (ctx.role ?? null) : roleOf(view, o);
  return (
    (def?.stats.might ?? 0) +
    o.mightBonus +
    keywordBonus(def, role) +
    attachedMightBonus(view, cards, unitId)
  );
}

/** Sum of a side's effective Might at the battlefield; negative Might counts as 0 (143.2.c). */
export function sideTotalFromView(
  view: ClientGameState,
  cards: CardDatabase,
  bfId: string,
  player: PlayerId,
): number {
  return unitsAtFromView(view, bfId, player).reduce(
    (sum, u) => sum + (u.stunned ? 0 : Math.max(0, effectiveMightFromView(view, cards, u.id))),
    0,
  );
}

export function tierOf(def: CardDef | undefined): AssignmentTier {
  if (def?.keywords.some((k) => k.name === 'Tank')) return 'TANK';
  if (def?.keywords.some((k) => k.name === 'Backline')) return 'BACKLINE';
  return 'NORMAL';
}

/** 467.2.c.8: the unit has both Tank and Backline (the assigner chooses which applies). */
export function isDualTier(def: CardDef | undefined): boolean {
  return (
    def?.keywords.some((k) => k.name === 'Tank') === true &&
    def.keywords.some((k) => k.name === 'Backline')
  );
}

/** Required assignment order and total for `assigner` (467.2.c). Empty when there is no combat. */
export function assignmentConstraintsFromView(
  view: ClientGameState,
  cards: CardDatabase,
  assigner: PlayerId,
): ViewConstraints {
  const c = view.flow.combat;
  if (!c) return { total: 0, ordered: [] };
  const ordered = unitsAtFromView(view, c.battlefieldId, opponentOf(assigner))
    .map((o): OrderedUnit => {
      const might = effectiveMightFromView(view, cards, o.id);
      return {
        unitId: o.id,
        name: cards[o.cardId]?.name ?? 'Unknown unit',
        lethal: Math.max(0, Math.max(1, might) - o.damage), // 142.4
        tier: tierOf(defWithTemp(cards[o.cardId], o)),
        might,
        damage: o.damage,
        ...(isDualTier(defWithTemp(cards[o.cardId], o)) ? { dual: true } : {}),
      };
    })
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || objNum(a.unitId) - objNum(b.unitId));
  return { total: sideTotalFromView(view, cards, c.battlefieldId, assigner), ordered };
}

/** Default assignment: lethal in tier order, any remainder on the last unit (engine autoAssign). */
export function autoAssignFromView(constraints: ViewConstraints): Record<string, number> {
  const out: Record<string, number> = {};
  let left = constraints.total;
  for (const u of constraints.ordered) {
    if (left <= 0) break;
    const amount = Math.min(left, u.lethal);
    if (amount > 0) {
      out[u.unitId] = amount;
      left -= amount;
    }
  }
  const last = constraints.ordered[constraints.ordered.length - 1];
  if (left > 0 && last) out[last.unitId] = (out[last.unitId] ?? 0) + left;
  return out;
}

export type AssignmentCheck =
  | { ok: true; assignments: { unitId: string; amount: number }[] }
  | { ok: false; message: string; rule?: string };

/**
 * Validate a distribution (unitId -> amount) exactly like the engine's checkAssignment.
 * Messages name the units; `rule` is the Core Rules citation when one applies.
 */
export function validateAssignment(
  constraints: ViewConstraints,
  amounts: Record<string, number>,
): AssignmentCheck {
  const first = validateOrdered(constraints, amounts);
  const duals = constraints.ordered.filter((u) => u.dual);
  if (first.ok || duals.length === 0 || duals.length > 6) return first;
  // 467.2.c.8: legal if legal for some Tank/Backline choice per dual unit (engine checkAssignment).
  for (let mask = 1; mask < 1 << duals.length; mask++) {
    const asBackline = new Set(duals.filter((_, i) => mask & (1 << i)).map((u) => u.unitId));
    const ordered = constraints.ordered
      .map((u): OrderedUnit => (asBackline.has(u.unitId) ? { ...u, tier: 'BACKLINE' } : u))
      .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || objNum(a.unitId) - objNum(b.unitId));
    const r = validateOrdered({ total: constraints.total, ordered }, amounts);
    if (r.ok) return r;
  }
  return first;
}

function validateOrdered(
  constraints: ViewConstraints,
  amounts: Record<string, number>,
): AssignmentCheck {
  const { total, ordered } = constraints;
  const got = (id: string): number => amounts[id] ?? 0;
  const sum = ordered.reduce((n, u) => n + got(u.unitId), 0);
  if (sum !== total) {
    return {
      ok: false,
      rule: '467.2.c',
      message: `Assign exactly ${total} damage (currently ${sum}). (Rule 467.2.c)`,
    };
  }
  const unmet = ordered.filter((u) => got(u.unitId) < u.lethal);
  const partial = ordered.filter((u) => got(u.unitId) > 0 && got(u.unitId) < u.lethal);
  if (partial.length > 1) {
    return {
      ok: false,
      rule: '467.2.c.3',
      message: 'A unit must receive lethal damage before the next one gets any. (Rule 467.2.c.3)',
    };
  }
  const excessUnits = ordered.filter((u) => got(u.unitId) > u.lethal);
  if (excessUnits.length > 1) {
    return {
      ok: false,
      rule: '467.2.c.4',
      message: `${excessUnits[0]?.name} and ${excessUnits[1]?.name} both exceed lethal; only the last unit assigned may. (Rule 467.2.c.4)`,
    };
  }
  for (const u of ordered) {
    const a = got(u.unitId);
    if (a === 0) continue;
    if (a > u.lethal && ordered.some((v) => TIER_RANK[v.tier] > TIER_RANK[u.tier])) {
      return {
        ok: false,
        rule: '467.2.c.4',
        message: `${u.name} would get more than lethal while a unit of a later tier remains. (Rule 467.2.c.4)`,
      };
    }
    if (a > u.lethal && unmet.some((v) => v.unitId !== u.unitId)) {
      return {
        ok: false,
        rule: '467.2.c.4',
        message: `${u.name} would get more than lethal while another unit lacks lethal. (Rule 467.2.c.4)`,
      };
    }
    const blocker = ordered.find(
      (v) => TIER_RANK[v.tier] < TIER_RANK[u.tier] && got(v.unitId) < v.lethal,
    );
    if (blocker) {
      const rule = blocker.tier === 'TANK' ? '467.2.c' : '467.2.c.6';
      return {
        ok: false,
        rule,
        message: `${blocker.name} (${TIER_LABEL[blocker.tier]}) must be assigned lethal damage before ${u.name} (${TIER_LABEL[u.tier]}). (Rule ${rule})`,
      };
    }
  }
  return {
    ok: true,
    assignments: ordered
      .filter((u) => got(u.unitId) > 0)
      .map((u) => ({ unitId: u.unitId, amount: got(u.unitId) })),
  };
}
