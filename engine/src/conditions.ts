/**
 * Condition evaluation (R43). Pure and read-only: a Condition is a predicate over the game state
 * seen from a source object and its controller. It reads only public information (board, bases,
 * runes) and the SIZE of hands, never the contents of a hidden zone, so a sanitized state yields the
 * same answer as the full one.
 *
 * R44: the source may also be a Battlefield card (its battlefield id), whose "here" is itself.
 *
 * Moments (see docs/ASSUMPTIONS.md R43): a trigger's `when` is checked as the ability triggers (the
 * Chain item is not created otherwise) and again as it resolves; `entersReadyWhen` is checked as
 * the permanent enters.
 */
import { playerIndex } from './types/constants.js';
import { baseMight } from './baseMight.js';
import { petTagCount } from './petTags.js';
import { isDeployGear, isUnitDef } from './tokens.js';
import { hereOfSource } from './sources.js';
import { effectiveMight } from './combat.js';
import type {
  CardDatabase,
  CardInstance,
  Condition,
  CountCmp,
  GameEventInput,
  GameState,
  PlayerId,
} from './types/index.js';

const compare = (value: number, cmp: CountCmp, n: number): boolean =>
  cmp === 'EQ' ? value === n : cmp === 'GTE' ? value >= n : value <= n;

const onBoard = (o: CardInstance): boolean =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield';

const trackedDb = new WeakMap<CardDatabase, boolean>();

/** True when some card in the database has a "died this turn" condition (deaths are recorded only then). */
function tracksDeaths(cards: CardDatabase): boolean {
  let v = trackedDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) =>
      JSON.stringify([d.entersReadyWhen, d.triggers, d.statics, d.costReduction]).includes(
        'DIED_THIS_TURN',
      ),
    );
    trackedDb.set(cards, v);
  }
  return v;
}

const flagsDb = new WeakMap<CardDatabase, boolean>();

/** True when some card in the database reads a per-turn flag (discarded, gained XP, spent) this turn. */
export function tracksTurnFlags(cards: CardDatabase): boolean {
  let v = flagsDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) => {
      const j = JSON.stringify([d.entersReadyWhen, d.triggers, d.statics, d.costReduction]);
      return (
        j.includes('TURN_FLAG') ||
        j.includes('TURN_SPENT') ||
        j.includes('CONQUERED_THIS_TURN') ||
        j.includes('HELD_THIS_TURN') ||
        j.includes('PLAY_ONLY_CONQUERED')
      );
    });
    flagsDb.set(cards, v);
  }
  return v;
}

/** Note, from the events of one step, who discarded a card or gained XP this turn (mutates; opt-in). */
export function noteTurnFlags(
  state: GameState,
  cards: CardDatabase,
  events: readonly GameEventInput[],
): void {
  if (!tracksTurnFlags(cards)) return;
  for (const e of events) {
    let who: PlayerId;
    let flag: 'xpGained' | 'discarded';
    if (e.type === 'BATTLEFIELD_SCORED') {
      // "for each battlefield you've conquered this turn" counts one per conquer (holds are not conquers).
      const ps = state.players[playerIndex(e.player)] as GameState['players'][number];
      const rec =
        ps.turnFlags?.turn === state.turn.number ? ps.turnFlags : { turn: state.turn.number };
      ps.turnFlags =
        e.method === 'CONQUER'
          ? {
              ...rec,
              conquered: (rec.conquered ?? 0) + 1,
              conqueredAt: [...(rec.conqueredAt ?? []), e.battlefieldId],
            }
          : { ...rec, held: (rec.held ?? 0) + 1 };
      continue;
    }
    if (e.type === 'XP_GAINED') {
      who = e.player;
      flag = 'xpGained';
    } else if (
      e.type === 'HAND_DISCARDED' ||
      (e.type === 'COST_CARDS_PAID' && e.kind === 'DISCARD')
    ) {
      who = e.player;
      flag = 'discarded';
    } else {
      continue;
    }
    const ps = state.players[playerIndex(who)] as GameState['players'][number];
    const rec =
      ps.turnFlags?.turn === state.turn.number ? ps.turnFlags : { turn: state.turn.number };
    ps.turnFlags = { ...rec, [flag]: true };
  }
}

