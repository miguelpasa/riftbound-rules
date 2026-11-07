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
 * "You may pay ..." (R45): a trigger with `optional` asks again when it RESOLVES (play.ts `runTrigger`,
 * optional.ts `decideOptional`); this module only keeps that pending choice from being overwritten.
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
  CardTrigger,
  ChooseTriggerTargetIntent,
  PlayFilter,
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

/** R49: does the played card (`cardId`, played by `player`) satisfy a YOU_PLAY filter? */
function playMatches(
  state: GameState,
  cards: CardDatabase,
  f: PlayFilter | undefined,
  cardId: string,
  player: PlayerId,
): boolean {
  if (!f) return true;
  const def = cards[cardId];
  if (!def) return false;
  if (f.type && def.type !== f.type) return false;
  if (f.minEnergy !== undefined && def.cost.energy < f.minEnergy) return false;
  if (f.onOpponentTurn && state.turn.activePlayer === player) return false;
  if (f.inShowdown && !state.flow.showdown) return false;
  return true;
}

function collect(state: GameState, cards: CardDatabase, events: readonly GameEvent[]): Pending[] {
  const out: Pending[] = [];
  let paidExtra = false;
  let diedAlone: boolean | undefined;
  const batchSeen = new Set<string>();
  /** R71: "once each turn" triggers already collected in this pass (object id + index). */
  const onceSeen = new Set<string>();
  const add = (
    obj: CardInstance | undefined,
    kind: TriggerKind,
    controller: PlayerId,
    pick?: (t: CardTrigger) => boolean,
  ): void => {
    const triggers = obj ? cards[obj.cardId]?.triggers : undefined;
    triggers?.forEach((t, index) => {
      if (!obj || t.on !== kind) return;
      if (pick && !pick(t)) return;
      if (t.oncePerTurn) {
        if (obj.onceTurn?.[index] === state.turn.number) return;
        if (onceSeen.has(obj.id + ':' + index)) return;
        onceSeen.add(obj.id + ':' + index);
      }
      // 812: a Legion-dependent ability triggers only while another card was played this turn.
      if (t.condition === 'LEGION' && !legionActive(state, controller, obj.id)) return;
      // R43: a general condition must hold as the ability triggers.
      // R58: "if you paid the additional cost" is read from the CARD_PLAYED event that caused the trigger.
      if (t.when?.kind === 'PAID_ADDITIONAL') {
        if (!paidExtra) return;
      } else if (t.when?.kind === 'DIED_ALONE') {
        if ((diedAlone === true) === (t.when.not === true)) return;
      } else if (t.when && !evalCondition(state, cards, t.when, controller, obj.id)) return;
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
      // R49: "When you play a <card>" fires for the player's other permanents (and their Legend).
      for (const src of Object.values(state.objects)) {
        if (src.id === e.cardInstanceId || src.controller !== e.player) continue;
        if (!onBoard(src) && src.zone.kind !== 'legend') continue;
        cards[src.cardId]?.triggers?.forEach((t, index) => {
          if (t.on !== 'YOU_PLAY' || !playMatches(state, cards, t.playFilter, e.cardId, e.player))
            return;
          if (t.when && !evalCondition(state, cards, t.when, e.player, src.id)) return;
          out.push({
            sourceId: src.id,
            cardId: src.cardId,
            battlefield: false,
            index,
            controller: e.player,
          });
        });
      }
      const o = state.objects[e.cardInstanceId];
      if (o && onBoard(o) && ['UNIT', 'GEAR'].includes(cards[o.cardId]?.type ?? '')) {
        paidExtra = e.paidExtra === true;
        add(o, 'PLAY', o.controller);
        paidExtra = false;
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
      if (o && o.zone.kind === 'trash') {
        diedAlone = e.alone === true;
        add(o, 'DEATH', o.owner);
        diedAlone = undefined;
      }
      // R71: "When a friendly / an enemy unit dies" fires for the permanents on the board.
      const dead = cards[e.cardId ?? o?.cardId ?? ''];
      const deadIsUnit =
        dead?.type === 'UNIT' || (dead?.type === 'TOKEN' && dead.stats.might !== undefined);
      if (deadIsUnit && e.controller) {
        const deadController = e.controller;
        for (const src of Object.values(state.objects)) {
          if (src.id === e.unitId || !onBoard(src)) continue;
          const here = src.zone.kind === 'battlefield' ? src.zone.battlefieldId : 'base';
          const seenBatch = batchSeen;
          add(src, 'UNIT_DIES', src.controller, (t) => {
            const f = t.dies;
            if (!f) return false;
            if ((f.side === 'friendly') !== (src.controller === deadController)) return false;
            if (f.here && (here === 'base' || here !== e.at)) return false;
            if (f.batch) {
              const key = src.id + ':' + t.effects.length;
              if (seenBatch.has(key)) return false;
              seenBatch.add(key);
            }
            return true;
          });
        }
      }
    } else if (e.type === 'COMBAT_ENDED') {
      // R71: the winner's units win the combat; every unit still standing was "in" it.
      for (const id of e.participants) {
        const o = state.objects[id];
        if (!o || !onBoard(o) || cards[o.cardId]?.type !== 'UNIT') continue;
        add(o, 'COMBAT_END', o.controller);
        if (e.winner !== null && o.controller === e.winner) add(o, 'WIN_COMBAT', o.controller);
      }
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
    if (cards[p.cardId]?.triggers?.[p.index]?.oncePerTurn && !p.battlefield) {
      const src = s.objects[p.sourceId];
      if (src) src.onceTurn = { ...(src.onceTurn ?? {}), [p.index]: s.turn.number };
    }
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
  if (s.flow.pendingChoice?.kind === 'OPTIONAL_EFFECT') return; // R45: the resolving optional ability asks first
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
