/**
 * Triggered abilities (R5, Core Rules 303 and 383-394 in spirit).
 *
 * After each reduced intent (and its Cleanup) `fireTriggers` scans the new events for triggering
 * moments and puts one FINALIZED, `triggered` ABILITY item on the Chain per matching ability:
 *  - PLAY: "When you play me" fires for a Unit/Gear that entered the board (CARD_PLAYED).
 *  - HOLD / CONQUER: fires for the scoring player's units at the scored battlefield (BATTLEFIELD_SCORED).
 *  - DEATH (Deathknell): fires for a unit that died (UNIT_KILLED) and sits in its owner's Trash.
 *  - MOVE (R43): fires for a unit that moved to a battlefield (UNIT_MOVED).
 *  - R44, Battlefield cards: "When you hold / conquer here" fires for the scoring player's battlefield (BATTLEFIELD_SCORED),
 *    "When you attack / defend here" for the combat's attacker / defender (SHOWDOWN_STARTED isCombat). The Chain item
 *    carries `sourceBattlefieldId` (no object); the battlefield's trigger is put on the Chain before the units' triggers.
 *  - ATTACK / DEFEND (R42): fire for each unit of the attacker / defender at the battlefield when a
 *    combat Showdown starts (SHOWDOWN_STARTED with isCombat; a unit is an Attacker iff its controller
 *    is the attacker, 466.2.c).
 * The turn player's triggers are added first, the other player's after, so the other player's
 * resolve first (last in, first out). The player who does not control the top item gets Priority.
 *
 * Targets (R41): a trigger whose effects choose targets has them chosen as it is put on the Chain
 * (the controller picks, as for a spell). With no legal target the ability is not put on the Chain
 * (TRIGGER_NO_TARGET); with exactly one legal choice it is taken automatically (TRIGGER_TARGETED);
 * otherwise the item waits as PENDING and flow.pendingChoice {kind:'TRIGGER_TARGET'} asks its
 * controller (CHOOSE_TRIGGER_TARGET, `chooseTriggerTarget`) before anyone else may act. Resolution
 * re-checks the targets and fizzles when they are illegal (runEffects).
 * "You may" (R42): an effect whose targets are optional ("up to one") also accepts an empty choice,
 * which is how its controller declines; with no legal target at all the ability is skipped.
 */
import { fork } from './workingCopy.js';
import { deriveTurnState } from './chain.js';
import { allocObjectId, stampEvents } from './setup.js';
import { abilityTargetsLegal, enumerateSpellTargets } from './effects.js';
import { legionActive } from './keywords.js';
import { itemSourceId } from './sources.js';
import { evalCondition } from './conditions.js';
import { ruleError } from './types/index.js';
import type {
  CardDatabase,
  CardInstance,
  ChainItem,
  GameEvent,
  GameEventInput,
  GameState,
  CardEffect,
  ChooseTriggerTargetIntent,
  PlayerId,
  ReduceResult,
  Target,
  TriggerKind,
} from './types/index.js';

interface Pending {
  /** Object id, or (R44) the battlefield id of a Battlefield card's ability. */
  sourceId: string;
  cardId: string;
  battlefield: boolean;
  index: number;
  controller: PlayerId;
}

const onBoard = (o: CardInstance): boolean =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield';