/** Note what a play cost this turn (mutates the working state; opt-in like the other turn flags). */
export function noteSpent(
  state: GameState,
  cards: CardDatabase,
  player: PlayerId,
  energy: number,
  power: number,
  isSpell: boolean,
): void {
  if (!tracksTurnFlags(cards)) return;
  const ps = state.players[playerIndex(player)] as GameState['players'][number];
  const rec = ps.turnFlags?.turn === state.turn.number ? ps.turnFlags : { turn: state.turn.number };
  ps.turnFlags = {
    ...rec,
    ...(isSpell ? { spellEnergy: Math.max(rec.spellEnergy ?? 0, energy) } : {}),
    power: (rec.power ?? 0) + power,
  };
}

const excessDb = new WeakMap<CardDatabase, boolean>();

/** R87: true when some card reads excess combat damage (it is tracked only then, so other games are unchanged). */
export function tracksExcess(cards: CardDatabase): boolean {
  let v = excessDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) => {
      const j = JSON.stringify(d.triggers ?? []);
      return j.includes('EXCESS_DAMAGE') || j.includes('"EXCESS"');
    });
    excessDb.set(cards, v);
  }
  return v;
}

const combatEndDb = new WeakMap<CardDatabase, boolean>();

/** R71: true when some card reacts to a combat ending (COMBAT_ENDED is emitted only then, so replays stay unchanged). */
export function tracksCombatEnd(cards: CardDatabase): boolean {
  let v = combatEndDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some(
      (d) =>
        d.triggers?.some((t) => t.on === 'WIN_COMBAT' || t.on === 'COMBAT_END') ||
        JSON.stringify([d.effects, d.modes, d.abilities, d.triggers]).includes(
          'SUBJECT_WINS_COMBAT',
        ),
    );
    combatEndDb.set(cards, v ?? false);
  }
  return v ?? false;
}

const readinessDb = new WeakMap<CardDatabase, boolean>();

/** R78: true when some card reacts to a permanent becoming exhausted or ready (the diff is computed only then). */
export function tracksReadiness(cards: CardDatabase): boolean {
  let v = readinessDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) =>
      d.triggers?.some(
        (t) =>
          t.on === 'BECOME_EXHAUSTED' || t.on === 'BECOME_READY' || t.on === 'FRIENDLY_READIED',
      ),
    );
    readinessDb.set(cards, v ?? false);
  }
  return v ?? false;
}

const chosenDb = new WeakMap<CardDatabase, boolean>();

/** True when some card reacts to a unit being chosen (the chain diff runs only then). */
export function tracksChosen(cards: CardDatabase): boolean {
  let v = chosenDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) => d.triggers?.some((t) => t.on === 'UNIT_CHOSEN'));
    chosenDb.set(cards, v);
  }
  return v;
}

const buffedDb = new WeakMap<CardDatabase, boolean>();

/** True when some card reacts to a unit being buffed (the buff diff runs only then). */
export function tracksBuffed(cards: CardDatabase): boolean {
  let v = buffedDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) => d.triggers?.some((t) => t.on === 'UNIT_BUFFED'));
    buffedDb.set(cards, v);
  }
  return v;
}

const mightyDb = new WeakMap<CardDatabase, boolean>();

/** X9: true when some card reacts to a unit becoming Mighty (the Might diff is computed only then). */
const mightAtDb = new WeakMap<CardDatabase, number[]>();

/** The Might thresholds some card's "When my Might becomes N or more" trigger waits for (none = not tracked). */
export function mightThresholds(cards: CardDatabase): number[] {
  let v = mightAtDb.get(cards);
  if (v === undefined) {
    const set = new Set<number>();
    for (const d of Object.values(cards)) {
      for (const t of d.triggers ?? [])
        if (t.on === 'MIGHT_REACHES' && t.mightAtLeast) set.add(t.mightAtLeast);
    }
    v = [...set];
    mightAtDb.set(cards, v);
  }
  return v;
}

