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
import { runEffects } from './effects.js';
import { canPlayNow, finalizeAndSettle, pushPendingItem } from './chain.js';
import type { ChainResolver } from './chain.js';
import { computeTotalCost, payCost } from './resources.js';
import type { CostMod } from './resources.js';
import { allocObjectId, stampEvents } from './setup.js';
import { playerIndex, ruleError } from './types/index.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
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
}

/** Resolver that first puts a Unit/Gear into its final zone (359.2), then defers to `inner`. */
function placingResolver(
  inner: ChainResolver,
  hooks: PlayHooks | undefined,
  turnNumber: number,
): ChainResolver {
  return (state, item, cards) => {
    const s = structuredClone(state);
    const events: GameEventInput[] = [];
    const obj = s.objects[item.sourceObjectId];
    const def = obj ? cards[obj.cardId] : undefined;
    if (item.kind === 'CARD' && obj && def && (def.type === 'UNIT' || def.type === 'GEAR')) {
      const owner = s.players[playerIndex(obj.controller)];
      const loc =
        def.type === 'GEAR'
          ? { kind: 'base' as const }
          : (item.location ?? { kind: 'base' as const });
      if (loc.kind === 'battlefield') {
        obj.zone = {
          kind: 'battlefield',
          player: obj.controller,
          battlefieldId: loc.battlefieldId,
        };
      } else {
        obj.zone = { kind: 'base', player: obj.controller };
        owner.base.push(obj.id);
      }
      // 359.2.c Units enter exhausted (ready if Accelerate was paid); 359.2.d Gear enters ready.
      obj.ready = def.type === 'GEAR' ? true : item.additionalCosts?.accelerate === true;
      obj.enteredTurn = turnNumber;
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
export const playResolver: ChainResolver = (state, item, cards) => {
  const s = structuredClone(state);
  const events: GameEventInput[] = [];
  const obj = s.objects[item.sourceObjectId];
  if (!obj || item.kind !== 'CARD') return { state: s, events };
  if (item.unimplementedEffect) events.push({ type: 'EFFECT_UNIMPLEMENTED', cardId: obj.cardId });
  const def = cards[obj.cardId];
  if (def?.type === 'SPELL')
    events.push(...runEffects(s, item.controller, def.effects ?? [], cards));
  if (def?.type === 'SPELL' && obj.zone.kind === 'chain') {
    const owner = s.players[playerIndex(obj.owner)];
    if (!owner.trash.includes(obj.id)) owner.trash.push(obj.id);
    obj.zone = { kind: 'trash', player: obj.owner };
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
  if (!inHand && !(inChampionZone && def.type === 'UNIT')) {
    return ruleError('NOT_IN_HAND', `card ${src.id}`);
  }

  // 2. Timing (propagated verbatim).
  const timing = canPlayNow(state, cards, pid, def);
  if (!timing.ok) return timing;

  // 4. Choices (355): location and targets.
  const isUnit = def.type === 'UNIT';
  let location: NonNullable<ChainItem['location']> = { kind: 'base' };
  if (intent.location?.kind === 'battlefield') {
    const bfId = intent.location.battlefieldId;
    const bf = state.battlefields.find((b) => b.id === bfId);
    if (!isUnit) return ruleError('ILLEGAL_LOCATION', `${def.type} can only enter the Base`);
    if (!bf) return ruleError('ILLEGAL_LOCATION', `battlefield ${bfId} does not exist`);
    if (bf.controller !== pid) {
      return ruleError('ILLEGAL_LOCATION', `you do not control battlefield ${bfId}`);
    }
    location = { kind: 'battlefield', battlefieldId: bfId };
  }
  const targets = intent.targets ?? [];
  for (const t of targets) {
    const err = validateTarget(state, t);
    if (err) return err;
    if (t.kind === 'object' && t.id === src.id) {
      return ruleError('ILLEGAL_TARGET', 'a card cannot target itself');
    }
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
  const extra = hooks?.extraCosts?.(state, cards, pid, def, intent) ?? null;
  const cost = computeTotalCost(def, { accelerate, increases: extra ? [extra] : [] });

  // 6. Pay (357). Failure = the whole play is undone (358.5): the caller's state is untouched.
  const paid = payCost(state, cards, pid, cost, intent.payment);
  if (!paid.ok) return paid;

  // 3. Move to the Chain (354), now on the paid working state.
  const work = paid.state;
  const events: GameEventInput[] = [];
  const obj = work.objects[src.id] as CardInstance;
  leaveSource(work, obj);
  obj.zone = { kind: 'chain', player: pid };
  const item: ChainItem = {
    id: allocObjectId(work),
    kind: 'CARD',
    sourceObjectId: obj.id,
    controller: pid,
    status: 'PENDING',
    targets: structuredClone(targets),
    choices: structuredClone(intent.choices ?? {}),
    ...(def.type === 'SPELL' && def.supportLevel === 'partial' && !def.effects?.length
      ? { unimplementedEffect: true }
      : {}),
    ...(isUnit || def.type === 'GEAR'
      ? { location: def.type === 'GEAR' ? { kind: 'base' } : location }
      : {}),
    ...(accelerate ? { additionalCosts: { accelerate: true } } : {}),
  };
  events.push({ type: 'CARD_PLAYED', player: pid, cardInstanceId: obj.id, cardId: obj.cardId });
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
