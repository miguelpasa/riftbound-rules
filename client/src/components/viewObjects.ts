import type {
  CardDatabase,
  CardDef,
  CardInstance,
  ClientGameState,
  VisibleOrHidden,
} from '@riftbound/engine';

/** The object when the viewer can see it (not a HiddenCard placeholder), else undefined. */
export function visibleObject(view: ClientGameState, id: string): CardInstance | undefined {
  const o: VisibleOrHidden | undefined = view.objects[id];
  return o && 'cardId' in o ? o : undefined;
}

export function defOf(view: ClientGameState, cards: CardDatabase, id: string): CardDef | undefined {
  const o = visibleObject(view, id);
  return o ? cards[o.cardId] : undefined;
}

export function nameOf(view: ClientGameState, cards: CardDatabase, id: string): string {
  return defOf(view, cards, id)?.name ?? 'Unknown card';
}

export function battlefieldName(
  view: ClientGameState,
  cards: CardDatabase,
  battlefieldId: string,
): string {
  const bf = view.battlefields.find((b) => b.id === battlefieldId);
  return (bf && cards[bf.cardId]?.name) || battlefieldId;
}
