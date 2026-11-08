/**
 * Burn Out (Core Rules 414.4, 432) and draw-with-burn-out.
 *
 * Both helpers MUTATE the working state (a structuredClone owned by the caller) and return event
 * inputs (unstamped).
 *
 * Decisions:
 * - 432.2.b: the whole Trash is added to the Main Deck (any cards still in the deck stay) and the
 *   resulting deck is shuffled with the in-place RNG.
 * - 432.2.c: the opponent gains 1 point (POINT_GAINED source 'BURN_OUT'); points cannot be prevented.
 * - 432.3.c: if the opponent then has >= victoryScore points and strictly more than the burning
 *   player, the game ends at once (GAME_ENDED).
 * - drawWithBurnOut: with Deck and Trash both empty every attempt burns out again (432.3, 432.3.a),
 *   until the opponent reaches the victory score.
 */
import { rngShuffle } from './rng.js';
import { drawFromTop } from './setup.js';
import { opponentOf, playerIndex } from './types/constants.js';
import type {
  CardDatabase,
  CardInstance,
  GameEventInput,
  GameState,
  PlayerId,
} from './types/index.js';

/** Perform one Burn Out for `player` (432.2 b-c, 432.3.c). Caller does steps (a) and (d). */
export function burnOut(
  state: GameState,
  player: PlayerId,
  cards?: CardDatabase,
): GameEventInput[] {
  void cards; // reserved: card effects that modify burn out (none in the MVP)
  const out: GameEventInput[] = [{ type: 'BURN_OUT', player }];
  const ps = state.players[playerIndex(player)];
  // 432.2.b: recycle the Trash into the Main Deck, then shuffle.
  const recycled = ps.trash.splice(0, ps.trash.length);
  for (const id of recycled) {
    (state.objects[id] as CardInstance).zone = { kind: 'mainDeck', player };
  }
  ps.mainDeck = rngShuffle([...ps.mainDeck, ...recycled], state);
  // 432.2.c: the opponent gains 1 point.
  const opp = opponentOf(player);
  const os = state.players[playerIndex(opp)];
  os.points += 1;
  out.push({ type: 'POINT_GAINED', player: opp, amount: 1, source: 'BURN_OUT' });
  // 432.3.c
  if (
    state.gameStatus === 'IN_PROGRESS' &&
    os.points >= state.victoryScore &&
    os.points > ps.points
  ) {
    state.gameStatus = 'FINISHED';
    state.winner = opp;
    out.push({ type: 'GAME_ENDED', winner: opp });
  }
  return out;
}

/**
 * X8 (607.1.b-c): looking at, revealing or milling cards while the Main Deck is EMPTY burns out first (the
 * Trash is shuffled into the deck, the opponent gains 1 point); a deck with fewer cards than asked for does
 * not. Returns the events; the caller must check `state.gameStatus` before going on.
 */
export function burnOutIfEmpty(
  state: GameState,
  player: PlayerId,
  cards: CardDatabase,
): GameEventInput[] {
  const ps = state.players[playerIndex(player)];
  if (ps.mainDeck.length > 0 || state.gameStatus !== 'IN_PROGRESS') return [];
  return burnOut(state, player, cards);
}

/**
 * Draw `n` cards with Burn Out handling (414.4): draw as many as possible, burn out, draw the rest.
 * Stops as soon as the game ends.
 */
export function drawWithBurnOut(
  state: GameState,
  player: PlayerId,
  n: number,
  cards: CardDatabase,
): GameEventInput[] {
  const out: GameEventInput[] = [];
  let remaining = n;
  let burns = 0;
  while (remaining > 0 && state.gameStatus === 'IN_PROGRESS') {
    const drawn = drawFromTop(state, player, remaining);
    out.push(...drawn);
    remaining -= drawn.length;
    if (remaining <= 0) break;
    out.push(...burnOut(state, player, cards));
    // 432.3 / 432.3.a: with Deck and Trash both empty the next attempt burns out again, giving
    // the opponent a point each time until they win. Terminates because points only rise; the
    // guard is defence in depth.
    if (++burns > 10_000) break;
  }
  return out;
}
