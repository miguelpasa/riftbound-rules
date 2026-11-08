/**
 * PLAY_CARD pipeline (Core Rules 349-359) and the chain resolver for played cards (337, 359).
 *
 * Pure and isomorphic: playCard validates on the input, then structuredClones and mutates the clone.
 * Any failure returns a RuleError and the caller keeps its original state (358.5: the play is undone).
 *
 * Pipeline: source (hand / Chosen Champion, 108.3.d) -> timing (chain.canPlayNow) -> choices
 * (location 355.2, targets 355.10) -> total cost (356) -> payment (357) -> move to the Chain (354)
 * -> finalize (chain.finalizeAndSettle). Units and Gear resolve immediately on finalize (337.2): a
 * wrapper resolver puts them into their final zone (359.2) just before the injected resolver runs.
 * Spells stay on the Chain FINALIZED (359.3.a) until passPriority resolves them with `playResolver`.
 *
 * Decisions:
 *  - Bad battlefield location (missing, uncontrolled, or a non-unit asking for a battlefield) is
 *    ILLEGAL_LOCATION; spells ignore a base location.
 *  - Targets must exist and be in a public zone (355.10.a.1); hand/decks/facedown are ILLEGAL_TARGET.
 *  - Accelerate requested on a card without the keyword is KEYWORD_RESTRICTION.
 *  - Surplus resources stay in the Rune Pool (payCost behaviour).
 *
 * Note for E10 (keywords): a facedown Hidden card must NOT emit a public CARD_PLAYED (it would leak
 * cardId, see docs/ASSUMPTIONS.md); Hidden uses HIDE_CARD, not this pipeline.
 */
import { cloneState, fork } from './workingCopy.js';
import { runEffects, spellEffects, spellTargetsLegal } from './effects.js';
import { canPlayNow, finalizeAndSettle, pushPendingItem } from './chain.js';
import type { ChainResolver } from './chain.js';
import { computeTotalCost, payCost } from './resources.js';
import type { CostMod } from './resources.js';
import { allocObjectId, stampEvents } from './setup.js';
import { selfEnergyDiscount } from './costReduction.js';
import { evalCondition } from './conditions.js';
import { optionalPlan } from './optional.js';
import { costCardsLegal, payCostCards, playCostCard } from './costCards.js';
import { isDeployGear, isUnitDef } from './tokens.js';
import { staticBonus } from './statics.js';
import { playerIndex, ruleError } from './types/index.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  CardTrigger,
  ChainItem,
  GameEventInput,
  GameState,
  PlayCardIntent,
  PlayerId,
  ReduceResult,
  RuleError,
  Target,
} from './types/index.js';

/**
 * Extension points so keyword modules (E10) can plug into the pipeline without editing it.
 * Both are optional.
 */
export interface PlayHooks {
  /** Extra cost increase for this play (e.g. Deflect surcharge). Return null for none. Read-only. */
  extraCosts?(
    state: GameState,
    cards: CardDatabase,
    playerId: PlayerId,
    def: CardDef,
    intent: PlayCardIntent,
  ): CostMod | null;
  /**
   * Called on the WORKING state (may mutate it) when a Unit or Gear has just entered its final
   * zone, during resolution (e.g. Ganking/Temporary setup). Returns extra events.
   */
  onEnter?(
    state: GameState,
    cards: CardDatabase,
    objectId: string,
    item?: ChainItem,
  ): GameEventInput[];
  /**
   * Rule 811: set when a facedown Hidden card is played; Gear then enters this battlefield
   * (instead of the Base) and the battlefield-control check still applies.
   */
  hiddenAt?: string;
}

const PUBLIC_TARGET_ZONES = new Set([
  'base',
  'battlefield',
  'chain',
  'trash',
  'banishment',
  'legend',
  'champion',
]);

const UNPLAYABLE_TYPES = new Set(['LEGEND', 'RUNE', 'BATTLEFIELD', 'TOKEN']);

function hasKeyword(def: CardDef, name: string): boolean {
  return def.keywords.some((k) => k.name === name);
}

