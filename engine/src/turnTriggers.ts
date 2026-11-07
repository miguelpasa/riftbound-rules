/**
 * R72: turn-structure triggers, "At the start of your Beginning Phase, ..." (TURN_START) and "At the end
 * of your turn, ..." (TURN_END).
 *
 * The start-of-turn sequence and the Ending step run inside ONE reduce call and cannot stop for the
 * Chain, so these abilities resolve INLINE: when the step is reached each of the active player's
 * permanents (units, gear and their Legend) with such a trigger whose condition holds has its effects run
 * at once, in object order, without the Chain and without targets. The parser only accepts bodies
 * without a target choice or an optional cost (UNCLEAR, docs/ASSUMPTIONS.md R72).
 */
import { runEffects } from './effects.js';
import { evalCondition } from './conditions.js';
import { fork } from './workingCopy.js';
import type { CardDatabase, GameEventInput, GameState, TriggerKind } from './types/index.js';

type HookResult = { state: GameState; events: GameEventInput[] };

const num = (id: string): number => Number(id.slice(1));

/** True when some card has a trigger of this kind (the hook is a no-op, and copies nothing, otherwise). */
function anyCard(cards: CardDatabase, kind: TriggerKind): boolean {
  return Object.values(cards).some((d) => d.triggers?.some((t) => t.on === kind));
}

export function runTurnTriggers(
  state: GameState,
  cards: CardDatabase,
  kind: 'TURN_START' | 'TURN_END',
): HookResult {
  if (!anyCard(cards, kind)) return { state, events: [] };
  const s = fork(state);
  const player = s.turn.activePlayer;
  const events: GameEventInput[] = [];
  const sources = Object.values(s.objects)
    .filter(
      (o) =>
        o.controller === player &&
        (o.zone.kind === 'base' || o.zone.kind === 'battlefield' || o.zone.kind === 'legend'),
    )
    .sort((a, b) => num(a.id) - num(b.id));
  for (const o of sources) {
    const triggers = cards[o.cardId]?.triggers ?? [];
    for (const t of triggers) {
      if (t.on !== kind) continue;
      if (s.gameStatus !== 'IN_PROGRESS') return { state: s, events };
      if (t.when && !evalCondition(s, cards, t.when, player, o.id)) continue;
      events.push(...runEffects(s, player, t.effects, cards, [], o.cardId, o.id));
    }
  }
  return { state: s, events };
}