function collect(state: GameState, cards: CardDatabase, events: readonly GameEvent[]): Pending[] {
  const out: Pending[] = [];
  const add = (obj: CardInstance | undefined, kind: TriggerKind, controller: PlayerId): void => {
    const triggers = obj ? cards[obj.cardId]?.triggers : undefined;
    triggers?.forEach((t, index) => {
      if (!obj || t.on !== kind) return;
      // 812: a Legion-dependent ability triggers only while another card was played this turn.
      if (t.condition === 'LEGION' && !legionActive(state, controller, obj.id)) return;
      // R43: a general condition must hold as the ability triggers.
      if (t.when && !evalCondition(state, cards, t.when, controller, obj.id)) return;
      out.push({ sourceId: obj.id, cardId: obj.cardId, battlefield: false, index, controller });
    });
  };
  /**
   * R44: a Battlefield card's triggers ("When you hold / conquer / defend / attack here, ..."). The
   * controller is the player the moment is about (the scorer, the defender, the attacker); a
   * condition's "here" is the battlefield itself.
   */
  const addBattlefield = (battlefieldId: string, kind: TriggerKind, controller: PlayerId): void => {
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    cards[bf?.cardId ?? '']?.triggers?.forEach((t, index) => {
      if (!bf || t.on !== kind) return;
      if (t.when && !evalCondition(state, cards, t.when, controller, bf.id)) return;
      out.push({ sourceId: bf.id, cardId: bf.cardId, battlefield: true, index, controller });
    });
  };
  for (const e of events) {
    if (e.type === 'CARD_PLAYED') {
      const o = state.objects[e.cardInstanceId];
      if (o && onBoard(o) && ['UNIT', 'GEAR'].includes(cards[o.cardId]?.type ?? '')) {
        add(o, 'PLAY', o.controller);
      }
    } else if (e.type === 'BATTLEFIELD_SCORED') {
      addBattlefield(e.battlefieldId, e.method, e.player);
      for (const o of Object.values(state.objects)) {
        if (
          o.controller === e.player &&
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === e.battlefieldId &&
          cards[o.cardId]?.type === 'UNIT'
        ) {
          add(o, e.method, e.player);
        }
      }
    } else if (e.type === 'UNIT_MOVED') {
      // MOVE (R43): "When I move" fires for a unit that arrived at a battlefield. Moves to the Base
      // are not reported as moves here because recall and combat retreats share the event (UNCLEAR).
      const o = state.objects[e.unitId];
      if (
        o &&
        e.to !== 'base' &&
        o.zone.kind === 'battlefield' &&
        o.zone.battlefieldId === e.to &&
        cards[o.cardId]?.type === 'UNIT'
      ) {
        add(o, 'MOVE', o.controller);
      }
    } else if (e.type === 'UNIT_KILLED') {
      const o = state.objects[e.unitId];
      if (o && o.zone.kind === 'trash') add(o, 'DEATH', o.owner);
    } else if (e.type === 'SHOWDOWN_STARTED' && e.isCombat) {
      const c = state.flow.combat;
      if (!c || c.battlefieldId !== e.battlefieldId) continue;
      addBattlefield(e.battlefieldId, 'ATTACK', c.attacker);
      addBattlefield(e.battlefieldId, 'DEFEND', c.defender);
      for (const o of Object.values(state.objects)) {
        if (
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === e.battlefieldId &&
          cards[o.cardId]?.type === 'UNIT'
        ) {
          if (o.controller === c.attacker) add(o, 'ATTACK', o.controller);
          else if (o.controller === c.defender) add(o, 'DEFEND', o.controller);
        }
      }
    }
  }
  return out;
}

export function fireTriggers(
  state: GameState,
  cards: CardDatabase,
  events: readonly GameEvent[],
): { state: GameState; events: GameEvent[] } {
  if (state.gameStatus !== 'IN_PROGRESS') return { state, events: [] };
  const pending = collect(state, cards, events);
  if (pending.length === 0) return { state, events: [] };
  const s = fork(state);
  const active = s.turn.activePlayer;
  const ordered = [
    ...pending.filter((p) => p.controller === active),
    ...pending.filter((p) => p.controller !== active),
  ];
  const raw: GameEventInput[] = [];
  let added = 0;
  for (const p of ordered) {
    const effects = cards[p.cardId]?.triggers?.[p.index]?.effects;
    const choices = enumerateSpellTargets(s, cards, p.controller, effects, p.sourceId, {
      allowNone: true,
    });
    if (choices !== null && choices.length === 0) {
      raw.push({ type: 'TRIGGER_NO_TARGET', player: p.controller, sourceId: p.sourceId });
      continue;
    }
    const auto = choices !== null && choices.length === 1 ? (choices[0] as Target[]) : undefined;
    const item: ChainItem = {
      id: allocObjectId(s),
      kind: 'ABILITY',
      sourceObjectId: p.battlefield ? '' : p.sourceId,
      ...(p.battlefield ? { sourceBattlefieldId: p.sourceId } : {}),
      controller: p.controller,
      status: choices !== null && auto === undefined ? 'PENDING' : 'FINALIZED',
      targets: auto ?? [],
      choices: {},
      triggered: true,
      triggerIndex: p.index,
    };
    s.flow.chain.push(item);
    added++;
    raw.push({ type: 'CHAIN_ITEM_ADDED', chainItemId: item.id, controller: p.controller });
    if (auto) {
      raw.push({
        type: 'TRIGGER_TARGETED',
        player: p.controller,
        sourceId: p.sourceId,
        targets: auto,
      });
    }
  }
  if (added === 0) return { state: s, events: stampEvents(s, raw) };
  // Same convention as played cards: the controller of the top item has implicitly passed, so
  // the other player receives Priority (they may respond with a Reaction or pass to resolve it).
  const top = s.flow.chain[s.flow.chain.length - 1];
  s.flow.priority = top ? (top.controller === 'p0' ? 'p1' : 'p0') : active;
  if (s.flow.showdown) s.flow.showdown.passesInRow = 0;
  s.turnState = deriveTurnState(s);
  askNextTrigger(s);
  return { state: s, events: stampEvents(s, raw) };
}