/** True if `pid` controls a Unit (other than `exceptId`) at the battlefield. */
/**
 * R76: may a Unit with `playTo` be played to this battlefield even though its player does not control
 * it? "OPEN" = no units there at all; "ENEMY" = an opponent controls it and has units there.
 */
export function playToAllowed(
  state: GameState,
  cards: CardDatabase,
  def: CardDef,
  pid: PlayerId,
  battlefieldId: string,
): boolean {
  if (!def.playTo || def.playTo.length === 0) return false;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return false;
  const there = Object.values(state.objects).filter(
    (o) =>
      o.zone.kind === 'battlefield' &&
      o.zone.battlefieldId === battlefieldId &&
      isUnitDef(cards[o.cardId]),
  );
  if (def.playTo.includes('OPEN') && there.length === 0) return true;
  const opp: PlayerId = pid === 'p0' ? 'p1' : 'p0';
  return (
    def.playTo.includes('ENEMY') && bf.controller === opp && there.some((o) => o.controller === opp)
  );
}

export function hasUnitAt(
  state: GameState,
  cards: CardDatabase,
  pid: PlayerId,
  battlefieldId: string,
  exceptId?: string,
): boolean {
  return Object.values(state.objects).some(
    (o) =>
      o.id !== exceptId &&
      o.controller === pid &&
      o.zone.kind === 'battlefield' &&
      o.zone.battlefieldId === battlefieldId &&
      cards[o.cardId]?.type === 'UNIT',
  );
}

function validateTarget(state: GameState, t: Target): RuleError | null {
  if (t.kind === 'object') {
    const o = state.objects[t.id];
    if (!o) return ruleError('ILLEGAL_TARGET', `object ${t.id} does not exist`);
    if (!PUBLIC_TARGET_ZONES.has(o.zone.kind)) {
      return ruleError('ILLEGAL_TARGET', `object ${t.id} is in a non-public zone (355.10.a.1)`);
    }
    return null;
  }
  if (t.kind === 'battlefield') {
    return state.battlefields.some((b) => b.id === t.battlefieldId)
      ? null
      : ruleError('ILLEGAL_TARGET', `battlefield ${t.battlefieldId} does not exist`);
  }
  return t.playerId === 'p0' || t.playerId === 'p1'
    ? null
    : ruleError('ILLEGAL_TARGET', `player ${String(t.playerId)} does not exist`);
}

/** Remove the object from the zone array that currently holds it (hand or champion zone). */
function leaveSource(state: GameState, obj: CardInstance): void {
  const p = state.players[playerIndex(obj.owner)];
  p.hand = p.hand.filter((id) => id !== obj.id);
  p.championZone = p.championZone.filter((id) => id !== obj.id);
  p.trash = p.trash.filter((id) => id !== obj.id); // R61: Flow plays from the Trash
}

