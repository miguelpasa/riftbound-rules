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
import { abilityTargetsLegal, enumerateSpellTargets, spellEffects } from './effects.js';
import { legionActive } from './keywords.js';
import { itemSourceId } from './sources.js';
import { isDeployGear } from './tokens.js';
import { evalCondition } from './conditions.js';
import { effectiveMight } from './combat.js';
import { isUnitDef } from './tokens.js';
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
  ChooseTriggerOrderIntent,
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
  /** The unit the event is about ("When a friendly unit attacks alone, give IT ..."): preset as the ability's target. */
  subject?: string;
  /** The scored battlefield, kept only for a condition that reads it ("at that battlefield"). */
  at?: string;
  /** The source token has left the game (Bomb): its card id is read from the Chain item's `sourceCardId`. */
  ghost?: boolean;
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
  fromFacedown = false,
  fromElsewhere = false,
  /** The played card itself (it may already be on the Board) is not one of the "other" units. */
  playedId = '',
): boolean {
  if (!f) return true;
  const def = cards[cardId];
  if (!def) return false;
  if (f.type && def.type !== f.type) return false;
  if (f.minEnergy !== undefined && def.cost.energy < f.minEnergy) return false;
  if (f.minPower !== undefined && (def.cost.power ?? 0) < f.minPower) return false;
  if (f.nth !== undefined) {
    const rec = state.players[player === 'p0' ? 0 : 1]?.playedThisTurn;
    if (!rec || rec.turn !== state.turn.number || rec.objectIds.length !== f.nth) return false;
  }
  if (f.fromFacedown && !fromFacedown) return false;
  if (f.fromElsewhere && !fromElsewhere) return false;
  if (f.mightiest) {
    const might = def.stats.might ?? 0;
    for (const o of Object.values(state.objects)) {
      if (o.id === playedId || !onBoard(o) || !isUnitDef(cards[o.cardId])) continue;
      if (effectiveMight(state, cards, o.id, { role: null }) >= might) return false;
    }
  }
  if (f.token) return false; // token plays are matched separately (TOKEN_PLAYED)
  if (f.onOpponentTurn && state.turn.activePlayer === player) return false;
  if (f.inShowdown && !state.flow.showdown) return false;
  if (f.mighty && (def.type !== 'UNIT' || (def.stats.might ?? 0) < 5)) return false;
  if (f.subtype) {
    const want = f.subtype.toLowerCase();
    if (!def.subtypes.some((x) => x.toLowerCase() === want)) return false;
  }
  return true;
}

