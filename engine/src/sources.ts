/**
 * Ability sources (R44). A triggered ability comes from a permanent (an object) or from a Battlefield
 * card, which is a `BattlefieldState` entry and not an object. Code that needs "the source" works with
 * one string id: an object id ('o12') or a battlefield id ('bf0'); the two id spaces never overlap.
 */
import type { CardInstance, ChainItem, GameState } from './types/index.js';

/** The id an ability's effects see as their source: its battlefield for a battlefield card, else its object. */
export const itemSourceId = (item: ChainItem): string =>
  item.sourceBattlefieldId ?? item.sourceObjectId;

/** The battlefield a source is "here" at: its own battlefield for a Battlefield card, else where the object stands. */
export function hereOfSource(state: GameState, sourceId: string): string | null {
  const o: CardInstance | undefined = state.objects[sourceId];
  if (o) return o.zone.kind === 'battlefield' ? o.zone.battlefieldId : null;
  return state.battlefields.some((b) => b.id === sourceId) ? sourceId : null;
}

/** The card id behind a source (an object's card, or a Battlefield card), or undefined. */
export function cardIdOfSource(state: GameState, sourceId: string): string | undefined {
  return (
    state.objects[sourceId]?.cardId ?? state.battlefields.find((b) => b.id === sourceId)?.cardId
  );
}