/** Resolver that first puts a Unit/Gear into its final zone (359.2), then defers to `inner`. */
function placingResolver(
  inner: ChainResolver,
  hooks: PlayHooks | undefined,
  turnNumber: number,
): ChainResolver {
  return (state, item, cards) => {
    const s = fork(state);
    const events: GameEventInput[] = [];
    const obj = s.objects[item.sourceObjectId];
    const def = obj ? cards[obj.cardId] : undefined;
    if (item.kind === 'CARD' && obj && def && (def.type === 'UNIT' || def.type === 'GEAR')) {
      const owner = s.players[playerIndex(obj.controller)];
      // Gear enters the Base unless it was played from the facedown zone (811): then it enters
      // that battlefield and Cleanup recalls it (323.6) like any non-unit permanent there.
      const loc = item.location ?? { kind: 'base' as const };
      if (loc.kind === 'battlefield') {
        obj.zone = {
          kind: 'battlefield',
          player: obj.controller,
          battlefieldId: loc.battlefieldId,
        };
        // R76: a Unit played to a battlefield nobody else occupies contests it (like a move there),
        // so the Cleanup stages the Showdown that lets its player take control (190.3, 323.7).
        const bfState = s.battlefields.find((b) => b.id === loc.battlefieldId);
        if (
          def.type === 'UNIT' &&
          bfState &&
          bfState.controller !== obj.controller &&
          !Object.values(s.objects).some(
            (o) =>
              o.controller !== obj.controller &&
              o.zone.kind === 'battlefield' &&
              o.zone.battlefieldId === loc.battlefieldId &&
              cards[o.cardId]?.type === 'UNIT',
          )
        ) {
          bfState.contestedBy = obj.controller;
        }
      } else {
        obj.zone = { kind: 'base', player: obj.controller };
        owner.base.push(obj.id);
      }
      // 359.2.c Units enter exhausted (ready if Accelerate was paid); 359.2.d Gear enters ready.
      obj.ready =
        def.type === 'GEAR'
          ? def.entersExhausted !== true
          : item.additionalCosts?.accelerate === true ||
            def.entersReady === true ||
            // R43: "I enter ready if <condition>" is checked as the unit enters (it is not yet counted).
            (def.entersReadyWhen !== undefined &&
              evalCondition(s, cards, def.entersReadyWhen, obj.controller, obj.id)) ||
            // R88: "Other friendly units enter ready" statics.
            staticBonus(s, cards, obj).entersReady === true ||
            // R105: "Units you play this turn enter ready".
            s.players[playerIndex(obj.controller)]?.enterReadyTurn === turnNumber;
      obj.enteredTurn = turnNumber;
      delete obj.empowered; // R52: a permanent always enters un-Empowered
      delete obj.buffed; // R54: and without a Buff
      if (hooks?.onEnter) events.push(...hooks.onEnter(s, cards, obj.id, item));
    }
    const res = inner(s, item, cards);
    return { state: res.state, events: [...events, ...res.events] };
  };
}

/**
 * Chain resolver for played cards. Spells go to their owner's trash (359.3.d, 157) and emit
 * EFFECT_UNIMPLEMENTED when flagged; Units/Gear are no-ops (already placed by playCard). Idempotent:
 * a card already in the trash is not trashed twice. The chain item has been popped by chain.ts.
 */
/**
 * Run a triggered ability's effects as it resolves. An optional one (R45, "you may [pay] ...") first
 * asks its controller: the item goes back on top of the Chain and flow.pendingChoice waits for
 * DECIDE_OPTIONAL (which sets `optionalDecision` and resolves it again). Unpayable = declined.
 */
function runTrigger(
  s: GameState,
  cards: CardDatabase,
  item: ChainItem,
  trig: CardTrigger,
  cardId: string,
  sourceId: string,
  events: GameEventInput[],
): void {
  let optional = trig.optional;
  // R77: a mandatory discard asks for min(N, hand size) cards; with an empty hand there is nothing to ask.
  if (
    optional?.mandatory &&
    optional.card?.kind === 'DISCARD' &&
    item.optionalDecision === undefined
  ) {
    const hand = s.players[playerIndex(item.controller)].hand.length;
    const n = Math.min(optional.card.count ?? 1, hand);
    if (n === 0) {
      events.push(
        ...runEffects(s, item.controller, trig.effects, cards, item.targets, cardId, sourceId),
      );
      return;
    }
    optional = { ...optional, card: { ...optional.card, count: n } };
  }
  if (optional) {
    const player = item.controller;
    if (item.optionalDecision === undefined) {
      if (optionalPlan(s, cards, player, cardId, optional, sourceId) === null) {
        events.push({ type: 'OPTIONAL_EFFECT_DECIDED', player, sourceId, accepted: false });
        return;
      }
      s.flow.chain.push(cloneState(item));
      s.flow.pendingChoice = {
        kind: 'OPTIONAL_EFFECT',
        player,
        chainItemId: item.id,
        cost: { ...optional },
      };
      return;
    }
    const accepted = item.optionalDecision === 'ACCEPT';
    events.push({ type: 'OPTIONAL_EFFECT_DECIDED', player, sourceId, accepted });
    if (!accepted) return;
  }
  events.push(
    ...runEffects(s, item.controller, trig.effects, cards, item.targets, cardId, sourceId),
  );
}

