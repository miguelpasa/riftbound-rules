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
 * - drawWithBurnOut: if a burn-out recycled nothing the deck is still empty, so that burn-out is the
 *   last one for this draw and the remaining draws are abandoned (guards against infinite loops).
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
  while (remaining > 0 && state.gameStatus === 'IN_PROGRESS') {
    const drawn = drawFromTop(state, player, remaining);
    out.push(...drawn);
    remaining -= drawn.length;
    if (remaining <= 0) break;
    const hadTrash = state.players[playerIndex(player)].trash.length > 0;
    out.push(...burnOut(state, player, cards));
    // Nothing to recycle: the deck is still empty; abandon the remaining draws after this burn-out.
    if (!hadTrash) break;
  }
  return out;
}
