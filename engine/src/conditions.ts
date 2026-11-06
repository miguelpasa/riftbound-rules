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
import { isUnitDef } from './tokens.js';
import { hereOfSource } from './sources.js';
import type {
  CardDatabase,
  CardInstance,
  Condition,
  CountCmp,
  GameState,
  PlayerId,
} from './types/index.js';

const compare = (value: number, cmp: CountCmp, n: number): boolean =>
  cmp === 'EQ' ? value === n : cmp === 'GTE' ? value >= n : value <= n;

const onBoard = (o: CardInstance): boolean =>
  o.zone.kind === 'base' || o.zone.kind === 'battlefield';

export function evalCondition(
  state: GameState,
  cards: CardDatabase,
  cond: Condition,
  controller: PlayerId,
  sourceId: string,
): boolean {
  switch (cond.kind) {
    case 'AT_BATTLEFIELD':
      return hereOfSource(state, sourceId) !== null;
    case 'XP':
      return (state.players[playerIndex(controller)]?.xp ?? 0) >= cond.n;
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
      const here = hereOfSource(state, sourceId);
      if (cond.where === 'here' && here === null) return false;
      let count = 0;
      for (const o of Object.values(state.objects)) {
        if (o.controller !== side || (cond.other === true && o.id === sourceId)) continue;
        const def = cards[o.cardId];
        if (!def) continue;
        const kindOk =
          cond.what === 'unit'
            ? isUnitDef(def)
            : cond.what === 'gear'
              ? def.type === 'GEAR'
              : cond.what === 'rune'
                ? def.type === 'RUNE'
                : false;
        if (!kindOk) continue;
        const z = o.zone;
        const placed =
          cond.where === 'here'
            ? z.kind === 'battlefield' && z.battlefieldId === here
            : cond.where === 'base'
              ? z.kind === 'base'
              : z.kind === 'base' || z.kind === 'battlefield';
        if (placed) count++;
      }
      return compare(count, cond.cmp, cond.n);
    }
  }
}
