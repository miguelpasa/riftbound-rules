/**
 * X-hand: effects that make a player pick cards from a hand.
 *
 *  - HAND_DISCARD: "Each player discards 1" / "They discard 1": each affected player chooses cards from their OWN hand.
 *  - HAND_PICK: "They reveal their hand. Choose a non-unit card from it, and recycle that card": the controller
 *    picks from the revealed hand of the opponent.
 *
 * (This file only starts a choice; handChoice.ts answers it.) A hand that has no more cards than must be chosen is taken whole without asking. Otherwise the resolving effect
 * list pauses on `flow.pendingChoice = {kind: 'HAND_CHOICE'}` (the effects after it are kept in `rest`) and
 * CHOOSE_HAND_CARDS answers it. Nobody else may act meanwhile.
 */
import { playerIndex } from './types/index.js';
import { isGearDef, isUnitDef } from './tokens.js';
import type {
  CardDatabase,
  CardEffect,
  CardInstance,
  GameEventInput,
  GameState,
  HandAction,
  HandChoice,
  HandPickFilter,
  PlayerId,
} from './types/index.js';

function matches(cards: CardDatabase, o: CardInstance, f: HandPickFilter | undefined): boolean {
  if (!f) return true;
  const def = cards[o.cardId];
  if (!def) return false;
  if (f.notUnit && def.type === 'UNIT') return false;
  if (f.domain && !def.domains.some((d) => d.toLowerCase() === f.domain?.toLowerCase()))
    return false;
  return true;
}

/** Move `ids` out of `holder`'s hand: discarded to the Trash, or recycled to the bottom of the Main Deck. */
export function takeFromHand(
  state: GameState,
  cards: CardDatabase,
  holder: PlayerId,
  ids: readonly string[],
  action: 'DISCARD' | 'RECYCLE',
  sourceId: string,
  out: GameEventInput[],
): void {
  if (ids.length === 0) return;
  const ps = state.players[playerIndex(holder)];
  const names = ids.map((id) => cards[state.objects[id]?.cardId ?? '']?.name ?? 'a card');
  for (const id of ids) {
    const o = state.objects[id] as CardInstance;
    ps.hand = ps.hand.filter((x) => x !== id);
    if (action === 'DISCARD') {
      ps.trash.push(id);
      o.zone = { kind: 'trash', player: o.owner };
    } else {
      ps.mainDeck.push(id);
      o.zone = { kind: 'mainDeck', player: o.owner };
    }
  }
  if (action === 'DISCARD') {
    out.push({
      type: 'COST_CARDS_PAID',
      player: holder,
      sourceId,
      kind: 'DISCARD',
      cardIds: [...ids],
      cardNames: names,
    });
  } else {
    out.push({ type: 'CARDS_RECYCLED', player: holder, count: ids.length });
  }
}

/** Takes the chosen cards out of play for `holder`: discard / recycle from the hand, or kill / return from the board. */
export type TakeFn = (
  state: GameState,
  cards: CardDatabase,
  holder: PlayerId,
  ids: readonly string[],
  action: HandAction,
  sourceId: string,
  out: GameEventInput[],
) => void;

export interface HandChoiceRequest {
  /** 'BOARD': the options are the holder's units / gear in play ("Each player kills one of their units"). */
  board?: 'unit' | 'gear';
  /** "may": the chooser may also choose nothing. */
  optional?: boolean;
  take: TakeFn;
  /** Players who discard from their own hand, in order (self discards), or the opponent whose hand is picked from. */
  mode: 'SELF' | 'PICK';
  players: PlayerId[];
  count: number;
  action: HandAction;
  filter?: HandPickFilter;
  controller: PlayerId;
  sourceObjectId: string;
  sourceCardId: string;
  rest: CardEffect[];
}

/**
 * Start (or finish at once) a hand choice. Returns true when the effect list must stop here because a choice is
 * pending; false when everything was decided without asking (the caller carries on). MUTATES `state`.
 */
export function startHandChoice(
  state: GameState,
  cards: CardDatabase,
  req: HandChoiceRequest,
  out: GameEventInput[],
): boolean {
  const queue = [...req.players];
  while (queue.length > 0) {
    const holder = queue.shift() as PlayerId;
    const chooser = req.mode === 'SELF' ? holder : req.controller;
    const options = req.board
      ? Object.values(state.objects)
          .filter((o) => {
            if (o.controller !== holder) return false;
            if (o.zone.kind !== 'base' && o.zone.kind !== 'battlefield') return false;
            const def = cards[o.cardId];
            return req.board === 'unit' ? isUnitDef(def) : isGearDef(def);
          })
          .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
      : state.players[playerIndex(holder)].hand
          .map((id) => state.objects[id] as CardInstance)
          .filter((o) => matches(cards, o, req.filter));
    if (options.length === 0) continue;
    if (options.length <= req.count && req.optional !== true) {
      req.take(
        state,
        cards,
        holder,
        options.map((o) => o.id),
        req.action,
        req.sourceObjectId,
        out,
      );
      continue;
    }
    const choice: HandChoice = {
      kind: 'HAND_CHOICE',
      player: chooser,
      handOf: holder,
      count: req.count,
      options: options.map((o) => ({ id: o.id, cardId: o.cardId })),
      action: req.action,
      reveal: req.mode === 'PICK',
      later: queue,
      controller: req.controller,
      sourceObjectId: req.sourceObjectId,
      sourceCardId: req.sourceCardId,
      mode: req.mode,
      rest: req.rest,
      ...(req.board ? { board: req.board } : {}),
      ...(req.optional ? { optional: true } : {}),
      ...(req.filter ? { filter: req.filter } : {}),
    };
    state.flow.pendingChoice = choice;
    return true;
  }
  return false;
}
