/**
 * "This turn" triggers (Rally the Troops, Fanfare, Nami, Deadly Flourish, Imperial Decree): an effect creates a
 * `DelayedTrigger` that watches the events of the rest of the turn. When it fires its (target-free apart from the
 * event's unit) effects run AT ONCE, without the Chain (UNCLEAR, docs/ASSUMPTIONS.md X-delayed), like the
 * turn-structure triggers. They are removed at the Ending step.
 */
import { runEffects, targetRequirements } from './effects.js';
import { isUnitDef } from './tokens.js';
import { fork } from './workingCopy.js';
import type {
  CardDatabase,
  DelayedTrigger,
  GameEvent,
  GameEventInput,
  GameState,
} from './types/index.js';

const onBoard = (state: GameState, id: string): boolean => {
  const o = state.objects[id];
  return o !== undefined && (o.zone.kind === 'base' || o.zone.kind === 'battlefield');
};

/** Fire the delayed triggers the new `events` (and units that have meanwhile entered) call for. */
export function runDelayed(
  state: GameState,
  cards: CardDatabase,
  events: readonly GameEvent[],
): { state: GameState; events: GameEventInput[] } {
  if (!state.delayed || state.delayed.length === 0) return { state, events: [] };
  const s = fork(state);
  const out: GameEventInput[] = [];
  const list = s.delayed as DelayedTrigger[];
  const run = (d: DelayedTrigger, subject?: string): void => {
    const targets = subject ? [{ kind: 'object' as const, id: subject }] : [];
    out.push(...runEffects(s, d.controller, d.effects, cards, targets, d.sourceCardId, ''));
  };
  for (const e of events) {
    for (const d of list) {
      if (d.turn !== s.turn.number || (d.times !== undefined && d.times <= 0)) continue;
      if (d.on === 'UNIT_PLAYED' && e.type === 'CARD_PLAYED' && e.player === d.controller) {
        if (!isUnitDef(cards[e.cardId])) continue;
        if (d.times !== undefined) d.times--;
        // An effect that needs the unit waits until it is on the board; others happen now.
        if (targetRequirements(d.effects).length > 0) {
          d.waiting = [...(d.waiting ?? []), e.cardInstanceId];
        } else {
          run(d);
        }
      } else if (
        d.on === 'UNIT_DAMAGED' &&
        (e.type === 'EFFECT_DAMAGE' || e.type === 'COMBAT_DAMAGE_ASSIGNED') &&
        e.amount > 0 &&
        onBoard(s, e.unitId) &&
        (d.subject === undefined || d.subject === e.unitId)
      ) {
        // "the next time it takes damage" (a subject) fires once.
        if (d.subject !== undefined) d.times = 0;
        run(d, e.unitId);
      } else if (d.on === 'SUBJECT_DIES' && e.type === 'UNIT_KILLED' && e.unitId === d.subject) {
        d.times = 0;
        run(d);
      } else if (
        d.on === 'SUBJECT_WINS_COMBAT' &&
        e.type === 'COMBAT_ENDED' &&
        d.subject !== undefined &&
        e.winner !== null &&
        e.participants.includes(d.subject) &&
        s.objects[d.subject]?.controller === e.winner &&
        onBoard(s, d.subject)
      ) {
        run(d);
      }
    }
  }
  // Units played earlier this turn that have now entered the board.
  for (const d of list) {
    if (!d.waiting || d.waiting.length === 0) continue;
    const keep: string[] = [];
    for (const id of d.waiting) {
      if (onBoard(s, id)) run(d, id);
      else if (s.objects[id]?.zone.kind === 'chain') keep.push(id);
    }
    d.waiting = keep;
  }
  s.delayed = list.filter(
    (d) =>
      d.turn === s.turn.number &&
      (d.times === undefined || d.times > 0 || (d.waiting?.length ?? 0) > 0),
  );
  return { state: s, events: out };
}

/** "... at the end of this turn": the delayed effects set for the Ending step run now, before the turn's effects expire. */
export function runEndOfTurnDelayed(
  state: GameState,
  cards: CardDatabase,
): { state: GameState; events: GameEventInput[] } {
  const due = (state.delayed ?? []).filter(
    (d) => d.on === 'END_OF_TURN' && d.turn === state.turn.number,
  );
  if (due.length === 0) return { state, events: [] };
  const s = fork(state);
  const out: GameEventInput[] = [];
  for (const d of due) {
    out.push(...runEffects(s, d.controller, d.effects, cards, [], d.sourceCardId, ''));
  }
  return { state: s, events: out };
}
