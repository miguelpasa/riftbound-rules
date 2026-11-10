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
export function hereOfSource(
  state: Pick<GameState, 'objects' | 'battlefields'>,
  sourceId: string,
): string | null {
  const o: CardInstance | undefined = state.objects[sourceId];
  const ghost = (state as Pick<GameState, 'lki'>).lki?.[sourceId];
  if (o && o.zone.kind === 'battlefield') return o.zone.battlefieldId;
  // A Deathknell source sits in the Trash: "here" is where it died (last known information).
  if (o && o.zone.kind !== 'base' && ghost) return ghost.at;
  if (o) return null;
  if (ghost) return ghost.at;
  return state.battlefields.some((b) => b.id === sourceId) ? sourceId : null;
}

/** The card id behind a source (an object's card, or a Battlefield card), or undefined. */
export function cardIdOfSource(state: GameState, sourceId: string): string | undefined {
  return (
    state.objects[sourceId]?.cardId ?? state.battlefields.find((b) => b.id === sourceId)?.cardId
  );
}
