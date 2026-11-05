/**
 * Legal-action enumeration for UI hints and AI players.
 *
 * Guarantee: every returned intent is accepted by `reduce` against the given state. Candidates are
 * generated generously and then FILTERED by actually running the handler (`applyIntent` = `reduce` minus the trailing Cleanup,
 * which never rejects; the fuzz test applies the full `reduce`; the engine is pure), so the
 * list can never disagree with the rules. Conversely the generator is only as complete as its
 * candidate set (documented below); anything it omits is still checked by `reduce` when submitted.
 *
 * Candidates (deterministic order):
 *  - MULLIGAN: keep, each single card, each pair.
 *  - PLAY_CARD: each hand card, Chosen Champion in the champion zone, and own facedown cards,
 *    x location (Base, or each controlled battlefield for Units) x Accelerate, payment = autoPlan.
 *    Targets are generated for spells with DAMAGE_TARGET/BUFF_TARGET effects (one variant per unit on
 *    the board) and for Quick-Draw gear: one variant per unit the player controls (the attach target).
 *  - STANDARD_MOVE: each ready unit to each destination, plus, per origin, "all ready units there".
 *  - ASSIGN_COMBAT_DAMAGE: autoAssign result and a variant that puts the surplus on the first unit.
 *  - HIDE_CARD, EQUIP, PASS_PRIORITY, END_TURN.
 * NOT enumerated: CONCEDE (always legal) and ACTIVATE_RUNE (see `getRuneActivations`).
 *
 * The cheap structural pre-filters (whose turn / priority, chain empty, showdown) only skip candidates
 * `reduce` would reject anyway. When the list exceeds `maxActions` the essential actions
 * (PASS_PRIORITY, END_TURN, the combat assignment) are always kept and the rest is truncated.
 */
import { autoAssign } from './combat.js';
import { isLegalEffectTarget, targetedEffect } from './effects.js';
import { applyIntent, reduce } from './reducer.js';
import { autoPlan, computeTotalCost, getPlayerRunes } from './resources.js';
import { playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  GameState,
  Intent,
  PaymentPlan,
  PlayCardIntent,
  PlayLocation,
  PlayerId,
  StandardMoveIntent,
  Target,
} from './types/index.js';

export interface LegalActionOptions {
  /** Upper bound on the returned list (default 300). */
  maxActions?: number;
}

export const DEFAULT_MAX_ACTIONS = 300;

const UNPLAYABLE = new Set(['LEGEND', 'RUNE', 'BATTLEFIELD', 'TOKEN']);

const hasKw = (def: CardDef | undefined, name: string): boolean =>
  def?.keywords.some((k) => k.name === name) === true;

const num = (id: string): number => Number(id.slice(1));
const byNum = (a: CardInstance, b: CardInstance): number => num(a.id) - num(b.id);

/** Facedown cards play for 0 base cost with Reaction (keywords.playHiddenCard), so cost it that way. */
function costDefFor(obj: CardInstance, def: CardDef): CardDef {
  return obj.zone.kind === 'facedown' ? { ...def, cost: { energy: 0 } } : def;
}