/** The card whose `triggers` a triggered ABILITY item runs: the object's, or (R44) the Battlefield card's. */
export function triggerSourceCardId(state: GameState, item: ChainItem): string | undefined {
  if (item.sourceBattlefieldId !== undefined) {
    return state.battlefields.find((b) => b.id === item.sourceBattlefieldId)?.cardId;
  }
  return state.objects[item.sourceObjectId]?.cardId;
}

/** The effects of the triggered or activated ability behind a Chain item (undefined for others). */
export function abilityItemEffects(
  state: GameState,
  cards: CardDatabase,
  item: ChainItem,
): readonly CardEffect[] | undefined {
  if (item.kind !== 'ABILITY') return undefined;
  const obj = state.objects[item.sourceObjectId];
  if (item.triggerIndex !== undefined) {
    const cardId = triggerSourceCardId(state, item);
    return cardId === undefined ? undefined : cards[cardId]?.triggers?.[item.triggerIndex]?.effects;
  }
  if (item.activatedIndex !== undefined) {
    const cardId = item.sourceCardId ?? obj?.cardId ?? '';
    return cards[cardId]?.abilities?.[item.activatedIndex]?.effects;
  }
  return undefined;
}

/** Set flow.pendingChoice for the oldest PENDING triggered item on the Chain (mutates `s`). */
function askNextTrigger(s: GameState): void {
  const next = s.flow.chain.find(
    (i) => i.kind === 'ABILITY' && i.triggered && i.status === 'PENDING',
  );
  if (next)
    s.flow.pendingChoice = {
      kind: 'TRIGGER_TARGET',
      player: next.controller,
      chainItemId: next.id,
    };
  else if (s.flow.pendingChoice?.kind === 'TRIGGER_TARGET') delete s.flow.pendingChoice;
}

/**
 * CHOOSE_TRIGGER_TARGET (R41): the controller of the PENDING triggered ability picks its targets.
 * They must be a legal choice for the ability's effects (same check as a spell's, 355.10); the item
 * becomes FINALIZED and the next waiting trigger (if any) is asked.
 */
export function chooseTriggerTarget(
  state: GameState,
  cards: CardDatabase,
  intent: ChooseTriggerTargetIntent,
): ReduceResult {
  const pc = state.flow.pendingChoice;
  if (!pc || pc.kind !== 'TRIGGER_TARGET') {
    return ruleError('WRONG_PHASE', 'no triggered ability is waiting for targets');
  }
  if (intent.playerId !== pc.player) return ruleError('NOT_YOUR_PRIORITY', 'not your choice');
  if (intent.chainItemId !== pc.chainItemId) {
    return ruleError('NOT_FOUND', `chain item ${intent.chainItemId} is not the one waiting`);
  }
  const item = state.flow.chain.find((i) => i.id === pc.chainItemId);
  if (!item || item.status !== 'PENDING') return ruleError('NOT_FOUND', 'the trigger is gone');
  const effects = abilityItemEffects(state, cards, item);
  if (
    !Array.isArray(intent.targets) ||
    !abilityTargetsLegal(state, cards, item.controller, effects, intent.targets, itemSourceId(item))
  ) {
    return ruleError('ILLEGAL_TARGET', 'those are not legal targets for this ability (355.10)');
  }
  const targets: Target[] = intent.targets.map((t) => ({ ...t }));
  const s = fork(state);
  const live = s.flow.chain.find((i) => i.id === pc.chainItemId) as ChainItem;
  live.targets = targets;
  live.status = 'FINALIZED';
  delete s.flow.pendingChoice;
  askNextTrigger(s);
  const events = stampEvents(s, [
    { type: 'TRIGGER_TARGETED', player: live.controller, sourceId: itemSourceId(live), targets },
  ]);
  return { ok: true, state: s, events };
}