export function tracksMighty(cards: CardDatabase): boolean {
  let v = mightyDb.get(cards);
  if (v === undefined) {
    v = Object.values(cards).some((d) => d.triggers?.some((t) => t.on === 'UNIT_BECOMES_MIGHTY'));
    mightyDb.set(cards, v ?? false);
  }
  return v ?? false;
}

/** R56: note that a unit controlled by `controller` died (mutates; no-op unless a card needs it). */
export function recordDeath(
  state: GameState,
  cards: CardDatabase,
  controller: PlayerId,
  gear = false,
): void {
  if (!tracksDeaths(cards)) return;
  const ps = state.players[playerIndex(controller)] as GameState['players'][number];
  const rec = ps.diedThisTurn?.turn === state.turn.number ? ps.diedThisTurn : undefined;
  const count = (rec?.count ?? 0) + (gear ? 0 : 1);
  const g = (rec?.gear ?? 0) + (gear ? 1 : 0);
  ps.diedThisTurn = { turn: state.turn.number, count, ...(g > 0 ? { gear: g } : {}) };
}

export function evalCondition(
  state: GameState,
  cards: CardDatabase,
  cond: Condition,
  controller: PlayerId,
  sourceId: string,
  /** The battlefield a scoring trigger is about (read by `where: 'scored'`). */
  at?: string,
): boolean {
  switch (cond.kind) {
    case 'AT_BATTLEFIELD':
      return hereOfSource(state, sourceId) !== null;
    case 'XP':
      return (state.players[playerIndex(controller)]?.xp ?? 0) >= cond.n;
    case 'DIED_THIS_TURN': {
      const died = (p: PlayerId): number => {
        const rec = state.players[playerIndex(p)]?.diedThisTurn;
        return rec && rec.turn === state.turn.number
          ? rec.count + (cond.orGear ? (rec.gear ?? 0) : 0)
          : 0;
      };
      const other: PlayerId = controller === 'p0' ? 'p1' : 'p0';
      const n =
        cond.who === 'friendly'
          ? died(controller)
          : cond.who === 'enemy'
            ? died(other)
            : died(controller) + died(other);
      return n > 0;
    }
    case 'EXCESS_DAMAGE': {
      const rec = state.players[playerIndex(controller)]?.excessRecord;
      return rec !== undefined && rec.turn === state.turn.number && rec.amount >= cond.n;
    }
    case 'COMBAT_ROLE': {
      const c = state.flow.combat;
      const src = state.objects[sourceId];
      if (
        !c ||
        !src ||
        src.zone.kind !== 'battlefield' ||
        src.zone.battlefieldId !== c.battlefieldId
      ) {
        return false;
      }
      const attacking = src.controller === c.attacker;
      if (cond.role === 'ATTACKING' && !attacking) return false;
      if (cond.role === 'DEFENDING' && attacking) return false;
      const others = Object.values(state.objects).filter(
        (o) =>
          o.id !== src.id &&
          o.controller === src.controller &&
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === c.battlefieldId &&
          cards[o.cardId]?.type === 'UNIT',
      ).length;
      if (cond.alone && others > 0) return false;
      if (cond.withOther && others === 0) return false;
      if (cond.oneOnOne) {
        const count = (p: PlayerId): number =>
          Object.values(state.objects).filter(
            (o) =>
              o.controller === p &&
              o.zone.kind === 'battlefield' &&
              o.zone.battlefieldId === c.battlefieldId &&
              cards[o.cardId]?.type === 'UNIT',
          ).length;
        if (count(c.attacker) !== 1 || count(c.defender) !== 1) return false;
      }
      return true;
    }
    case 'FROM_FACEDOWN':
      return true; // decided by the triggering CARD_PLAYED event (triggers.ts)
    case 'SHOWED_OFF':
      return state.objects[sourceId]?.showedOff !== undefined;
    case 'ALL':
      return cond.conds.every((c) => evalCondition(state, cards, c, controller, sourceId, at));
    case 'NOT':
      return !evalCondition(state, cards, cond.cond, controller, sourceId);
    case 'PLAYED_FROM': {
      const how = state.objects[sourceId]?.playedHow;
      return cond.from === 'FACEDOWN' ? how === 'FACEDOWN' : how === undefined;
    }
    case 'YOUR_TURN':
      return (state.turn.activePlayer === controller) !== (cond.not === true);
    case 'OTHER_UNITS_MIGHT': {
      let sum = 0;
      for (const o of Object.values(state.objects)) {
        if (o.id === sourceId || o.controller !== controller) continue;
        if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') continue;
        if (!isUnitDef(cards[o.cardId])) continue;
        sum += Math.max(0, effectiveMight(state, cards, o.id, { role: null }));
      }
      return sum >= cond.n;
    }
    case 'CONTROLS_HERE': {
      const here = hereOfSource(state, sourceId);
      return (
        here !== null && state.battlefields.find((b) => b.id === here)?.controller === controller
      );
    }
    case 'IN_COMBAT': {
      const c = state.flow.combat;
      const here = hereOfSource(state, sourceId);
      return c !== undefined && here !== null && c.battlefieldId === here;
    }
    case 'PLAYED_TO_BATTLEFIELD': {
      const rec = state.players[playerIndex(controller)]?.playedThisTurn;
      if (!rec || rec.turn !== state.turn.number) return false;
      return rec.objectIds.some((id) => {
        const o = state.objects[id];
        const t = o ? cards[o.cardId]?.type : undefined;
        return o?.zone.kind === 'battlefield' && (t === 'UNIT' || t === 'GEAR' || t === 'TOKEN');
      });
    }
    case 'CONTROLS_EMPOWERED':
      return Object.values(state.objects).some(
        (o) => o.controller === controller && onBoard(o) && o.empowered === true,
      );
    case 'TURN_FLAG': {
      const rec = state.players[playerIndex(controller)]?.turnFlags;
      return rec !== undefined && rec.turn === state.turn.number && rec[cond.flag] === true;
    }
    case 'PET_TAGS':
      return petTagCount(state, cards, controller) >= cond.n;
    case 'TURN_SPENT': {
      const rec = state.players[playerIndex(controller)]?.turnFlags;
      if (!rec || rec.turn !== state.turn.number) return false;
      return (cond.what === 'spellEnergy' ? (rec.spellEnergy ?? 0) : (rec.power ?? 0)) >= cond.n;
    }
    case 'TARGET_STUNNED':
    case 'TARGET_MIGHT':
    case 'TARGET_EMPOWERED':
    case 'TARGET_ALONE':
    case 'LEGION':
    case 'OPP_OTHER_SPELL':
      return false; // read from the chosen targets by runEffects
    case 'ENEMY_STUNNED':
      return Object.values(state.objects).some(
        (o) => o.controller !== controller && onBoard(o) && o.stunned === true,
      );
    case 'NAME_IN_TRASH': {
      const name = cards[state.objects[sourceId]?.cardId ?? '']?.name;
      return (
        name !== undefined &&
        Object.values(state.objects).some(
          (o) =>
            o.zone.kind === 'trash' &&
            o.owner === controller &&
            o.id !== sourceId &&
            cards[o.cardId]?.name === name,
        )
      );
    }
    case 'RUNES_VS_OPPONENT': {
      const runes = (p: PlayerId): number =>
        Object.values(state.objects).filter(
          (o) => o.controller === p && onBoard(o) && cards[o.cardId]?.type === 'RUNE',
        ).length;
      const other: PlayerId = controller === 'p0' ? 'p1' : 'p0';
      return cond.cmp === 'FEWER'
        ? runes(controller) < runes(other)
        : runes(controller) > runes(other);
    }
    case 'FACEDOWN': {
      const here = cond.here ? hereOfSource(state, sourceId) : null;
      if (cond.here && here === null) return false;
      return state.battlefields.some((b) => {
        if (b.facedownSlotId === null || (cond.here && b.id !== here)) return false;
        return state.objects[b.facedownSlotId]?.controller === controller;
      });
    }
    case 'DIED_ALONE':
    case 'DIED_MIGHTY':
      return true; // decided by the triggering UNIT_KILLED event (triggers.ts)
    case 'PAID_ADDITIONAL':
      if (cond.spell) return state.objects[sourceId]?.paidExtra === true;
      return true; // decided by the triggering CARD_PLAYED event (triggers.ts); not re-checked later
    case 'CONTROLS_BATTLEFIELD': {
      const side: PlayerId =
        cond.who === 'friendly' ? controller : controller === 'p0' ? 'p1' : 'p0';
      return state.battlefields.some((b) => b.controller === side);
    }
    case 'SCORE_NEAR': {
      const side: PlayerId =
        cond.who === 'friendly' ? controller : controller === 'p0' ? 'p1' : 'p0';
      const near = (state.players[playerIndex(side)]?.points ?? 0) >= state.victoryScore - 3;
      return cond.not ? !near : near;
    }
    case 'MOVES_AT_LEAST': {
      const mv = state.objects[sourceId]?.moves;
      return mv !== undefined && mv.turn === state.turn.number && mv.n >= cond.n;
    }
    case 'MIGHTY': {
      const me = state.objects[sourceId];
      return (
        me !== undefined &&
        baseMight(cards[me.cardId], me) + me.mightBonus + (me.buffed ? 1 : 0) >= 5
      );
    }
    case 'NOT_IN_HAND':
      return state.objects[sourceId]?.zone.kind !== 'hand';
    case 'BUFFED':
      return state.objects[sourceId]?.buffed === true;
    case 'EMPOWERED':
      return state.objects[sourceId]?.empowered === true;
    case 'CONTROL_SUBTYPE':
      return Object.values(state.objects).some((o) => {
        const def = cards[o.cardId];
        return (
          o.controller === controller &&
          onBoard(o) &&
          isUnitDef(def) &&
          !(cond.other === true && o.id === sourceId) &&
          def.subtypes.some((s) => s.toLowerCase() === cond.subtype.toLowerCase())
        );
      });
    case 'COUNT': {
      const side: PlayerId =
        cond.who === 'friendly' ? controller : controller === 'p0' ? 'p1' : 'p0';
      if (cond.where === 'hand') {
        return compare(state.players[playerIndex(side)].hand.length, cond.cmp, cond.n);
      }
      if (cond.where === 'runeDeck') {
        return compare(state.players[playerIndex(side)].runeDeck.length, cond.cmp, cond.n);
      }
      const here = cond.where === 'scored' ? (at ?? null) : hereOfSource(state, sourceId);
      if ((cond.where === 'here' || cond.where === 'scored') && here === null) return false;
      let count = 0;
      for (const o of Object.values(state.objects)) {
        if (o.controller !== side || (cond.other === true && o.id === sourceId)) continue;
        const def = cards[o.cardId];
        if (!def) continue;
        if (cond.ready && !o.ready) continue;
        if (cond.withDeploy && !isDeployGear(def)) continue;
        if (cond.mighty && effectiveMight(state, cards, o.id, { role: null }) < 5) continue; // 709
        const kindOk =
          cond.what === 'unit'
            ? isUnitDef(def)
            : cond.what === 'unitOrGear'
              ? def.type === 'GEAR' || isUnitDef(def)
              : cond.what === 'gear'
                ? def.type === 'GEAR'
                : cond.what === 'rune'
                  ? def.type === 'RUNE'
                  : false;
        if (!kindOk) continue;
        const z = o.zone;
        const placed =
          cond.where === 'here' || cond.where === 'scored'
            ? z.kind === 'battlefield' && z.battlefieldId === here
            : cond.where === 'base'
              ? z.kind === 'base'
              : cond.where === 'battlefields'
                ? z.kind === 'battlefield'
                : z.kind === 'base' || z.kind === 'battlefield';
        if (placed) count++;
      }
      return compare(count, cond.cmp, cond.n);
    }
  }
}