function collect(state: GameState, cards: CardDatabase, events: readonly GameEvent[]): Pending[] {
  const out: Pending[] = [];
  let paidExtra = false;
  let facedownPlay = false;
  let diedAlone: boolean | undefined;
  let diedMighty = false;
  /** The battlefield of the BATTLEFIELD_SCORED event being collected ("at that battlefield"). */
  let scoredAt: string | undefined;
  const batchSeen = new Set<string>();
  /** R71: "once each turn" triggers already collected in this pass (object id + index). */
  const onceSeen = new Set<string>();
  const add = (
    obj: CardInstance | undefined,
    kind: TriggerKind,
    controller: PlayerId,
    pick?: (t: CardTrigger) => boolean,
    subject?: string,
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
      if (t.when?.kind === 'FROM_FACEDOWN') {
        if (!facedownPlay) return;
      } else if (t.when?.kind === 'PAID_ADDITIONAL') {
        if (!paidExtra) return;
      } else if (t.when?.kind === 'DIED_MIGHTY') {
        if (!diedMighty) return;
      } else if (t.when?.kind === 'DIED_ALONE') {
        if ((diedAlone === true) === (t.when.not === true)) return;
      } else if (t.when && !evalCondition(state, cards, t.when, controller, obj.id, scoredAt))
        return;
      out.push({
        sourceId: obj.id,
        cardId: obj.cardId,
        battlefield: false,
        index,
        controller,
        ...(subject !== undefined ? { subject } : {}),
        ...(scoredAt !== undefined && t.when?.kind === 'COUNT' && t.when.where === 'scored'
          ? { at: scoredAt }
          : {}),
      });
    });
  };
  /**
   * R44: a Battlefield card's triggers ("When you hold / conquer / defend / attack here, ..."). The
   * controller is the player the moment is about (the scorer, the defender, the attacker); a
   * condition's "here" is the battlefield itself.
   */
  const addBattlefield = (
    battlefieldId: string,
    kind: TriggerKind,
    controller: PlayerId,
    subject?: string,
  ): void => {
    const bf = state.battlefields.find((b) => b.id === battlefieldId);
    cards[bf?.cardId ?? '']?.triggers?.forEach((t, index) => {
      if (!bf || t.on !== kind) return;
      if (t.when && !evalCondition(state, cards, t.when, controller, bf.id)) return;
      out.push({
        sourceId: bf.id,
        cardId: bf.cardId,
        battlefield: true,
        index,
        controller,
        ...(subject !== undefined ? { subject } : {}),
      });
    });
  };
  for (const e of events) {
    if (e.type === 'CARD_PLAYED') {
      // R100: hiding a card emits a private CARD_PLAYED marker; that is not playing the card.
      if (e.visibleTo !== undefined) continue;
      // R49: "When you play a <card>" fires for the player's other permanents (and their Legend).
      for (const src of Object.values(state.objects)) {
        if (src.id === e.cardInstanceId || src.controller !== e.player) continue;
        if (!onBoard(src) && src.zone.kind !== 'legend') continue;
        cards[src.cardId]?.triggers?.forEach((t, index) => {
          if (
            t.on !== 'YOU_PLAY' ||
            !playMatches(
              state,
              cards,
              t.playFilter,
              e.cardId,
              e.player,
              e.fromFacedown === true,
              e.fromElsewhere === true,
              e.cardInstanceId,
            )
          )
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
        facedownPlay = e.fromFacedown === true;
        add(o, 'PLAY', o.controller);
        paidExtra = false;
        facedownPlay = false;
      }
    } else if (e.type === 'BATTLEFIELD_SCORED') {
      addBattlefield(e.battlefieldId, e.method, e.player);
      scoredAt = e.battlefieldId;
      for (const o of Object.values(state.objects)) {
        if (
          o.controller === e.player &&
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === e.battlefieldId &&
          (cards[o.cardId]?.type === 'UNIT' || isDeployGear(cards[o.cardId]))
        ) {
          add(o, e.method, e.player, (t) => !t.youScore);
        }
      }
      // "When you conquer / hold": a permanent anywhere on the board (not just at the scored battlefield).
      for (const o of Object.values(state.objects)) {
        if (o.controller !== e.player || !onBoard(o)) continue;
        add(o, e.method, e.player, (t) => t.youScore === true);
      }
      // R101: the scorer's Legend ("When you hold, ...").
      for (const l of Object.values(state.objects)) {
        if (l.controller === e.player && l.zone.kind === 'legend') add(l, e.method, e.player);
      }
      scoredAt = undefined;
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
        add(o, 'MOVE', o.controller, (t) => t.moveNth === undefined || o.moves?.n === t.moveNth);
      }
      // R108: leaving a battlefield (to the Base or another battlefield).
      if (
        o &&
        e.from !== 'base' &&
        e.from !== e.to &&
        onBoard(o) &&
        cards[o.cardId]?.type === 'UNIT'
      ) {
        add(o, 'MOVE_FROM', o.controller);
        // Battlefield "When a unit moves from here": the moved unit is the target.
        addBattlefield(e.from, 'UNIT_LEAVES_HERE', o.controller, o.id);
      }
    } else if (e.type === 'GEAR_KILLED' && !state.objects[e.gearId] && state.lki?.[e.gearId]) {
      // A token gear that ceased to exist (Bomb): its "when it dies" ability uses the last known information.
      const g = state.lki[e.gearId] as NonNullable<GameState['lki']>[string];
      cards[g.cardId]?.triggers?.forEach((t, index) => {
        if (t.on !== 'GEAR_LEAVES') return;
        out.push({
          sourceId: e.gearId,
          cardId: g.cardId,
          battlefield: false,
          index,
          controller: g.controller,
          ghost: true,
        });
      });
    } else if (e.type === 'GEAR_KILLED') {
      // "When this leaves the board" / "... or killed": a killed gear (not a token, which ceases to exist).
      const o = state.objects[e.gearId];
      if (o && o.zone.kind === 'trash') add(o, 'GEAR_LEAVES', o.owner);
    } else if (e.type === 'UNIT_KILLED') {
      const o = state.objects[e.unitId];
      if (o && o.zone.kind === 'trash') {
        diedAlone = e.alone === true;
        diedMighty = e.mighty === true;
        add(o, 'DEATH', o.owner, (t) => !t.inCombat || e.inCombat === true);
        // Karthus: "Your [Deathknell] effects trigger an additional time" (not the "die in combat" form).
        const doubles = Object.values(state.objects).some(
          (k) =>
            onBoard(k) &&
            k.controller === o.owner &&
            cards[k.cardId]?.statics?.some((st) => st.doubleDeathknell === true),
        );
        if (doubles) add(o, 'DEATH', o.owner, (t) => !t.inCombat);
        diedAlone = undefined;
        diedMighty = false;
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
            if (f.stunned && e.stunned !== true) return false;
            if (f.buffed && e.buffed !== true) return false;
            if (
              f.exceptSubtype &&
              dead?.subtypes.some((x) => x.toLowerCase() === (f.exceptSubtype ?? '').toLowerCase())
            ) {
              return false;
            }
            if (f.batch) {
              const key = src.id + ':' + t.effects.length;
              if (seenBatch.has(key)) return false;
              seenBatch.add(key);
            }
            return true;
          });
        }
      }
    } else if (e.type === 'UNIT_BUFFED') {
      const u = state.objects[e.objectId];
      if (u) {
        for (const src of Object.values(state.objects)) {
          if (src.controller !== u.controller || (!onBoard(src) && src.zone.kind !== 'legend'))
            continue;
          add(
            src,
            'UNIT_BUFFED',
            src.controller,
            (t) => (t.buffed === 'self' ? src.id === u.id : t.buffed === 'friendly'),
            u.id,
          );
        }
      }
    } else if (e.type === 'UNIT_CHOSEN') {
      const u = state.objects[e.objectId];
      if (u) {
        for (const src of Object.values(state.objects)) {
          if (!onBoard(src) && src.zone.kind !== 'legend') continue;
          if (src.controller !== e.chooser && src.id !== u.id) continue;
          add(
            src,
            'UNIT_CHOSEN',
            src.controller,
            (t) => {
              const c = t.chosen;
              if (!c) return false;
              if (c.spellOnly && !e.spell) return false;
              return c.target === 'self'
                ? src.id === u.id
                : u.controller === src.controller && e.chooser === src.controller;
            },
            u.id,
          );
        }
      }
    } else if (e.type === 'BECAME_MIGHT_AT') {
      const m = state.objects[e.objectId];
      if (m && onBoard(m)) add(m, 'MIGHT_REACHES', m.controller, (t) => t.mightAtLeast === e.n);
    } else if (e.type === 'BECAME_MIGHTY') {
      // X9: "When a unit you control becomes Mighty" fires for the controller's permanents.
      const m = state.objects[e.objectId];
      if (m && onBoard(m)) {
        for (const src of Object.values(state.objects)) {
          if (src.controller !== m.controller || (!onBoard(src) && src.zone.kind !== 'legend'))
            continue;
          add(src, 'UNIT_BECOMES_MIGHTY', src.controller);
        }
      }
    } else if (e.type === 'BECAME_EXHAUSTED' || e.type === 'BECAME_READY') {
      const o = state.objects[e.objectId];
      if (o && onBoard(o)) {
        add(o, e.type === 'BECAME_EXHAUSTED' ? 'BECOME_EXHAUSTED' : 'BECOME_READY', o.controller);
        // Battlefield "When you ready a friendly unit": every battlefield its controller controls.
        if (e.type === 'BECAME_READY' && cards[o.cardId]?.type === 'UNIT') {
          for (const bf of state.battlefields) {
            if (bf.controller === o.controller) {
              addBattlefield(bf.id, 'FRIENDLY_READIED', o.controller, o.id);
            }
          }
        }
      }
    } else if (e.type === 'EFFECT_EMPOWERED') {
      const o = state.objects[e.unitId];
      if (o && onBoard(o)) add(o, 'BECOME_EMPOWERED', o.controller);
    } else if (e.type === 'ABILITY_ACTIVATED') {
      // R108: "When you use an activated ability of a gear".
      const used = state.objects[e.sourceId];
      const def = used ? cards[used.cardId] : undefined;
      if (def && (def.type === 'GEAR' || (def.type === 'TOKEN' && def.stats.might === undefined))) {
        for (const src of Object.values(state.objects)) {
          if (src.controller !== e.player || (!onBoard(src) && src.zone.kind !== 'legend'))
            continue;
          add(src, 'USE_GEAR_ABILITY', src.controller);
        }
      }
    } else if (e.type === 'EFFECT_STUNNED') {
      // X9: "When you stun an enemy unit": fires for the stunning player's permanents.
      const stunned = state.objects[e.unitId];
      if (stunned && e.by !== undefined && stunned.controller !== e.by) {
        for (const src of Object.values(state.objects)) {
          if (src.controller !== e.by || (!onBoard(src) && src.zone.kind !== 'legend')) continue;
          add(src, 'YOU_STUN_ENEMY', src.controller);
        }
      }
    } else if (e.type === 'COST_CARDS_PAID' && e.kind === 'DISCARD' && e.cardIds.length > 0) {
      // X9: "When you discard me": the discarded cards themselves (now in the Trash) trigger.
      for (const id of e.cardIds) add(state.objects[id], 'DISCARD_SELF', e.player);
      // X9: "When you discard one or more cards".
      for (const src of Object.values(state.objects)) {
        if (src.controller !== e.player || !onBoard(src)) continue;
        add(src, 'YOU_DISCARD', src.controller);
      }
    } else if (e.type === 'CARD_HIDDEN') {
      // R100: "When you hide a card".
      for (const src of Object.values(state.objects)) {
        if (src.controller !== e.player || !onBoard(src)) continue;
        add(src, 'YOU_HIDE', src.controller);
      }
      // "When you hide a card here": the battlefield the card was hidden at.
      addBattlefield(e.battlefieldId, 'YOU_HIDE', e.player);
    } else if (e.type === 'TOKEN_PLAYED') {
      // R99: "When you play a token unit" fires for the player's permanents.
      const tokenDef = cards[e.cardId];
      if (tokenDef && tokenDef.stats.might !== undefined) {
        for (const src of Object.values(state.objects)) {
          if (src.controller !== e.player || src.id === e.unitId || !onBoard(src)) continue;
          cards[src.cardId]?.triggers?.forEach((tr, index) => {
            if (tr.on !== 'YOU_PLAY' || !tr.playFilter?.token) return;
            if (tr.when && !evalCondition(state, cards, tr.when, e.player, src.id)) return;
            out.push({
              sourceId: src.id,
              cardId: src.cardId,
              battlefield: false,
              index,
              controller: e.player,
            });
          });
        }
      }
    } else if (e.type === 'POINT_GAINED') {
      // R92: "When an opponent scores" fires for the other player's permanents.
      for (const src of Object.values(state.objects)) {
        if (src.controller === e.player || !onBoard(src)) continue;
        add(src, 'OPP_SCORES', src.controller);
      }
    } else if (e.type === 'COMBAT_ENDED') {
      // R71: the winner's units win the combat; every unit still standing was "in" it.
      for (const id of e.participants) {
        const o = state.objects[id];
        if (!o || !onBoard(o) || cards[o.cardId]?.type !== 'UNIT') continue;
        add(o, 'COMBAT_END', o.controller);
        if (e.winner !== null && o.controller === e.winner) add(o, 'WIN_COMBAT', o.controller);
      }
      // R101: the winner's Legend ("When you win a combat, ...").
      if (e.winner !== null) {
        for (const l of Object.values(state.objects)) {
          if (l.controller === e.winner && l.zone.kind === 'legend') add(l, 'WIN_COMBAT', e.winner);
        }
      }
      // R85: a Deploy gear at the battlefield wins the combat with its controller ("When you win a combat here").
      if (e.winner !== null) {
        for (const g of Object.values(state.objects)) {
          if (
            g.controller === e.winner &&
            g.zone.kind === 'battlefield' &&
            g.zone.battlefieldId === e.battlefieldId &&
            isDeployGear(cards[g.cardId])
          ) {
            add(g, 'WIN_COMBAT', g.controller);
          }
        }
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
      // "When a friendly unit attacks or defends alone" / "When an enemy unit attacks a battlefield you control".
      const here = Object.values(state.objects).filter(
        (u) =>
          u.zone.kind === 'battlefield' &&
          u.zone.battlefieldId === e.battlefieldId &&
          cards[u.cardId]?.type === 'UNIT',
      );
      for (const src of Object.values(state.objects)) {
        if (!onBoard(src) && src.zone.kind !== 'legend') continue;
        const mine = here.filter((u) => u.controller === src.controller);
        const theirs = here.filter((u) => u.controller !== src.controller);
        const bfOwner = state.battlefields.find((b) => b.id === e.battlefieldId)?.controller;
        for (const u of [...mine, ...theirs]) {
          add(
            src,
            'UNIT_ATTACKS',
            src.controller,
            (t) => {
              const f = t.unitFilter;
              if (!f) return false;
              const friendly = u.controller === src.controller;
              if ((f.side === 'friendly') !== friendly) return false;
              if (f.alone && mine.length !== 1) return false;
              if (f.attacking && u.controller !== c.attacker) return false;
              if (f.atMine && bfOwner !== src.controller) return false;
              return true;
            },
            u.id,
          );
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
    const tdef = cards[p.cardId]?.triggers?.[p.index];
    const effects = tdef?.effects;
    // X-modes: a "choose one —" ability always asks for its mode (and that mode's targets) when put on the Chain.
    const modal = tdef?.modes !== undefined;
    if (modal) {
      const pseudo: ChainItem = {
        id: '',
        kind: 'ABILITY',
        sourceObjectId: p.sourceId,
        controller: p.controller,
        status: 'PENDING',
        targets: [],
        choices: {},
        triggered: true,
        triggerIndex: p.index,
        sourceCardId: p.cardId,
      };
      if (allowedModes(s, cards, pseudo).length === 0) {
        raw.push({ type: 'TRIGGER_NO_TARGET', player: p.controller, sourceId: p.sourceId });
        continue;
      }
    }
    const choices = modal
      ? ([[]] as Target[][])
      : enumerateSpellTargets(s, cards, p.controller, effects, p.sourceId, { allowNone: true });
    if (choices !== null && choices.length === 0) {
      raw.push({ type: 'TRIGGER_NO_TARGET', player: p.controller, sourceId: p.sourceId });
      continue;
    }
    let auto =
      choices !== null && choices.length === 1 && !modal ? (choices[0] as Target[]) : undefined;
    if (p.subject !== undefined && choices !== null) {
      // The event's unit is the target ("give it ..."): legal only if it is among the allowed choices.
      const subjectId = p.subject;
      const pick = choices.find(
        (ch) => ch.length === 1 && ch[0]?.kind === 'object' && ch[0].id === subjectId,
      );
      if (!pick) {
        raw.push({ type: 'TRIGGER_NO_TARGET', player: p.controller, sourceId: p.sourceId });
        continue;
      }
      auto = pick as Target[];
    }
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
      ...(p.ghost ? { sourceCardId: p.cardId } : {}),
      ...(p.at !== undefined ? { triggerAt: p.at } : {}),
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
  markUnordered(s, added);
  askNextTrigger(s);
  return { state: s, events: stampEvents(s, raw) };
}

/** The card whose `triggers` a triggered ABILITY item runs: the object's, or (R44) the Battlefield card's. */
export function triggerSourceCardId(state: GameState, item: ChainItem): string | undefined {
  if (item.sourceBattlefieldId !== undefined) {
    return state.battlefields.find((b) => b.id === item.sourceBattlefieldId)?.cardId;
  }
  return state.objects[item.sourceObjectId]?.cardId ?? item.sourceCardId;
}

/** The trigger definition behind a triggered ability's Chain item. */
export function triggerDefOf(
  state: GameState,
  cards: CardDatabase,
  item: ChainItem,
): CardTrigger | undefined {
  if (item.triggerIndex === undefined) return undefined;
  const cardId = triggerSourceCardId(state, item);
  return cardId === undefined ? undefined : cards[cardId]?.triggers?.[item.triggerIndex];
}

/** X-modes: the modes of a "choose one —" trigger that its source may still choose now. */
export function allowedModes(state: GameState, cards: CardDatabase, item: ChainItem): number[] {
  const trig = triggerDefOf(state, cards, item);
  if (!trig?.modes) return [];
  const src = state.objects[item.sourceObjectId];
  const used =
    trig.modeOnce && src?.modesUsed?.turn === state.turn.number
      ? (src.modesUsed.used[item.triggerIndex ?? 0] ?? [])
      : [];
  return trig.modes.map((_, k) => k).filter((k) => !used.includes(k));
}

/** The effects of the triggered or activated ability behind a Chain item (undefined for others). */
export function abilityItemEffects(
  state: GameState,
  cards: CardDatabase,
  item: ChainItem,
): readonly CardEffect[] | undefined {
  if (item.kind === 'CARD' && item.byEffect) {
    const def = cards[state.objects[item.sourceObjectId]?.cardId ?? ''];
    return def ? spellEffects(def, item.mode) : undefined;
  }
  if (item.kind !== 'ABILITY') return undefined;
  const obj = state.objects[item.sourceObjectId];
  if (item.triggerIndex !== undefined) {
    const trig = triggerDefOf(state, cards, item);
    if (trig?.modes) return item.mode === undefined ? undefined : trig.modes[item.mode];
    return trig?.effects;
  }
  if (item.activatedIndex !== undefined) {
    const cardId = item.sourceCardId ?? obj?.cardId ?? '';
    return cards[cardId]?.abilities?.[item.activatedIndex]?.effects;
  }
  return undefined;
}

/**
 * X6 (583.3.b): flag the last `added` Chain items of any controller with two or more DIFFERENT simultaneous
 * triggers; their controller chooses the order. Identical abilities (same card and ability) need no choice.
 */
function markUnordered(s: GameState, added: number): void {
  const fresh = s.flow.chain.slice(s.flow.chain.length - added);
  for (const p of ['p0', 'p1'] as const) {
    const mine = fresh.filter((i) => i.controller === p && i.triggered);
    const sigs = new Set(mine.map((i) => `${triggerSourceCardId(s, i) ?? ''}:${i.triggerIndex}`));
    if (mine.length >= 2 && sigs.size >= 2) for (const i of mine) i.unordered = true;
  }
}

/** The ids of the flagged items of the first player (turn player first) that still has to order them. */
function nextOrderChoice(s: GameState): { player: PlayerId; ids: string[] } | null {
  for (const p of [s.turn.activePlayer, s.turn.activePlayer === 'p0' ? 'p1' : 'p0'] as const) {
    const ids = s.flow.chain.filter((i) => i.unordered && i.controller === p).map((i) => i.id);
    if (ids.length >= 2) return { player: p, ids: ids.reverse() }; // top of the Chain resolves first
  }
  return null;
}

/** Set flow.pendingChoice for the oldest PENDING triggered item on the Chain (mutates `s`). */
function askNextTrigger(s: GameState): void {
  if (s.flow.pendingChoice?.kind === 'OPTIONAL_EFFECT') return;
  if (s.flow.pendingChoice?.kind === 'DEATH_REPLACE') return;
  const order = nextOrderChoice(s);
  if (order) {
    s.flow.pendingChoice = { kind: 'TRIGGER_ORDER', player: order.player, chainItemIds: order.ids };
    return;
  }
  if (s.flow.pendingChoice?.kind === 'TRIGGER_ORDER') delete s.flow.pendingChoice; // R45: the resolving optional ability asks first
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
  // X-modes: a "choose one —" ability needs a mode that is still allowed; its targets are checked against that mode.
  const tdef = triggerDefOf(state, cards, item);
  let mode: number | undefined;
  if (tdef?.modes) {
    mode = intent.mode;
    if (mode === undefined || !allowedModes(state, cards, item).includes(mode)) {
      return ruleError('ILLEGAL_TARGET', 'choose one of the modes that can still be chosen');
    }
  } else if (intent.mode !== undefined) {
    return ruleError('ILLEGAL_TARGET', 'this ability has no modes');
  }
  const effects = tdef?.modes ? tdef.modes[mode as number] : abilityItemEffects(state, cards, item);
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
  if (mode !== undefined) {
    live.mode = mode;
    const src = s.objects[live.sourceObjectId];
    if (tdef?.modeOnce && src) {
      const same = src.modesUsed?.turn === s.turn.number;
      const used = { ...(same ? (src.modesUsed?.used ?? {}) : {}) };
      const idx = live.triggerIndex ?? 0;
      used[idx] = [...(used[idx] ?? []), mode];
      src.modesUsed = { turn: s.turn.number, used };
    }
  }
  delete s.flow.pendingChoice;
  askNextTrigger(s);
  const events = stampEvents(s, [
    { type: 'TRIGGER_TARGETED', player: live.controller, sourceId: itemSourceId(live), targets },
  ]);
  return { ok: true, state: s, events };
}

/**
 * CHOOSE_TRIGGER_ORDER (X6, 583.3.b): the controller puts their simultaneous triggers on the Chain in the order
 * they choose. `order` must be a permutation of the waiting items, first to resolve first.
 */
export function chooseTriggerOrder(
  state: GameState,
  _cards: CardDatabase,
  intent: ChooseTriggerOrderIntent,
): ReduceResult {
  const pc = state.flow.pendingChoice;
  if (!pc || pc.kind !== 'TRIGGER_ORDER') {
    return ruleError('WRONG_PHASE', 'no triggered abilities are waiting to be ordered');
  }
  if (intent.playerId !== pc.player) return ruleError('NOT_YOUR_PRIORITY', 'not your choice');
  const want = [...pc.chainItemIds].sort();
  if (
    !Array.isArray(intent.order) ||
    intent.order.length !== want.length ||
    [...intent.order].sort().some((id, k) => id !== want[k])
  ) {
    return ruleError('ILLEGAL_TARGET', 'order must list each waiting trigger exactly once');
  }
  const s = fork(state);
  // The flagged items occupy some Chain slots; refill those slots so intent.order[0] is on top.
  const slots = s.flow.chain.flatMap((i, k) => (pc.chainItemIds.includes(i.id) ? [k] : []));
  const byId = new Map(s.flow.chain.map((i) => [i.id, i] as const));
  const bottomFirst = [...intent.order].reverse();
  slots.forEach((slot, k) => {
    const item = byId.get(bottomFirst[k] as string) as ChainItem;
    delete item.unordered;
    s.flow.chain[slot] = item;
  });
  delete s.flow.pendingChoice;
  askNextTrigger(s);
  const top = s.flow.chain[s.flow.chain.length - 1];
  if (top) s.flow.priority = top.controller === 'p0' ? 'p1' : 'p0';
  s.turnState = deriveTurnState(s);
  return { ok: true, state: s, events: [] };
}
