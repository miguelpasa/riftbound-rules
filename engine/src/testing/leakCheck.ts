/**
 * Reusable leak detector for outbound payloads (views, events, whole S2C messages).
 * Independent of sanitize.ts: it recomputes what `viewer` may see from the raw state (Rule 128).
 */
import type { CardInstance, GameState, PlayerId } from '../types/state.js';

export interface LeakCheckOptions {
  /** Optional cardId -> display name; names of viewer-hidden cards are flagged too. */
  cardNames?: Record<string, string>;
}

function visibleTo(obj: CardInstance, viewer: PlayerId): boolean {
  switch (obj.zone.kind) {
    case 'hand':
      return obj.zone.player === viewer;
    case 'mainDeck':
    case 'runeDeck':
      return false;
    case 'facedown':
      return obj.controller === viewer;
    default:
      return true;
  }
}

/** Returns human-readable descriptions of every leak found in `payload` (empty = clean). */
export function findLeaks(
  payload: unknown,
  state: GameState,
  viewer: PlayerId,
  opts: LeakCheckOptions = {},
): string[] {
  const json = JSON.stringify(payload) ?? '';
  const leaks: string[] = [];
  const has = (s: string): boolean => json.includes(JSON.stringify(s));

  const visibleCardIds = new Set<string>(state.battlefields.map((b) => b.cardId));
  const hiddenCardIds = new Set<string>();
  for (const obj of Object.values(state.objects)) {
    if (visibleTo(obj, viewer)) {
      visibleCardIds.add(obj.cardId);
    } else {
      hiddenCardIds.add(obj.cardId);
      if (has(obj.id)) leaks.push(`hidden object id "${obj.id}" (${obj.zone.kind}) appears`);
    }
  }
  for (const cardId of hiddenCardIds) {
    if (visibleCardIds.has(cardId)) continue;
    if (has(cardId)) leaks.push(`hidden cardId "${cardId}" appears`);
    const name = opts.cardNames?.[cardId];
    if (name && has(name)) leaks.push(`hidden card name "${name}" appears`);
  }
  if (json.includes(`[${state.rng.s.join(',')}]`)) leaks.push('rng state appears');
  if (state.seed.seed !== '' && has(state.seed.seed)) leaks.push('seed appears');
  for (const key of ['rng', 'nextObjectId', 'nextEventSeq']) {
    if (json.includes(`"${key}":`)) leaks.push(`internal field "${key}" appears`);
  }
  return leaks;
}

/** Throws with a readable message when `payload` leaks anything `viewer` must not see. */
export function assertNoLeaks(
  payload: unknown,
  state: GameState,
  viewer: PlayerId,
  opts: LeakCheckOptions = {},
): void {
  const leaks = findLeaks(payload, state, viewer, opts);
  if (leaks.length > 0) {
    throw new Error(`Information leak to ${viewer}:\n  - ${leaks.join('\n  - ')}`);
  }
}