export const playResolver: ChainResolver = (state, item, cards) => {
  const s = fork(state);
  const events: GameEventInput[] = [];
  const obj = s.objects[item.sourceObjectId];
  if (item.kind === 'ABILITY' && item.activatedIndex !== undefined) {
    // Activated ability (145.1): the source may be gone (killed as a cost), so its card id rides
    // on the item. Targets (R41) were chosen when it was activated; runEffects re-checks them.
    const cardId = item.sourceCardId ?? obj?.cardId ?? '';
    const ability = cards[cardId]?.abilities?.[item.activatedIndex];
    if (ability) {
      events.push(
        ...runEffects(
          s,
          item.controller,
          ability.effects,
          cards,
          item.targets,
          cardId,
          item.sourceObjectId,
        ),
      );
    }
    return { state: s, events };
  }
  if (
    item.kind === 'ABILITY' &&
    item.sourceBattlefieldId !== undefined &&
    item.triggerIndex !== undefined
  ) {
    // R44: a Battlefield card's trigger. Its "here" and conditions are the battlefield itself and
    // "you" is the item's controller (the scorer / attacker / defender it was put on the Chain for).
    const bf = s.battlefields.find((b) => b.id === item.sourceBattlefieldId);
    const trig = bf ? cards[bf.cardId]?.triggers?.[item.triggerIndex] : undefined;
    if (bf && trig && (!trig.when || evalCondition(s, cards, trig.when, item.controller, bf.id))) {
      runTrigger(s, cards, item, trig, bf.cardId, bf.id, events);
    }
    return { state: s, events };
  }
  if (obj && item.kind === 'ABILITY' && item.triggerIndex !== undefined) {
    const trig = cards[obj.cardId]?.triggers?.[item.triggerIndex];
    // R43: the general condition is checked again as the ability resolves.
    if (trig && (!trig.when || evalCondition(s, cards, trig.when, item.controller, obj.id))) {
      runTrigger(s, cards, item, trig, obj.cardId, obj.id, events);
    }
    return { state: s, events };
  }
  if (obj && item.kind === 'ABILITY' && item.abilityIndex === 0) {
    // Equip (151.2.a): attach if the Equipment and the unit are still legal; otherwise nothing.
    const t = item.targets[0];
    const unit = t?.kind === 'object' ? s.objects[t.id] : undefined;
    if (
      obj.zone.kind === 'base' &&
      unit &&
      (unit.zone.kind === 'base' || unit.zone.kind === 'battlefield') &&
      unit.controller === item.controller &&
      obj.controller === item.controller
    ) {
      obj.attachedTo = unit.id;
    }
    return { state: s, events };
  }
  if (!obj || item.kind !== 'CARD') return { state: s, events };
  if (item.unimplementedEffect) events.push({ type: 'EFFECT_UNIMPLEMENTED', cardId: obj.cardId });
  const def = cards[obj.cardId];
  if (def?.type === 'SPELL') {
    // Repeat (820): the effects run one more time when the Repeat cost was paid. The same targets
    // are used again (UNCLEAR, docs/ASSUMPTIONS.md R42); runEffects re-checks them each time.
    const times = item.additionalCosts?.repeat === true ? 2 : 1;
    for (let i = 0; i < times; i++) {
      events.push(
        ...runEffects(
          s,
          item.controller,
          spellEffects(def, item.mode) ?? [],
          cards,
          item.targets,
          obj.cardId,
        ),
      );
    }
  }
  if (def?.type === 'SPELL' && obj.zone.kind === 'chain') {
    const owner = s.players[playerIndex(obj.owner)];
    if (item.additionalCosts?.flow === true) {
      // R61: a spell played with Flow is banished instead of going to the Trash.
      owner.banishment.push(obj.id);
      obj.zone = { kind: 'banishment', player: obj.owner };
    } else {
      if (!owner.trash.includes(obj.id)) owner.trash.push(obj.id);
      obj.zone = { kind: 'trash', player: obj.owner };
    }
  }
  return { state: s, events };
};

