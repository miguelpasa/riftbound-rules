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
 *  - CHOOSE_STAGED / CHOOSE_TRIGGER_TARGET / DECIDE_OPTIONAL (R45): while flow.pendingChoice is set, ONLY that choice's options
 *    (to its player); trigger targets are enumerated like a spell's (capped by MAX_TARGET_COMBOS).
 *  - ACTIVATE_ABILITY: one variant per target choice for abilities that choose units (R41).
 * NOT enumerated: CONCEDE (always legal) and ACTIVATE_RUNE (see `getRuneActivations`).
 *
 * The cheap structural pre-filters (whose turn / priority, chain empty, showdown) only skip candidates
 * `reduce` would reject anyway. When the list exceeds `maxActions` the essential actions
 * (PASS_PRIORITY, END_TURN, the combat assignment) are always kept and the rest is truncated.
 */
import { abilityCandidates } from './abilities.js';
import { selfEnergyDiscount } from './costReduction.js';
import { autoAssign } from './combat.js';
import { MAX_TARGET_COMBOS, enumerateSpellTargets, spellEffects } from './effects.js';
import { hasUnitAt, playToAllowed } from './play.js';
import { applyIntent, reduce } from './reducer.js';
import { abilityItemEffects, allowedModes, triggerDefOf, triggerSourceCardId } from './triggers.js';
import { optionalPlan } from './optional.js';
import { costCardCombos, playCostCard } from './costCards.js';
import { itemSourceId } from './sources.js';
import { autoPlan, computeTotalCost, getPlayerRunes } from './resources.js';
import type { TotalCost } from './resources.js';
import { isDeployGear, isUnitDef } from './tokens.js';
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
        isUnitDef(cards[o.cardId]),
    )
    .sort(byNum);

  // The rune pool is the same for every candidate of this call, so a payment plan depends only on
  // the cost: memoise it (copies of one card, and cards of equal cost, share one plan search). An
  // unaffordable cost (null) skips building any PLAY_CARD candidate.
  const plans = new Map<string, PaymentPlan | null>();
  const plannedPayment = (cost: TotalCost): PaymentPlan | null => {
    const key = `${cost.energy}|${JSON.stringify(cost.power)}`;
    if (plans.has(key)) return plans.get(key) ?? null;
    const plan = autoPlan(state, cards, pid, cost);
    plans.set(key, plan);
    return plan;
  };

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
            // Ambush (822): also battlefields held by the opponent or nobody where I have units.
            ...(hasKw(def, 'Ambush')
              ? state.battlefields
                  .filter((b) => b.controller !== pid && hasUnitAt(state, cards, pid, b.id))
                  .map((b) => ({ kind: 'battlefield' as const, battlefieldId: b.id }))
              : []),
            // R76: "You may play me to an open battlefield / an occupied enemy battlefield".
            ...(def.playTo
              ? state.battlefields
                  .filter(
                    (b) => b.controller !== pid && playToAllowed(state, cards, def, pid, b.id),
                  )
                  .map((b) => ({ kind: 'battlefield' as const, battlefieldId: b.id }))
              : []),
          ]
      : isDeployGear(def)
        ? myBattlefields.map((b) => ({ kind: 'battlefield' as const, battlefieldId: b.id }))
        : [undefined];
    const accelOptions = isUnit && hasKw(def, 'Accelerate') ? [false, true] : [false];
    // Repeat (820): spells with a Repeat cost may also be played with it paid.
    const repeatOptions = def.type === 'SPELL' && def.repeatCost ? [false, true] : [false];
    // R58: the optional additional cost.
    const extraOptions = def.optionalAdditionalCost ? [false, true] : [false];
    const costDef = costDefFor(obj, def);
    const selfDiscount = selfEnergyDiscount(state, cards, pid, def, obj.id);
    const discounts = selfDiscount > 0 ? [{ energy: selfDiscount }] : [];
    // Quick-Draw gear: one variant per unit its controller controls (the unit is a Target).
    // Targeted spells (R2): one variant per unit on the board (either side).
    // R59: a modal spell is offered once per mode (each mode has its own targets).
    const modeOptions: (number | undefined)[] = def.modes
      ? def.modes.map((_, i) => i)
      : [undefined];
    for (const mode of modeOptions) {
      const targetOptions: (Target[] | undefined)[] =
        def.type === 'GEAR' && hasKw(def, 'QuickDraw') && myUnits.length > 0
          ? myUnits.map((u) => [{ kind: 'object' as const, id: u.id }])
          : def.type === 'SPELL'
            ? (enumerateSpellTargets(state, cards, pid, spellEffects(def, mode), '', {
                ...(obj.zone.kind === 'facedown' ? { hiddenAt: obj.zone.battlefieldId } : {}),
              }) ?? [undefined])
            : [undefined];
      for (const accelerate of accelOptions) {
        for (const paysExtra of extraOptions) {
          for (const repeat of repeatOptions) {
            // R47: a card-choice additional cost (required, or Repeat's "Discard 1"): one variant per choice of
            // cards (capped); none payable = the play is not offered.
            const costCard = playCostCard(def, repeat, paysExtra);
            if (paysExtra && (def.optionalAdditionalCost?.xp ?? 0) > (ps.xp ?? 0)) continue;
            if (repeat && def.additionalCost && def.repeatCost?.card) continue;
            const picks: (string[] | undefined)[] = costCard
              ? costCardCombos(state, cards, pid, obj.id, costCard)
              : [undefined];
            if (picks.length === 0) continue;
            // Keep the whole list near MAX_TARGET_COMBOS: with many target choices, fewer card choices each.
            if (picks.length > 1)
              picks.splice(Math.max(1, Math.floor(MAX_TARGET_COMBOS / targetOptions.length)));
            const oac = paysExtra ? def.optionalAdditionalCost : undefined;
            const increases = [
              ...(repeat && def.repeatCost ? [def.repeatCost] : []),
              ...(oac ? [{ energy: oac.energy, power: oac.power, anyPower: oac.anyPower }] : []),
            ];
            const allDiscounts = oac?.reduceEnergy
              ? [...discounts, { energy: oac.reduceEnergy }]
              : discounts;
            const plan = plannedPayment(
              computeTotalCost(costDef, { accelerate, discounts: allDiscounts, increases }),
            );
            if (plan === null) continue;
            for (const location of locations) {
              for (const targets of targetOptions) {
                for (const costCards of picks) {
                  // Killing / returning the spell's own target makes it fizzle: not offered.
                  if (
                    costCards &&
                    (costCard?.kind === 'KILL' || costCard?.kind === 'RETURN') &&
                    targets?.some((t) => t.kind === 'object' && costCards.includes(t.id))
                  ) {
                    continue;
                  }
                  const intent: PlayCardIntent = {
                    type: 'PLAY_CARD',
                    playerId: pid,
                    cardInstanceId: obj.id,
                    ...(location ? { location } : {}),
                    ...(targets ? { targets } : {}),
                    ...(mode !== undefined ? { mode } : {}),
                    ...(accelerate || repeat || paysExtra
                      ? {
                          additionalCosts: {
                            ...(accelerate ? { accelerate: true } : {}),
                            ...(repeat ? { repeat: true } : {}),
                            ...(paysExtra ? { extra: true } : {}),
                          },
                        }
                      : {}),
                    ...(costCards ? { costCards } : {}),
                    payment: plan,
                  };
                  out.push(intent);
                }
              }
            }
          }
        }
      }
    }
  }
  // R61: Flow: spells in the Trash with a Flow cost may be played from there (then banished).
  for (const id of ps.trash) {
    const obj = state.objects[id];
    const def = obj ? cards[obj.cardId] : undefined;
    if (!obj || !def || def.type !== 'SPELL' || !def.flowCost) continue;
    const flowDef = {
      ...def,
      cost: { energy: def.flowCost.energy, power: def.flowCost.power ?? 0 },
    };
    const plan = plannedPayment(
      computeTotalCost(flowDef, {
        increases: def.flowCost.anyPower ? [{ anyPower: def.flowCost.anyPower }] : [],
      }),
    );
    if (plan === null) continue;
    const modes: (number | undefined)[] = def.modes ? def.modes.map((_, i) => i) : [undefined];
    for (const mode of modes) {
      for (const targets of enumerateSpellTargets(state, cards, pid, spellEffects(def, mode)) ?? [
        undefined,
      ]) {
        out.push({
          type: 'PLAY_CARD',
          playerId: pid,
          cardInstanceId: id,
          ...(targets ? { targets } : {}),
          ...(mode !== undefined ? { mode } : {}),
          additionalCosts: { flow: true },
          payment: plan,
        });
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
        isUnitDef(cards[o.cardId]),
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
    (o) => (o.zone.kind === 'base' || o.zone.kind === 'battlefield') && isUnitDef(cards[o.cardId]),
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
  if (flow.pendingChoice) {
    const pc = flow.pendingChoice;
    if (pc.player !== playerId) return [];
    if (pc.kind === 'TRIGGER_TARGET') {
      const item = flow.chain.find((i) => i.id === pc.chainItemId);
      const tdef = item ? triggerDefOf(state, cards, item) : undefined;
      if (item && tdef?.modes) {
        // X-modes: one answer per (mode still allowed x legal targets of that mode).
        const modal: Intent[] = [];
        for (const mode of allowedModes(state, cards, item)) {
          const picks = enumerateSpellTargets(
            state,
            cards,
            item.controller,
            tdef.modes[mode],
            itemSourceId(item),
            {},
          ) ?? [[]];
          for (const targets of picks) {
            modal.push({
              type: 'CHOOSE_TRIGGER_TARGET',
              playerId,
              chainItemId: pc.chainItemId,
              targets,
              mode,
            });
          }
        }
        return keep(modal).slice(0, max);
      }
      const choices = item
        ? (enumerateSpellTargets(
            state,
            cards,
            item.controller,
            abilityItemEffects(state, cards, item),
            itemSourceId(item),
            { allowNone: true },
          ) ?? [])
        : [];
      return keep(
        choices.map((targets): Intent => ({
          type: 'CHOOSE_TRIGGER_TARGET',
          playerId,
          chainItemId: pc.chainItemId,
          targets,
        })),
      ).slice(0, max);
    }
    if (pc.kind === 'OPTIONAL_EFFECT') {
      // R45: decline is always offered and listed FIRST, so every "take legal[0]" fallback (host bot
      // fallback, tutorial autopilot, timeouts) declines instead of paying; accept only when the cost
      // can be paid, with the automatic payment plan spelled out.
      const item = flow.chain.find((i) => i.id === pc.chainItemId);
      const cardId = item ? (triggerSourceCardId(state, item) ?? '') : '';
      const sourceId = item ? itemSourceId(item) : '';
      const plan = optionalPlan(state, cards, pc.player, cardId, pc.cost, sourceId);
      // R46: a card-choice cost is one accept per choice of cards (capped by MAX_TARGET_COMBOS).
      const picks: (string[] | undefined)[] = pc.cost.card
        ? costCardCombos(state, cards, pc.player, sourceId, pc.cost.card)
        : [undefined];
      const accept: Intent[] =
        plan === null
          ? []
          : picks.map((costCards): Intent => ({
              type: 'DECIDE_OPTIONAL',
              playerId,
              chainItemId: pc.chainItemId,
              accept: true,
              ...(costCards ? { costCards } : {}),
              ...(plan.length > 0 ? { payment: plan } : {}),
            }));
      // R77: a mandatory cost lists only the accepts (the decline is kept when nothing can be paid, so the game never stalls).
      const decline: Intent = {
        type: 'DECIDE_OPTIONAL',
        playerId,
        chainItemId: pc.chainItemId,
        accept: false,
      };
      return keep(pc.cost.mandatory && accept.length > 0 ? accept : [decline, ...accept]).slice(
        0,
        max,
      );
    }
    if (pc.kind === 'TRIGGER_ORDER') {
      // X6: every order of the waiting triggers; the default order comes first (the timeout / bot fallback).
      const perms = (ids: string[]): string[][] =>
        ids.length <= 1
          ? [ids]
          : ids.flatMap((id, k) =>
              perms([...ids.slice(0, k), ...ids.slice(k + 1)]).map((rest) => [id, ...rest]),
            );
      return keep(
        perms(pc.chainItemIds).map((order): Intent => ({
          type: 'CHOOSE_TRIGGER_ORDER',
          playerId,
          order,
        })),
      ).slice(0, max);
    }
    if (pc.kind === 'DEATH_REPLACE') {
      // X7: decline is listed FIRST (every "take legal[0]" fallback and the timeout decline); then one accept
      // per offer (and per choice of cards for a card cost), with the automatic payment plan spelled out.
      const decline: Intent = {
        type: 'DECIDE_REPLACEMENT',
        playerId,
        unitId: pc.unitId,
        accept: false,
      };
      const accepts: Intent[] = [];
      for (const offer of pc.offers) {
        const plan = optionalPlan(
          state,
          cards,
          pc.player,
          offer.cardId,
          offer.cost,
          offer.sourceId,
        );
        if (plan === null) continue;
        const picks: (string[] | undefined)[] = offer.cost.card
          ? costCardCombos(state, cards, pc.player, offer.sourceId, offer.cost.card)
          : [undefined];
        for (const costCards of picks) {
          accepts.push({
            type: 'DECIDE_REPLACEMENT',
            playerId,
            unitId: pc.unitId,
            accept: true,
            sourceId: offer.sourceId,
            ...(costCards ? { costCards } : {}),
            ...(plan.length > 0 ? { payment: plan } : {}),
          });
        }
      }
      return keep([decline, ...accepts]).slice(0, max);
    }
    if (pc.kind === 'HAND_CHOICE') {
      // X-hand: one answer per choice of `count` offered cards (the first ones first: the timeout default).
      const ids = pc.options.map((o) => o.id);
      const combos: string[][] = [];
      const rec = (start: number, acc: string[]): void => {
        if (combos.length >= max) return;
        if (acc.length === pc.count) {
          combos.push([...acc]);
          return;
        }
        for (let i = start; i < ids.length; i++) {
          acc.push(ids[i] as string);
          rec(i + 1, acc);
          acc.pop();
        }
      };
      rec(0, []);
      return keep(
        combos.map((cardIds): Intent => ({ type: 'CHOOSE_HAND_CARDS', playerId, cardIds })),
      ).slice(0, max);
    }
    return keep(
      pc.options.map((battlefieldId): Intent => ({
        type: 'CHOOSE_STAGED',
        playerId,
        battlefieldId,
      })),
    ).slice(0, max);
  }
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
  // Activated abilities that use the Chain (R38); [Add] abilities are offered like runes.
  take(abilityCandidates(state, cards, playerId, true));
  return [...others, ...essential];
}

/** [Add] ability activations (Gold, Seals, ...) the player may perform now, for the UI. */
export function getAbilityActivations(
  state: GameState,
  cards: CardDatabase,
  playerId: PlayerId,
): Intent[] {
  if (state.gameStatus !== 'IN_PROGRESS' || state.turn.phase === 'MULLIGAN') return [];
  return abilityCandidates(state, cards, playerId, false).filter((i) => reduce(state, cards, i).ok);
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