function playCandidates(state: GameState, cards: CardDatabase, pid: PlayerId): Intent[] {
  const ps = state.players[playerIndex(pid)];
  const out: Intent[] = [];
  const sources: CardInstance[] = [];
  const add = (id: string): void => {
    const o = state.objects[id];
    if (o) sources.push(o);
  };
  ps.hand.forEach(add);
  ps.championZone.forEach(add);
  for (const bf of state.battlefields) {
    if (bf.facedownSlotId !== null && state.objects[bf.facedownSlotId]?.controller === pid) {
      add(bf.facedownSlotId);
    }
  }
  const myBattlefields = state.battlefields.filter((b) => b.controller === pid);
  const myUnits = Object.values(state.objects)
    .filter(
      (o) =>
        o.controller === pid &&
        (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
        cards[o.cardId]?.type === 'UNIT',
    )
    .sort(byNum);

  const allUnits = Object.values(state.objects)
    .filter(
      (o) =>
        (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
        cards[o.cardId]?.type === 'UNIT',
    )
    .sort(byNum);

  for (const obj of sources) {
    const def = cards[obj.cardId];
    if (!def || UNPLAYABLE.has(def.type)) continue;
    const isUnit = def.type === 'UNIT';
    const locations: (PlayLocation | undefined)[] = isUnit
      ? obj.zone.kind === 'facedown'
        ? [undefined]
        : [
            { kind: 'base' },
            ...myBattlefields.map((b) => ({ kind: 'battlefield' as const, battlefieldId: b.id })),
          ]
      : [undefined];
    const accelOptions = isUnit && hasKw(def, 'Accelerate') ? [false, true] : [false];
    const costDef = costDefFor(obj, def);
    // Quick-Draw gear: one variant per unit its controller controls (the unit is a Target).
    // Targeted spells (R2): one variant per unit on the board (either side).
    const targetOptions: (Target[] | undefined)[] =
      def.type === 'GEAR' && hasKw(def, 'QuickDraw') && myUnits.length > 0
        ? myUnits.map((u) => [{ kind: 'object' as const, id: u.id }])
        : targetedEffect(def.effects)
          ? allUnits
              .filter((u) =>
                isLegalEffectTarget(state, cards, pid, targetedEffect(def.effects)!, u),
              )
              .map((u) => [{ kind: 'object' as const, id: u.id }])
          : [undefined];
    for (const accelerate of accelOptions) {
      const plan: PaymentPlan | null = autoPlan(
        state,
        cards,
        pid,
        computeTotalCost(costDef, { accelerate }),
      );
      if (plan === null) continue;
      for (const location of locations) {
        for (const targets of targetOptions) {
          const intent: PlayCardIntent = {
            type: 'PLAY_CARD',
            playerId: pid,
            cardInstanceId: obj.id,
            ...(location ? { location } : {}),
            ...(targets ? { targets } : {}),
            ...(accelerate ? { additionalCosts: { accelerate: true } } : {}),
            payment: plan,
          };
          out.push(intent);
        }
      }
    }
  }
  return out;
}

function moveCandidates(state: GameState, cards: CardDatabase, pid: PlayerId): Intent[] {
  const units = Object.values(state.objects)
    .filter(
      (o) =>
        o.controller === pid &&
        o.ready &&
        (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
        cards[o.cardId]?.type === 'UNIT',
    )
    .sort(byNum);
  const origin = (o: CardInstance): string =>
    o.zone.kind === 'battlefield' ? o.zone.battlefieldId : 'base';
  const destinations: PlayLocation[] = [
    { kind: 'base' },
    ...state.battlefields.map((b) => ({ kind: 'battlefield' as const, battlefieldId: b.id })),
  ];
  const seen = new Set<string>();
  const out: Intent[] = [];
  const push = (unitIds: string[], destination: PlayLocation): void => {
    const key = `${unitIds.join(',')}>${destination.kind === 'base' ? 'base' : destination.battlefieldId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const m: StandardMoveIntent = { type: 'STANDARD_MOVE', playerId: pid, unitIds, destination };
    out.push(m);
  };
  for (const u of units) for (const d of destinations) push([u.id], d);
  const origins = [...new Set(units.map(origin))];
  for (const from of origins) {
    const group = units.filter((u) => origin(u) === from).map((u) => u.id);
    if (group.length < 2) continue;
    for (const d of destinations) push(group, d);
  }
  return out;
}

function hideCandidates(state: GameState, cards: CardDatabase, pid: PlayerId): Intent[] {
  const out: Intent[] = [];
  const free = state.battlefields.filter((b) => b.controller === pid && b.facedownSlotId === null);
  for (const id of state.players[playerIndex(pid)].hand) {
    const o = state.objects[id];
    if (!o || !hasKw(cards[o.cardId], 'Hidden')) continue;
    for (const b of free) {
      out.push({ type: 'HIDE_CARD', playerId: pid, cardInstanceId: id, battlefieldId: b.id });
    }
  }
  return out;
}

function equipCandidates(state: GameState, cards: CardDatabase, pid: PlayerId): Intent[] {
  const mine = Object.values(state.objects)
    .filter((o) => o.controller === pid)
    .sort(byNum);
  const gear = mine.filter(
    (o) =>
      o.zone.kind === 'base' && cards[o.cardId]?.type === 'GEAR' && hasKw(cards[o.cardId], 'Equip'),
  );
  const units = mine.filter(
    (o) =>
      (o.zone.kind === 'base' || o.zone.kind === 'battlefield') && cards[o.cardId]?.type === 'UNIT',
  );
  const out: Intent[] = [];
  for (const g of gear) {
    for (const u of units) {
      if (g.attachedTo === u.id) continue;
      out.push({ type: 'EQUIP', playerId: pid, equipmentId: g.id, unitId: u.id });
    }
  }
  return out;
}

function assignCandidates(state: GameState, cards: CardDatabase, pid: PlayerId): Intent[] {
  const base = autoAssign(state, cards, pid);
  const out: Intent[] = [{ type: 'ASSIGN_COMBAT_DAMAGE', playerId: pid, assignments: base }];
  if (base.length >= 2) {
    // Variant: surplus (everything beyond lethal) shifted to the first assigned unit.
    const last = base[base.length - 1] as { unitId: string; amount: number };
    const first = base[0] as { unitId: string; amount: number };
    if (last.amount > 1) {
      const variant = base.map((a) => ({ ...a }));
      (variant[variant.length - 1] as { amount: number }).amount -= 1;
      (variant[0] as { amount: number }).amount = first.amount + 1;
      out.push({ type: 'ASSIGN_COMBAT_DAMAGE', playerId: pid, assignments: variant });
    }
  }
  return out;
}

function mulliganCandidates(state: GameState, pid: PlayerId): Intent[] {
  const hand = state.players[playerIndex(pid)].hand;
  const out: Intent[] = [{ type: 'MULLIGAN', playerId: pid, cardIds: [] }];
  for (const id of hand) out.push({ type: 'MULLIGAN', playerId: pid, cardIds: [id] });
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      out.push({
        type: 'MULLIGAN',
        playerId: pid,
        cardIds: [hand[i] as string, hand[j] as string],
      });
    }
  }
  return out;
}

/** Every intent `playerId` could legally submit right now (see file header). Deterministic. */
export function getLegalActions(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
  opts: LegalActionOptions = {},
): Intent[] {
  const max = Math.max(1, opts.maxActions ?? DEFAULT_MAX_ACTIONS);
  if (state.gameStatus !== 'IN_PROGRESS') return [];
  const accepted = (i: Intent): boolean => applyIntent(state, cards, i).ok;
  const keep = (list: Intent[]): Intent[] => list.filter(accepted);

  if (state.turn.phase === 'MULLIGAN') {
    return keep(mulliganCandidates(state, playerId)).slice(0, max);
  }

  const flow = state.flow;
  const awaiting = flow.combat?.awaitingAssignmentFrom ?? null;
  if (awaiting !== null) {
    return awaiting === playerId
      ? keep(assignCandidates(state, cards, playerId)).slice(0, max)
      : [];
  }
  if (flow.priority !== playerId) return [];

  const neutralOpen = !flow.showdown && !flow.combat && flow.chain.length === 0;
  const essential: Intent[] = [];
  const pass: Intent = { type: 'PASS_PRIORITY', playerId };
  const end: Intent = { type: 'END_TURN', playerId };
  if (!neutralOpen && accepted(pass)) essential.push(pass);
  if (neutralOpen && state.turn.activePlayer === playerId && accepted(end)) essential.push(end);

  const budget = Math.max(0, max - essential.length);
  const others: Intent[] = [];
  const take = (cands: Intent[]): void => {
    for (const c of cands) {
      if (others.length >= budget) return;
      if (accepted(c)) others.push(c);
    }
  };
  take(playCandidates(state, cards, playerId));
  if (neutralOpen) {
    take(moveCandidates(state, cards, playerId));
    take(hideCandidates(state, cards, playerId));
    take(equipCandidates(state, cards, playerId));
  }
  return [...others, ...essential];
}

/** Rune activations (EXHAUST for energy, RECYCLE for power) the player may perform now, for the UI. */
export function getRuneActivations(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
): Intent[] {
  if (state.gameStatus !== 'IN_PROGRESS' || state.turn.phase === 'MULLIGAN') return [];
  const out: Intent[] = [];
  for (const r of getPlayerRunes(state, cards, playerId)) {
    for (const mode of ['EXHAUST', 'RECYCLE'] as const) {
      const i: Intent = { type: 'ACTIVATE_RUNE', playerId, runeId: r.id, mode };
      if (reduce(state, cards, i).ok) out.push(i);
    }
  }
  return out;
}