/** PLAY_CARD (349-359). See file header. */
export function playCard(
  state: GameState,
  cards: CardDatabase,
  intent: PlayCardIntent,
  resolver: ChainResolver = playResolver,
  hooks?: PlayHooks,
): ReduceResult {
  const pid = intent.playerId;
  const src = state.objects[intent.cardInstanceId];
  if (!src) return ruleError('NOT_FOUND', `card ${intent.cardInstanceId}`);
  const def = cards[src.cardId];
  if (!def) return ruleError('NOT_FOUND', `card definition ${src.cardId}`);
  if (UNPLAYABLE_TYPES.has(def.type))
    return ruleError('WRONG_CARD_TYPE', `${def.type} cannot be played`);

  // 1. Source: hand, or the Chosen Champion in the champion zone (108.3.d).
  const ps = state.players[playerIndex(pid)];
  const inHand = src.zone.kind === 'hand' && src.zone.player === pid && ps.hand.includes(src.id);
  const inChampionZone =
    src.zone.kind === 'champion' && src.zone.player === pid && ps.championZone.includes(src.id);
  // R61: Flow: a spell with a Flow cost may be played from its owner's Trash.
  const flow = intent.additionalCosts?.flow === true;
  const inTrash =
    flow &&
    def.type === 'SPELL' &&
    def.flowCost !== undefined &&
    src.zone.kind === 'trash' &&
    src.zone.player === pid &&
    ps.trash.includes(src.id);
  if (flow && !inTrash)
    return ruleError('NOT_IN_HAND', `card ${src.id} cannot be played with Flow`);
  if (!inHand && !inTrash && !(inChampionZone && def.type === 'UNIT')) {
    return ruleError('NOT_IN_HAND', `card ${src.id}`);
  }

  // Ambush (822): a Unit with Ambush may be played to a battlefield where its controller has units
  // (even one the opponent controls) and then has Reaction speed. The Rengar / Stalking Wolf
  // extensions ("enemy units there", "even without other units") are not parsed and stay partial.
  const isUnit = def.type === 'UNIT';
  const wantedBf = intent.location?.kind === 'battlefield' ? intent.location.battlefieldId : null;
  const ambush =
    isUnit &&
    hasKeyword(def, 'Ambush') &&
    wantedBf !== null &&
    hasUnitAt(state, cards, pid, wantedBf, src.id);

  // 2. Timing (propagated verbatim).
  const timing = canPlayNow(state, cards, pid, def, ambush ? { ambush: true } : {});
  if (!timing.ok) return timing;

  // 4. Choices (355): location and targets.
  let location: NonNullable<ChainItem['location']> = { kind: 'base' };
  if (intent.location?.kind === 'battlefield') {
    const bfId = intent.location.battlefieldId;
    const bf = state.battlefields.find((b) => b.id === bfId);
    const hiddenGear = def.type === 'GEAR' && hooks?.hiddenAt === bfId; // 811
    const deployGear = isDeployGear(def);
    if (!isUnit && !hiddenGear && !deployGear) {
      return ruleError('ILLEGAL_LOCATION', `${def.type} can only enter the Base`);
    }
    if (!bf) return ruleError('ILLEGAL_LOCATION', `battlefield ${bfId} does not exist`);
    if (bf.controller !== pid && !ambush && !playToAllowed(state, cards, def, pid, bfId)) {
      return ruleError('ILLEGAL_LOCATION', `you do not control battlefield ${bfId}`);
    }
    location = { kind: 'battlefield', battlefieldId: bfId };
  } else if (isDeployGear(def)) {
    // R85: "Play this only to a battlefield."
    return ruleError('ILLEGAL_LOCATION', 'a Deploy gear is played to a battlefield you control');
  }
  const targets = intent.targets ?? [];
  for (const t of targets) {
    const err = validateTarget(state, t);
    if (err) return err;
    if (t.kind === 'object' && t.id === src.id) {
      return ruleError('ILLEGAL_TARGET', 'a card cannot target itself');
    }
  }

  // Spells with targeted effects need a legal unit target (R2).
  // R59: a modal spell needs a valid mode; other cards take none.
  if (def.modes) {
    if (intent.mode === undefined || !def.modes[intent.mode]) {
      return ruleError('MISSING_TARGET', 'choose a mode');
    }
  } else if (intent.mode !== undefined) {
    return ruleError('KEYWORD_RESTRICTION', 'this card has no modes');
  }
  if (
    def.type === 'SPELL' &&
    !spellTargetsLegal(
      state,
      cards,
      pid,
      spellEffects(def, intent.mode),
      targets,
      '',
      hooks?.hiddenAt,
    )
  ) {
    return ruleError('ILLEGAL_TARGET', 'this spell needs legal targets (355.10)');
  }

  // Quick-Draw gear attaches to a unit its controller controls as it enters play, so that unit is
  // chosen now (as a target). With no unit to attach to the gear is played unattached.
  if (def.type === 'GEAR' && hasKeyword(def, 'QuickDraw')) {
    const mine = Object.values(state.objects).filter(
      (o) =>
        o.controller === pid &&
        (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
        cards[o.cardId]?.type === 'UNIT',
    );
    if (mine.length > 0) {
      const pick = targets.find((t) => t.kind === 'object');
      if (!pick || pick.kind !== 'object' || !mine.some((u) => u.id === pick.id)) {
        return ruleError(
          'ILLEGAL_TARGET',
          'Quick-Draw gear must target a unit you control on the board',
        );
      }
    }
  }

  // 5. Cost (356).
  const accelerate = intent.additionalCosts?.accelerate === true;
  if (accelerate && !(isUnit && hasKeyword(def, 'Accelerate'))) {
    return ruleError('KEYWORD_RESTRICTION', 'Accelerate was requested but the card has none');
  }
  // Repeat (820): an optional additional cost on a spell that has one.
  const repeat = intent.additionalCosts?.repeat === true;
  if (repeat && !(def.type === 'SPELL' && def.repeatCost)) {
    return ruleError('KEYWORD_RESTRICTION', 'Repeat was requested but the card has none');
  }
  // R47: a card-choice additional cost ("As an additional cost to play this, kill a friendly unit";
  // Repeat's "Discard 1"): the cards are checked before anything is paid, so a bad choice changes nothing.
  if (repeat && def.additionalCost && def.repeatCost?.card) {
    return ruleError('KEYWORD_RESTRICTION', 'two card costs cannot be combined');
  }
  const wantsExtra = intent.additionalCosts?.extra === true;
  const costCard = playCostCard(def, repeat, wantsExtra);
  if (costCard) {
    if (intent.costCards === undefined) {
      return ruleError('MISSING_TARGET', 'choose the cards that pay the additional cost');
    }
    if (!costCardsLegal(state, cards, pid, src.id, costCard, intent.costCards)) {
      return ruleError('ILLEGAL_TARGET', 'those cards cannot pay the additional cost');
    }
  } else if (intent.costCards !== undefined && intent.costCards.length > 0) {
    return ruleError('ILLEGAL_TARGET', 'this play has no card cost');
  }
  const extra = hooks?.extraCosts?.(state, cards, pid, def, intent) ?? null;
  // Legion (812): "I cost [N] less" while another card was played this turn (checked before this
  // play is recorded; the source itself never counts).
  // R50: plus the card's own "I cost [N] less ..." (selfEnergyDiscount covers both).
  const selfDiscount = selfEnergyDiscount(state, cards, pid, def, src.id);
  const discounts: CostMod[] = selfDiscount > 0 ? [{ energy: selfDiscount }] : [];
  // R58: the optional additional cost ("You may pay [N] as an additional cost to play me").
  const paidExtra = intent.additionalCosts?.extra === true;
  if (paidExtra && !def.optionalAdditionalCost) {
    return ruleError('KEYWORD_RESTRICTION', 'this card has no optional additional cost');
  }
  const oac = paidExtra ? def.optionalAdditionalCost : undefined;
  // R63: "spend N XP" part of the optional cost, and "If you do, I cost [N] less".
  if (oac?.xp && (state.players[playerIndex(pid)]?.xp ?? 0) < oac.xp) {
    return ruleError('INSUFFICIENT_RESOURCES', `not enough XP (need ${oac.xp})`);
  }
  if (oac?.reduceEnergy) discounts.push({ energy: oac.reduceEnergy });
  const increases: CostMod[] = [
    ...(extra ? [extra] : []),
    ...(oac ? [{ energy: oac.energy, power: oac.power, anyPower: oac.anyPower }] : []),
    ...(repeat && def.repeatCost
      ? [{ energy: def.repeatCost.energy, power: def.repeatCost.power }]
      : []),
  ];
  const cost =
    flow && def.flowCost
      ? computeTotalCost(
          { ...def, cost: { energy: def.flowCost.energy, power: def.flowCost.power ?? 0 } },
          { increases: def.flowCost.anyPower ? [{ anyPower: def.flowCost.anyPower }] : [] },
        )
      : computeTotalCost(def, { accelerate, increases, discounts });

  // 6. Pay (357). Failure = the whole play is undone (358.5): the caller's state is untouched.
  const paid = payCost(state, cards, pid, cost, intent.payment);
  if (!paid.ok) return paid;

  // 3. Move to the Chain (354), now on the paid working state.
  const work = paid.state;
  const events: GameEventInput[] = [];
  const obj = work.objects[src.id] as CardInstance;
  // The additional cost is paid with the rest of the cost (357), before the card moves to the Chain.
  if (costCard && intent.costCards) {
    events.push(...payCostCards(work, cards, pid, src.id, costCard, intent.costCards));
  }
  if (oac?.xp) {
    const seatXp = work.players[playerIndex(pid)] as GameState['players'][number];
    seatXp.xp = (seatXp.xp ?? 0) - oac.xp;
    events.push({ type: 'XP_SPENT', player: pid, amount: oac.xp });
  }
  leaveSource(work, obj);
  obj.zone = { kind: 'chain', player: pid };
  // Legion (812): the play counts for "another card this turn" from the moment it is on the Chain.
  const seat = work.players[playerIndex(pid)];
  const sameTurn = seat.playedThisTurn?.turn === work.turn.number;
  seat.playedThisTurn = {
    turn: work.turn.number,
    objectIds: [...(sameTurn ? (seat.playedThisTurn?.objectIds ?? []) : []), obj.id],
  };
  // R105: the one-shot discount is used up by the matching play.
  const nd = seat.nextPlayDiscount;
  if (nd && nd.turn === work.turn.number && (!nd.spellsOnly || def.type === 'SPELL')) {
    delete seat.nextPlayDiscount;
  }
  const item: ChainItem = {
    id: allocObjectId(work),
    kind: 'CARD',
    sourceObjectId: obj.id,
    controller: pid,
    status: 'PENDING',
    targets: cloneState(targets),
    choices: cloneState(intent.choices ?? {}),
    ...(intent.mode !== undefined ? { mode: intent.mode } : {}),
    ...(def.type === 'SPELL' && def.supportLevel === 'partial' && !def.effects?.length
      ? { unimplementedEffect: true }
      : {}),
    ...(isUnit || def.type === 'GEAR' ? { location } : {}),
    ...(def.type === 'SPELL' && hooks?.hiddenAt ? { hiddenAt: hooks.hiddenAt } : {}),
    ...(accelerate || repeat || paidExtra || flow
      ? {
          additionalCosts: {
            ...(flow ? { flow: true } : {}),
            ...(accelerate ? { accelerate: true } : {}),
            ...(repeat ? { repeat: true } : {}),
            ...(paidExtra ? { extra: true } : {}),
          },
        }
      : {}),
  };
  events.push({
    type: 'CARD_PLAYED',
    player: pid,
    cardInstanceId: obj.id,
    cardId: obj.cardId,
    ...(paidExtra ? { paidExtra: true } : {}),
    ...(obj.faceDownPlay ? { fromFacedown: true } : {}),
  });
  delete obj.faceDownPlay;
  const playedEvents = stampEvents(work, events);
  const pushed = pushPendingItem(work, item);

  // 7. Legality check (358) is covered above; finalize and settle.
  const settled = finalizeAndSettle(
    pushed,
    cards,
    item.id,
    placingResolver(resolver, hooks, work.turn.number),
  );
  if (!settled.ok) return settled;
  return { ok: true, state: settled.state, events: [...playedEvents, ...settled.events] };
}
